// Read-only browsing record model. Topics are suggested labels; episodes are
// dated groups of observed visits, never inferred intentions or cognition.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports
    ? factory(require('./text.js')) : factory(root.CTText);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTTrails = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText) {
  'use strict';
  const TABLES = ['visits', 'captures', 'pages', 'topics', 'memberships', 'corrections', 'runs', 'settings'];
  const MATCH_MS = 90000;
  const EPISODE_GAP_MS = 30 * 60000;
  const positive = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      // Records from earlier versions can contain credentials. Never surface
      // them in a navigation link, even before the background repair runs.
      if (url.username || url.password) return null;
      return CTText.sanitizeUrl ? CTText.sanitizeUrl(url.href) : url.href;
    } catch { return null; }
  }

  async function loadData(store) {
    if (typeof store.readSnapshot === 'function') return store.readSnapshot(TABLES);
    const values = await Promise.all(TABLES.map(name => store.getAll(name)));
    return Object.fromEntries(TABLES.map((name, i) => [name, values[i] || []]));
  }

  function metadata(corrections) {
    const result = new Map();
    for (const row of corrections || []) {
      if (row.kind !== 'trail_metadata' || !row.targetId || !row.value) continue;
      const existing = result.get(row.targetId);
      const at = positive(row.updatedAt || row.createdAt);
      if (existing && existing.updatedAt > at) continue;
      result.set(row.targetId, {
        name: String(row.value.name || '').trim().slice(0, 120),
        note: String(row.value.note || '').trim().slice(0, 1000),
        pinned: row.value.pinned === true,
        updatedAt: at
      });
    }
    return result;
  }

  function makeCorrection(topicId, value, now, previous) {
    if (!topicId) throw new Error('A trail is required.');
    return {
      correctionId: `trail:${topicId}`, kind: 'trail_metadata', targetId: topicId,
      value: {
        name: String(value.name || '').trim().slice(0, 120),
        note: String(value.note || '').trim().slice(0, 1000),
        pinned: value.pinned === true
      },
      createdAt: previous && previous.createdAt || now,
      updatedAt: now
    };
  }

  function observedCapture(capture) {
    const span = positive(capture.endedAt || capture.updatedAt) - positive(capture.startedAt);
    return span >= 2000 || positive(capture.activeMs) > 0;
  }

  function buildRecord(snapshot, options) {
    const data = snapshot || {};
    const now = options && options.now || Date.now();
    const custom = metadata(data.corrections);
    const pageByUrl = new Map((data.pages || []).map(p => [p.normalizedUrl, p]));
    const topicById = new Map((data.topics || []).map(t => [t.topicId, t]));
    const topicsByUrl = new Map();
    for (const member of data.memberships || []) {
      if (!topicById.has(member.topicId)) continue;
      const ids = topicsByUrl.get(member.normalizedUrl) || new Set();
      ids.add(member.topicId);
      topicsByUrl.set(member.normalizedUrl, ids);
    }
    const events = [];
    const eventIds = new Set();
    for (const visit of data.visits || []) {
      const time = positive(visit.visitTime);
      const url = safeUrl(visit.url || visit.normalizedUrl);
      if (!time || time > now || !url) continue;
      const id = String(visit.visitId || `${visit.normalizedUrl}:${time}`);
      if (eventIds.has(id)) continue;
      eventIds.add(id);
      const page = pageByUrl.get(visit.normalizedUrl) || {};
      events.push({
        id, url, normalizedUrl: visit.normalizedUrl || CTText.normalizeUrl(url),
        title: String(visit.title || page.title || CTText.cleanTitle('', url)),
        domain: CTText.extractDomain(url), time, day: CTText.dayKeyFromMs(time),
        dwellMs: Math.min(positive(visit.dwellMs), 30 * 60000),
        measured: false, pending: false, captureId: visit.captureId || null,
        source: visit.source || 'browser'
      });
    }
    events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const eventsByUrl = new Map();
    for (const event of events) {
      const list = eventsByUrl.get(event.normalizedUrl) || [];
      list.push(event);
      eventsByUrl.set(event.normalizedUrl, list);
    }
    const matchedVisits = new Set();
    const captureIds = new Set();
    for (const capture of (data.captures || []).slice().sort((a, b) => a.startedAt - b.startedAt)) {
      const time = positive(capture.startedAt);
      const url = safeUrl(capture.url || capture.normalizedUrl);
      const captureId = String(capture.captureId || `${capture.normalizedUrl}:${time}`);
      if (!time || time > now || !url || captureIds.has(captureId)) continue;
      captureIds.add(captureId);
      const normalizedUrl = capture.normalizedUrl || CTText.normalizeUrl(url);
      const candidates = (eventsByUrl.get(normalizedUrl) || [])
        .filter(v => !matchedVisits.has(v.id) && (v.captureId === captureId || Math.abs(v.time - time) <= MATCH_MS))
        .sort((a, b) => Number(b.captureId === captureId) - Number(a.captureId === captureId) || Math.abs(a.time - time) - Math.abs(b.time - time));
      const measured = observedCapture(capture);
      const span = Math.max(0, Math.min(now, positive(capture.endedAt || capture.updatedAt) || time) - time);
      const measuredMs = Math.min(positive(capture.activeMs), span);
      if (candidates.length) {
        const event = candidates[0];
        matchedVisits.add(event.id);
        event.captureId = captureId;
        event.measured = measured;
        // Match the history contract: measured interaction can only lower
        // a gap estimate. An initial zero before measurement lowers nothing.
        if (measured) event.dwellMs = Math.min(event.dwellMs, measuredMs);
      } else {
        const page = pageByUrl.get(normalizedUrl) || {};
        events.push({
          id: `capture:${captureId}`, captureId, url, normalizedUrl,
          title: String(capture.title || page.title || CTText.cleanTitle('', url)),
          domain: CTText.extractDomain(url), time, day: CTText.dayKeyFromMs(time),
          dwellMs: measuredMs, measured, pending: true, source: capture.source || 'browser'
        });
      }
    }
    events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    for (const event of events) event.topicIds = Array.from(topicsByUrl.get(event.normalizedUrl) || []);
    const trails = [];
    for (const topic of topicById.values()) {
      const trailEvents = events.filter(e => e.topicIds.includes(topic.topicId));
      if (!trailEvents.length) continue;
      const personal = custom.get(topic.topicId) || { name: '', note: '', pinned: false };
      trails.push({
        id: topic.topicId, label: personal.name || topic.label || 'Untitled trail',
        suggestedLabel: topic.label || 'Untitled trail', personal,
        events: trailEvents, episodes: episodes(trailEvents),
        ...summarize(trailEvents), firstAt: trailEvents[0].time,
        lastAt: trailEvents[trailEvents.length - 1].time
      });
    }
    trails.sort((a, b) => Number(b.personal.pinned) - Number(a.personal.pinned) || b.lastAt - a.lastAt || a.label.localeCompare(b.label));
    const runs = (data.runs || []).slice().sort((a, b) => positive(b.startedAt) - positive(a.startedAt));
    const settings = Array.isArray(data.settings)
      ? Object.fromEntries(data.settings.map(row => [row.key, row.value])) : data.settings || {};
    return { now, events, trails, custom, settings, runs, ...summarize(events) };
  }

  // Union the visit intervals: tab overlaps must not inflate the total.
  // This is an estimate tied to recorded visits, never a measure of thought.
  function estimateMs(events) {
    let total = 0, start = 0, end = 0;
    for (const event of events.slice().sort((a, b) => a.time - b.time)) {
      if (!event.dwellMs) continue;
      const until = event.time + event.dwellMs;
      if (event.time > end) { total += Math.max(0, end - start); start = event.time; end = until; }
      else end = Math.max(end, until);
    }
    return total + Math.max(0, end - start);
  }

  function summarize(events) {
    const days = new Set(events.map(e => e.day));
    return {
      visitCount: events.length,
      pageCount: new Set(events.map(e => e.normalizedUrl)).size,
      sourceCount: new Set(events.map(e => e.domain)).size,
      dayCount: days.size, returnDays: Math.max(0, days.size - 1),
      categorizedCount: events.filter(e => e.topicIds && e.topicIds.length).length,
      measuredCount: events.filter(e => e.measured).length,
      pendingCount: events.filter(e => e.pending).length,
      estimatedMs: estimateMs(events)
    };
  }

  function episodes(events) {
    const result = [];
    for (const event of events.slice().sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))) {
      let episode = result[result.length - 1];
      if (!episode || event.day !== episode.day || event.time - episode.lastAt > EPISODE_GAP_MS) {
        episode = { id: event.id, day: event.day, firstAt: event.time, lastAt: event.time, events: [] };
        result.push(episode);
      }
      episode.events.push(event);
      episode.lastAt = event.time;
    }
    return result;
  }

  function search(record, options) {
    const opts = options || {};
    const query = String(opts.query || '').trim().toLocaleLowerCase();
    const terms = query.split(/\s+/u).filter(Boolean);
    const labels = new Map(record.trails.map(t => [t.id, `${t.label} ${t.suggestedLabel} ${t.personal.note}`.toLocaleLowerCase()]));
    return record.events.filter(event => {
      if (opts.trailId && !event.topicIds.includes(opts.trailId)) return false;
      if (opts.from && event.day < opts.from) return false;
      if (opts.to && event.day > opts.to) return false;
      if (opts.ungrouped && event.topicIds.length) return false;
      const date = new Date(event.time).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
      const haystack = `${event.title} ${event.domain} ${event.url} ${event.day} ${date} ${event.topicIds.map(id => labels.get(id) || '').join(' ')}`.toLocaleLowerCase();
      return terms.every(term => haystack.includes(term));
    }).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  }

  return { TABLES, MATCH_MS, EPISODE_GAP_MS, safeUrl, loadData, metadata, makeCorrection, buildRecord, episodes, summarize, search, estimateMs };
});
