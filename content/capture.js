// Per-tab sensor (spec §2). Measures active time, scroll depth, and extracts
// main-content text. Everything stays local; excluded pages send nothing at
// all. Runs at document_idle with lib/privacy.js and lib/text.js loaded first.
(function() {
  'use strict';
  if (window.top !== window) return; // all_frames: false, defensive double-check

  const ACTIVE_INPUT_WINDOW_MS = 60 * 1000;
  const ACTIVE_CAP_MS = 30 * 60 * 1000;
  const SEND_INTERVAL_MS = 15 * 1000;
  const MAX_TEXT_CHARS = 8000;
  const MAX_WALK_NODES = 20000;
  const LATE_RENDER_RECHECK_MS = 10 * 1000;
  const MIN_INITIAL_TEXT = 200;

  let settings = { paused: false, denylist: null, llmChatDomains: null };
  let capture = null;
  let lastInputAt = 0;
  let textSent = false;
  let reExtracted = false;
  let tickTimer = null;
  let lastSentAt = 0;
  let lastHref = location.href;

  // ---- text extraction (§2.6) -----------------------------------------

  const SKIP_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

  function findRoot() {
    return document.querySelector('main') ||
      document.querySelector('article') ||
      document.querySelector('[role=main]') ||
      document.querySelector('#content') ||
      document.body;
  }

  function extractText() {
    const started = performance.now();
    if (document.contentType !== 'text/html' || !document.body) {
      return { text: '', textLength: 0, extractionMs: 0 };
    }
    const root = findRoot();
    if (!root) return { text: '', textLength: 0, extractionMs: 0 };

    // getComputedStyle is expensive; check display:none only for the largest
    // candidate blocks instead of every node (spec cost bound).
    const hiddenChecked = new Map();
    let styleChecks = 0;
    const isHiddenBlock = element => {
      if (hiddenChecked.has(element)) return hiddenChecked.get(element);
      let hidden = false;
      if (styleChecks < 200) {
        styleChecks++;
        hidden = getComputedStyle(element).display === 'none';
      }
      hiddenChecked.set(element, hidden);
      return hidden;
    };

    const parts = [];
    let total = 0;
    let visited = 0;
    const walk = node => {
      if (total >= MAX_TEXT_CHARS * 2 || visited >= MAX_WALK_NODES) return;
      visited++;
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (value) {
          parts.push(value);
          total += value.length + 1;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node;
      if (SKIP_TAGS.has(element.tagName)) return;
      if (element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('hidden')) return;
      // Never read editable or form content — form contents are not content.
      if (element.isContentEditable) return;
      if (element.childElementCount > 3 && element.textContent.length > 400 && isHiddenBlock(element)) return;
      for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
    };
    walk(root);
    const joined = parts.join('\n');
    return {
      text: joined.slice(0, MAX_TEXT_CHARS),
      textLength: joined.length,
      extractionMs: performance.now() - started
    };
  }

  // ---- capture lifecycle ----------------------------------------------

  function newCapture(isSpaNavigation) {
    const url = location.href;
    const extraction = extractText();
    textSent = false;
    reExtracted = false;
    return {
      captureId: CTText.uuid(),
      url,
      normalizedUrl: CTText.normalizeUrl(url),
      title: CTText.cleanTitle(document.title, url),
      domain: CTPrivacy.hostnameOf(url),
      source: CTPrivacy.sourceForUrl(url, settings.llmChatDomains),
      startedAt: Date.now(),
      endedAt: null,
      activeMs: 0,
      maxScrollDepth: currentScrollDepth(),
      textHash: CTText.hashString(extraction.text),
      extractedText: extraction.text,
      textLength: extraction.textLength,
      extractionMs: Math.round(extraction.extractionMs * 100) / 100,
      lang: document.documentElement.lang || null,
      isSpaNavigation: !!isSpaNavigation
    };
  }

  function currentScrollDepth() {
    const el = document.scrollingElement || document.documentElement;
    if (!el || !el.scrollHeight) return 0;
    const depth = (el.scrollTop + window.innerHeight) / el.scrollHeight;
    return Math.max(0, Math.min(1, depth));
  }

  function reExtractIfThin() {
    if (reExtracted || !capture || capture.textLength >= MIN_INITIAL_TEXT) return;
    if (Date.now() - capture.startedAt < LATE_RENDER_RECHECK_MS) return;
    reExtracted = true;
    const extraction = extractText();
    if (extraction.textLength > capture.textLength) {
      capture.extractedText = extraction.text;
      capture.textHash = CTText.hashString(extraction.text);
      capture.textLength = extraction.textLength;
      capture.title = CTText.cleanTitle(document.title, capture.url);
      textSent = false; // resend the improved text once
    }
  }

  function send(final) {
    if (!capture) return;
    if (final) capture.endedAt = Date.now();
    const payload = { ...capture };
    if (textSent) {
      // extractedText travels once (§2.4); later messages carry only the hash.
      delete payload.extractedText;
    }
    const message = { type: 'CAPTURE_UPDATE', capture: payload, final: !!final };
    // `textSent` is only set when the worker confirms the text reached
    // IndexedDB. A bare delivery acknowledgement is not enough: the service
    // worker can be torn down between receiving the message and writing it,
    // and the text is the one field that is never resent on its own schedule.
    const onReply = reply => {
      if (chrome.runtime.lastError) return false;
      if (reply && reply.textStored) textSent = true;
      return true;
    };
    const trySend = (retriesLeft) => {
      try {
        chrome.runtime.sendMessage(message, reply => {
          if (!onReply(reply) && retriesLeft > 0) {
            setTimeout(() => trySend(retriesLeft - 1), 5000);
          }
        });
      } catch {
        if (retriesLeft > 0) setTimeout(() => trySend(retriesLeft - 1), 5000);
      }
    };
    trySend(1);
    lastSentAt = Date.now();
  }

  function finalizeAndRestart(isSpaNavigation) {
    send(true);
    capture = newCapture(isSpaNavigation);
    send(false); // the successor announces itself right away (carries its text)
  }

  // ---- active-time tick (§2.3) ----------------------------------------

  function tick() {
    if (!capture) return;
    // SPA navigation detection: URL changed without a full page load.
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (CTText.normalizeUrl(location.href) !== capture.normalizedUrl) {
        finalizeAndRestart(true);
        return;
      }
      capture.url = location.href;
    }
    const active =
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      (Date.now() - lastInputAt) <= ACTIVE_INPUT_WINDOW_MS;
    if (active && capture.activeMs < ACTIVE_CAP_MS) {
      capture.activeMs = Math.min(capture.activeMs + 1000, ACTIVE_CAP_MS);
    }
    const depth = currentScrollDepth();
    if (depth > capture.maxScrollDepth) capture.maxScrollDepth = depth;
    reExtractIfThin();
    // Cadence gate is visibility, not activity: a visible-but-idle page still
    // reports its scroll depth, and a hidden tab stays silent (its timers are
    // throttled anyway).
    if (document.visibilityState === 'visible' && Date.now() - lastSentAt >= SEND_INTERVAL_MS) send(false);
  }

  // ---- bootstrap -------------------------------------------------------

  function start() {
    if (settings.paused) return;
    if (CTPrivacy.isExcluded(location.href, settings.denylist)) return;
    if (CTPrivacy.isFilteredDomain(location.href)) return;

    capture = newCapture(false);
    lastInputAt = Date.now(); // page load counts as engagement start

    const noteInput = () => {
      lastInputAt = Date.now();
      if (capture) {
        const depth = currentScrollDepth();
        if (depth > capture.maxScrollDepth) capture.maxScrollDepth = depth;
      }
    };
    for (const eventName of ['mousemove', 'keydown', 'scroll', 'wheel', 'touchstart', 'pointerdown']) {
      window.addEventListener(eventName, noteInput, { passive: true, capture: true });
    }
    tickTimer = setInterval(tick, 1000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') send(false);
    });
    window.addEventListener('pagehide', () => {
      send(true);
      if (tickTimer) clearInterval(tickTimer);
    });
    // First message carries the text right away.
    send(false);
  }

  chrome.storage.local.get(['ctPaused', 'ctDenylist', 'ctLlmChatDomains'], stored => {
    settings.paused = !!(stored && stored.ctPaused);
    settings.denylist = stored && Array.isArray(stored.ctDenylist) && stored.ctDenylist.length ? stored.ctDenylist : null;
    settings.llmChatDomains = stored && Array.isArray(stored.ctLlmChatDomains) && stored.ctLlmChatDomains.length ? stored.ctLlmChatDomains : null;
    start();
  });
})();
