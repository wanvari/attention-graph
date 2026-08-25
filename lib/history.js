// History expansion, sessions, dwell (spec §4.1). Carried from v3 with the
// v4 additions: redirect collapse, pause-interval exclusion, capture-based
// dwell upgrade (active time can only LOWER gap dwell, never raise it).
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'), require('./privacy.js'));
  } else {
    root.CTHistory = factory(root.CTText, root.CTPrivacy);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText, CTPrivacy) {
  'use strict';

  const DEFAULTS = {
    sessionBreakMs: 30 * 60 * 1000,
    dwellCapMs: 30 * 60 * 1000,
    sessionEndDwellMs: 60 * 1000,
    redirectCollapseMs: 2000,
    captureMatchWindowMs: 90 * 1000,
    visitExpandConcurrency: 8,
    maxResults: 5000
  };

  const REDIRECT_TRANSITIONS = new Set(['auto_toplevel', 'auto_subframe', 'manual_subframe']);

  // Expand history items to visit events via an injectable provider:
  // { search(query) -> historyItems, getVisits(url) -> visits }.
  async function expandVisits(provider, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const items = await provider.search({
      text: '',
      startTime: cfg.since,
      maxResults: cfg.maxResults
    });
    const usable = (items || []).filter(item =>
      item && item.url &&
      !CTPrivacy.isFilteredDomain(item.url) &&
      !CTPrivacy.isExcluded(item.url, cfg.denylist)
    );
    const visitMap = {};
    let cursor = 0;
    const worker = async () => {
      while (cursor < usable.length) {
        const item = usable[cursor++];
        const visits = await provider.getVisits(item.url);
        visitMap[item.url] = (visits || []).filter(v => Number(v.visitTime) >= cfg.since);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(cfg.visitExpandConcurrency, usable.length || 1)) }, worker)
    );
    return { historyItems: usable, visitMap };
  }

  // §4.1 redirect collapse: two consecutive events < 2 s apart where the
  // second is an auto transition or same-domain -> keep only the second.
  function collapseRedirects(events, cfg) {
    const out = [];
    for (const event of events) {
      const prev = out[out.length - 1];
      if (
        prev &&
        event.visitTime - prev.visitTime < cfg.redirectCollapseMs &&
        (REDIRECT_TRANSITIONS.has(event.transition) || event.domain === prev.domain)
      ) {
        out[out.length - 1] = event; // the later URL wins; nothing is summed
        continue;
      }
      out.push(event);
    }
    return out;
  }

  // Build ordered visit events with sessions and dwell. Options may carry
  // pauseIntervals, denylist, and a captures list for the dwell upgrade.
  function buildVisitEvents(historyItems, visitMap, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    let events = [];
    for (const item of historyItems || []) {
      if (!item || !item.url) continue;
      if (CTPrivacy.isFilteredDomain(item.url)) continue;
      if (CTPrivacy.isExcluded(item.url, cfg.denylist)) continue;
      const domain = CTText.extractDomain(item.url);
      const visits = visitMap && Array.isArray(visitMap[item.url]) && visitMap[item.url].length
        ? visitMap[item.url]
        : [{ visitId: `last-${CTText.hashString(item.url)}`, visitTime: item.lastVisitTime, transition: 'generated' }];
      for (const visit of visits) {
        const time = Number(visit.visitTime);
        if (!time) continue;
        if (CTPrivacy.inPauseInterval(time, cfg.pauseIntervals)) continue;
        events.push({
          visitId: String(visit.visitId || `${CTText.hashString(item.url)}-${time}`),
          url: item.url,
          normalizedUrl: CTText.normalizeUrl(item.url),
          title: CTText.cleanTitle(item.title, item.url),
          domain,
          visitTime: time,
          transition: visit.transition || 'unknown',
          dayKey: CTText.dayKeyFromMs(time),
          // Pages with no real title AND no capture text become
          // uncategorized 'no_content' downstream (§4.1).
          hadTitle: Boolean(String(item.title || '').trim()) && String(item.title).trim() !== String(item.url)
        });
      }
    }
    events.sort((a, b) => a.visitTime - b.visitTime || a.url.localeCompare(b.url));
    events = collapseRedirects(events, cfg);

    // Index captures by normalizedUrl for the dwell upgrade.
    const capturesByUrl = new Map();
    for (const capture of cfg.captures || []) {
      if (!capturesByUrl.has(capture.normalizedUrl)) capturesByUrl.set(capture.normalizedUrl, []);
      capturesByUrl.get(capture.normalizedUrl).push(capture);
    }

    let sessionId = 0;
    for (let i = 0; i < events.length; i++) {
      const current = events[i];
      const next = events[i + 1];
      current.sessionId = sessionId;
      if (!next) {
        current.dwellMs = cfg.sessionEndDwellMs;
        current.endsSession = true;
      } else {
        const gap = Math.max(0, next.visitTime - current.visitTime);
        current.endsSession = gap > cfg.sessionBreakMs;
        // A session-crossing gap measures time away from the browser, not
        // attention on this page: the last page of a session gets a small
        // fixed allowance instead of up to 30 phantom minutes.
        current.dwellMs = current.endsSession
          ? Math.min(gap, cfg.sessionEndDwellMs)
          : Math.min(gap, cfg.dwellCapMs);
        if (current.endsSession) sessionId++;
      }

      // Dwell upgrade: measured active time is a lower bound by construction;
      // min() can only remove phantom dwell, never add attention.
      const candidates = capturesByUrl.get(current.normalizedUrl);
      if (candidates) {
        const match = candidates.find(c =>
          Math.abs(Number(c.startedAt) - current.visitTime) <= cfg.captureMatchWindowMs
        );
        if (match && Number.isFinite(Number(match.activeMs))) {
          current.dwellMs = Math.min(Number(match.activeMs), current.dwellMs);
          current.source = match.source || current.source;
          current.captureId = match.captureId;
        }
      }
      if (!current.source) current.source = CTPrivacy.sourceForUrl(current.url, cfg.llmChatDomains);
    }
    return events;
  }

  return { DEFAULTS, buildVisitEvents, collapseRedirects, expandVisits };
});
