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
  const CHAT_REFRESH_MS = 60 * 1000;
  const MAX_CHAT_REFRESHES = 12;
  const CHAT_REFRESH_WINDOW_MS = 60 * 60 * 1000;

  let settings = { paused: false, denylist: null, llmChatDomains: null };
  let capture = null;
  let lastInputAt = 0;
  let textSent = false;
  let reExtracted = false;
  let tickTimer = null;
  let lastSentAt = 0;
  let lastHref = location.href;
  let lastMeasuredAt = performance.now();
  let wasEligible = false;
  let contentDirty = false;
  let chatRefreshes = 0;
  let lastExtractedAt = 0;
  let chatWindowStartedAt = 0;
  let contentObserver = null;

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
    let tail = '';
    let total = 0;
    let visited = 0;
    const chat = CTPrivacy.sourceForUrl(location.href, settings.llmChatDomains) === 'llm_chat';
    // Iterative traversal avoids stack overflow on deeply nested documents.
    const pending = [root];
    while (pending.length && visited < MAX_WALK_NODES) {
      const node = pending.pop();
      if (!chat && total >= MAX_TEXT_CHARS * 2) break;
      visited++;
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.nodeValue;
        // Bound work even for a page containing one enormous text node.
        const sample = raw.length <= MAX_TEXT_CHARS * 2 ? raw : raw.slice(0, MAX_TEXT_CHARS) + '\n' + raw.slice(-MAX_TEXT_CHARS);
        const value = sample.replace(/\s+/g, ' ').trim();
        if (value) {
          if (total < MAX_TEXT_CHARS) parts.push(value);
          tail = (tail + '\n' + value).slice(-MAX_TEXT_CHARS);
          total += Math.max(value.length, raw.length) + 1;
        }
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node;
      if (SKIP_TAGS.has(element.tagName)) continue;
      if (element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('hidden')) continue;
      // Never read editable or form content — form contents are not content.
      if (element.isContentEditable || element.hasAttribute('contenteditable')) continue;
      if (element.childElementCount > 3 && isHiddenBlock(element)) continue;
      for (let child = node.lastChild; child && pending.length < MAX_WALK_NODES; child = child.previousSibling) pending.push(child);
    }
    const joined = parts.join('\n');
    return {
      text: chat && total > MAX_TEXT_CHARS
        ? joined.slice(0, 2000) + '\n[…]\n' + tail.slice(-(MAX_TEXT_CHARS - 2005))
        : joined.slice(0, MAX_TEXT_CHARS),
      textLength: total,
      extractionMs: performance.now() - started
    };
  }

  // ---- capture lifecycle ----------------------------------------------

  function newCapture(isSpaNavigation) {
    const url = CTText.sanitizeUrl(location.href);
    const extraction = extractText();
    textSent = false;
    reExtracted = false;
    contentDirty = false;
    chatRefreshes = 0;
    lastExtractedAt = Date.now();
    chatWindowStartedAt = Date.now();
    lastMeasuredAt = performance.now();
    wasEligible = false;
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
      activityIntervals: [],
      activityMethod: 'visible-focused-recent-input',
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

  function refreshChat(final) {
    if (Date.now() - chatWindowStartedAt >= CHAT_REFRESH_WINDOW_MS) {
      chatWindowStartedAt = Date.now();
      chatRefreshes = 0;
    }
    if (!capture || capture.source !== 'llm_chat' || !contentDirty || chatRefreshes >= MAX_CHAT_REFRESHES) return;
    if (!final && Date.now() - lastExtractedAt < CHAT_REFRESH_MS) return;
    if (!capturable(location.href) || CTText.normalizeUrl(location.href) !== capture.normalizedUrl) return;
    chatRefreshes++;
    lastExtractedAt = Date.now();
    contentDirty = false;
    const extraction = extractText();
    const hash = CTText.hashString(extraction.text);
    if (hash === capture.textHash) return;
    capture.extractedText = extraction.text;
    capture.textHash = hash;
    capture.textLength = extraction.textLength;
    capture.extractionMs = Math.round(extraction.extractionMs * 100) / 100;
    capture.title = CTText.cleanTitle(document.title, capture.url);
    textSent = false;
  }

  function send(final) {
    if (!capture) return;
    if (final) refreshChat(true);
    if (final) capture.endedAt = Date.now();
    // How far this capture has actually watched. The dwell downgrade in
    // lib/history.js needs it: activeMs is only evidence about the span the
    // capture observed, and without this a capture that had been alive for
    // three seconds looked like a measurement over the whole visit.
    capture.updatedAt = Date.now();
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
      // A delayed acknowledgement belongs to its capture AND text revision.
      // An old SPA/page update must not suppress the successor's text.
      if (reply && reply.textStored && capture?.captureId === payload.captureId && capture.textHash === payload.textHash) textSent = true;
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
    measureActiveTime(true);
    send(true);
    // The destination gets the same scrutiny a fresh page load would get: an
    // SPA can route from an allowed view straight to /login or /payment.
    if (!capturable(location.href)) {
      capture = null;
      return;
    }
    capture = newCapture(isSpaNavigation);
    observeContent();
    send(false); // the successor announces itself right away (carries its text)
  }

  function capturable(url) {
    return !settings.paused &&
      !CTPrivacy.isExcluded(url, settings.denylist) &&
      !CTPrivacy.isFilteredDomain(url);
  }

  // Pause and denylist edits must reach tabs that are already open, in both
  // directions: stop an in-flight capture, and let a tab that loaded while
  // paused start once capture resumes.
  function applySettingsChange() {
    if (capture && (!capturable(capture.url) || !capturable(location.href))) {
      measureActiveTime(true);
      send(true);
      capture = null;
      contentObserver?.disconnect();
      return;
    }
    if (!capture && capturable(location.href)) {
      capture = newCapture(false);
      observeContent();
      send(false);
    }
  }

  // ---- active-time tick (§2.3) ----------------------------------------

  function measureActiveTime(ending) {
    const clock = performance.now();
    const now = Date.now();
    const elapsed = Math.max(0, Math.min(clock - lastMeasuredAt, 2000));
    const visibleFocused = document.visibilityState === 'visible' && document.hasFocus();
    const eligible = visibleFocused && lastInputAt > 0 && now - lastInputAt <= ACTIVE_INPUT_WINDOW_MS;
    if (capture && wasEligible && (visibleFocused || ending)) {
      // Count elapsed observed time, bounded across throttling/sleep; a timer
      // firing is not evidence that a whole away-gap was active.
      const measured = Math.min(elapsed, Math.max(0, lastInputAt + ACTIVE_INPUT_WINDOW_MS - (now - elapsed)));
      if (measured > 0) {
        const start = Math.max(capture.startedAt, now - elapsed), end = start + measured;
        const last = capture.activityIntervals[capture.activityIntervals.length - 1];
        if (last && start <= last[1] + 1) { capture.activeMs += Math.max(0, end - last[1]); last[1] = Math.max(last[1], end); }
        else if (capture.activityIntervals.length < 2048) { capture.activityIntervals.push([start, end]); capture.activeMs += end - start; }
        else capture.timingTruncated = true;
      }
    }
    lastMeasuredAt = clock;
    wasEligible = eligible;
  }

  function observeContent() {
    contentObserver?.disconnect();
    if (!capture || capture.source !== 'llm_chat' || !document.body) return;
    // A mutation only marks dirty: streamed tokens never trigger extraction
    // or IPC themselves. At most 12 bounded refreshes occur per hour.
    contentObserver = new MutationObserver(() => { contentDirty = true; });
    contentObserver.observe(findRoot(), { childList: true, characterData: true, subtree: true });
  }

  function tick() {
    // SPA navigation detection: URL changed without a full page load.
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (!capture || CTText.normalizeUrl(location.href) !== capture.normalizedUrl) {
        finalizeAndRestart(true);
        return;
      }
      if (!capturable(location.href)) {
        send(true);
        capture = null;
        return;
      }
      capture.url = CTText.sanitizeUrl(location.href);
    }
    if (!capture) return;
    measureActiveTime(false);
    const depth = currentScrollDepth();
    if (depth > capture.maxScrollDepth) capture.maxScrollDepth = depth;
    reExtractIfThin();
    if (document.visibilityState === 'visible') refreshChat(false);
    // Cadence gate is visibility, not activity: a visible-but-idle page still
    // reports its scroll depth, and a hidden tab stays silent (its timers are
    // throttled anyway).
    if (document.visibilityState === 'visible' && Date.now() - lastSentAt >= SEND_INTERVAL_MS) send(false);
  }

  // ---- bootstrap -------------------------------------------------------

  function start() {
    // The tab listens for setting changes even when it is not capturing, so
    // unpausing reaches tabs that were open at the time.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if ('ctPaused' in changes) settings.paused = !!changes.ctPaused.newValue;
      if ('ctDenylist' in changes) {
        const value = changes.ctDenylist.newValue;
        settings.denylist = Array.isArray(value) && value.length ? value : null;
      }
      if ('ctLlmChatDomains' in changes) {
        const value = changes.ctLlmChatDomains.newValue;
        settings.llmChatDomains = Array.isArray(value) && value.length ? value : null;
      }
      applySettingsChange();
    });

    document.addEventListener('visibilitychange', () => {
      measureActiveTime(true);
      if (document.visibilityState === 'hidden') send(false);
    });
    window.addEventListener('pagehide', () => {
      measureActiveTime(true);
      send(true);
      if (tickTimer) clearInterval(tickTimer);
      contentObserver?.disconnect();
    });
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      capture = null;
      lastInputAt = 0;
      tickTimer = setInterval(tick, 1000);
      applySettingsChange();
    });
    window.addEventListener('blur', () => measureActiveTime(true));
    window.addEventListener('focus', () => measureActiveTime(false));

    const noteInput = event => {
      if (event?.isTrusted === false) return;
      measureActiveTime(false);
      lastInputAt = Date.now();
      wasEligible = document.visibilityState === 'visible' && document.hasFocus();
      if (capture) {
        const depth = currentScrollDepth();
        if (depth > capture.maxScrollDepth) capture.maxScrollDepth = depth;
      }
    };
    for (const eventName of ['mousemove', 'keydown', 'scroll', 'wheel', 'touchstart', 'pointerdown']) {
      window.addEventListener(eventName, noteInput, { passive: true, capture: true });
    }
    tickTimer = setInterval(tick, 1000);

    if (!capturable(location.href)) return;

    capture = newCapture(false);
    observeContent();
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
