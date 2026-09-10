// Read-only browsing record model. Topics are suggested labels; episodes are
// dated groups of observed visits, never inferred intentions or cognition.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports
    ? factory(require('./text.js'), require('./relevance.js')) : factory(root.CTText, root.CTRelevance);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTTrails = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText, CTRelevance) {
  'use strict';
  const TABLES = ['visits', 'captures', 'pages', 'topics', 'memberships', 'corrections', 'runs', 'settings', 'intent_sessions'];
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
    return !!capture.endedAt || span >= 2000 || positive(capture.activeMs) > 0;
  }

  function buildRecord(snapshot, options) {
    const data = snapshot || {};
    const now = options && options.now || Date.now();
    const custom = metadata(data.corrections);
    const pageByUrl = new Map((data.pages || []).map(p => [p.normalizedUrl, p]));
    const topicById = new Map((data.topics || []).map(t => [t.topicId, t]));
    const topicsByUrl = new Map();
    const overrides = membershipOverrides(data.corrections);
    const ownership = new Map();
    for (const member of data.memberships || []) {
      if (!topicById.has(member.topicId) || topicById.get(member.topicId).state === 'retired') continue;
      const list = ownership.get(member.normalizedUrl) || [];
      list.push(member); ownership.set(member.normalizedUrl, list);
    }
    // Conflicting legacy owners are uncertainty, never two copies of time.
    for (const [url, members] of ownership) {
      if (members.length === 1) topicsByUrl.set(url, new Set([members[0].topicId]));
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
        dwellMs: Math.min(positive(visit.gapDwellMs ?? visit.dwellMs), 30 * 60000, now - time),
        transition: visit.transition || 'unknown', timingMethod: 'history-gap-estimate',
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
      const span = Math.max(0, Math.min(now, positive(capture.endedAt || capture.updatedAt) || time + positive(capture.activeMs)) - time);
      const measuredMs = Math.min(positive(capture.activeMs), span, 30 * 60000);
      const intervals = Array.isArray(capture.activityIntervals)
        ? cleanIntervals(capture.activityIntervals, time, Math.min(now, positive(capture.endedAt || capture.updatedAt) || time)) : null;
      if (candidates.length) {
        const event = candidates[0];
        matchedVisits.add(event.id);
        event.captureId = captureId;
        event.measured = measured;
        // Match the history contract: measured interaction can only lower
        // a gap estimate. An initial zero before measurement lowers nothing.
        if (measured) event.dwellMs = Math.min(event.dwellMs, measuredMs);
        event.intervals = intervals;
        event.timingMethod = intervals ? 'observed-intervals' : measured ? 'interaction-total-estimate' : 'history-gap-estimate';
      } else {
        const page = pageByUrl.get(normalizedUrl) || {};
        events.push({
          id: `capture:${captureId}`, captureId, url, normalizedUrl,
          title: String(capture.title || page.title || CTText.cleanTitle('', url)),
          domain: CTText.extractDomain(url), time, day: CTText.dayKeyFromMs(time),
          dwellMs: measuredMs, measured, intervals, timingMethod: intervals ? 'observed-intervals' : measured ? 'interaction-total-estimate' : 'unknown', pending: true, transition: 'capture', source: capture.source || 'browser'
        });
      }
    }
    events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const settings = Array.isArray(data.settings)
      ? Object.fromEntries(data.settings.map(row => [row.key, row.value])) : data.settings || {};
    for (const event of events) {
      if (!event.measured && CTRelevance.isOperationalPage(event)) {
        event.dwellMs = 0; event.intervals = []; event.timingMethod = 'operational-duration-unknown';
      }
      event.intervals = cleanIntervals(event.intervals || [[event.time, event.time + event.dwellMs]], 0, now);
      event.intervals = subtractPauses(event.intervals, settings.pauseIntervals || [], now);
    }
    // Allocate once over the whole record; a per-trail union would double-count
    // overlapping tabs belonging to different trails.
    const slices = attributeTimelineMinutes(events, { to: now });
    for (const event of events) { event.intervals = []; event.dwellMs = 0; }
    for (const slice of slices) {
      slice.event.intervals.push([slice.start, slice.end]);
      slice.event.dwellMs += slice.end - slice.start;
    }
    const pageEvidence = new Map();
    for (const event of events) {
      const stats = pageEvidence.get(event.normalizedUrl) || { visitCount: 0, dwellMs: 0, activeMs: 0, url: event.url, title: event.title };
      stats.visitCount++; stats.dwellMs += intervalMs(event.intervals);
      if (event.measured) stats.activeMs += intervalMs(event.intervals);
      pageEvidence.set(event.normalizedUrl, stats);
    }
    for (const event of events) {
      const override = overrides.get(event.normalizedUrl);
      const evidence = pageEvidence.get(event.normalizedUrl);
      const utility = CTRelevance.classify(evidence);
      const blocked = utility || !CTRelevance.hasGroupingEvidence(evidence);
      const ids = override ? (override.topicId && topicById.has(override.topicId) ? [override.topicId] : [])
        : blocked ? [] : Array.from(topicsByUrl.get(event.normalizedUrl) || []);
      event.topicIds = ids;
      event.groupingReason = override ? 'your-choice' : blocked ? utility ? 'utility_page' : CTRelevance.isOperationalPage(evidence) ? 'operational-page' : 'limited-evidence' : ids.length ? 'suggested' : ownership.get(event.normalizedUrl)?.length > 1 ? 'conflicting-owners' : 'ungrouped';
    }
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
    const availableTrails = [...topicById.values()].map(t => ({ id: t.topicId, label: custom.get(t.topicId)?.name || t.label || 'Untitled trail', state: t.state })).sort((a, b) => a.label.localeCompare(b.label));
    return { now, events, trails, availableTrails, custom, settings, runs, sessions: data.intent_sessions || [], overrides, ...summarize(events) };
  }

  // Union the visit intervals: tab overlaps must not inflate the total.
  // This is an estimate tied to recorded visits, never a measure of thought.
  function intervalMs(intervals) { return intervals.reduce((n, [a, b]) => n + b - a, 0); }
  function cleanIntervals(intervals, from = 0, to = Infinity) {
    const out = [];
    for (const pair of intervals.filter(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
      .map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
      const last = out[out.length - 1];
      if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]);
      else out.push(pair);
    }
    return out;
  }
  function subtractPauses(intervals, pauses, now) {
    let result = intervals;
    for (const pause of pauses) {
      const lo = Number(pause.start), hi = Number(pause.end ?? now);
      result = result.flatMap(([a, b]) => b <= lo || a >= hi ? [[a, b]] : [[a, Math.min(b, lo)], [Math.max(a, hi), b]].filter(([s, e]) => e > s));
    }
    return result;
  }
  function membershipOverrides(rows) {
    const result = new Map();
    for (const row of rows || []) if (row.kind === 'page_membership' && row.targetId && row.value) {
      const prior = result.get(row.targetId);
      if (!prior || (row.updatedAt || 0) >= prior.updatedAt) result.set(row.targetId, { topicId: row.value.topicId || null, updatedAt: row.updatedAt || 0 });
    }
    return result;
  }
  // Sweep with a lazy max heap. O(intervals log intervals), independent of how
  // many topics exist. Timestamped observations precede legacy interaction
  // totals, then history estimates; ties use recency and a stable event id.
  function attributeTimelineMinutes(events, bounds = {}) {
    const points = [], heap = [], live = new Set(), out = [];
    let sequence = 0;
    const quality = event => event.timingMethod === 'observed-intervals' ? 2 : event.measured ? 1 : 0;
    const higher = (a, b) => quality(a.event) !== quality(b.event) ? quality(a.event) > quality(b.event)
      : a.event.time > b.event.time || a.event.time === b.event.time && String(a.event.id).localeCompare(String(b.event.id)) > 0;
    const push = x => { let i = heap.push(x) - 1; while (i) { const p = (i - 1) >> 1; if (!higher(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
    const pop = () => { const end = heap.pop(); if (!heap.length) return; heap[0] = end; let i = 0; for (;;) { let j = 2 * i + 1; if (j >= heap.length) break; if (j + 1 < heap.length && higher(heap[j + 1], heap[j])) j++; if (!higher(heap[j], heap[i])) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; } };
    for (const event of events) for (const [start, end] of cleanIntervals(event.intervals || [[event.time, event.time + positive(event.dwellMs)]], bounds.from ?? 0, bounds.to ?? Infinity)) {
      const token = { key: sequence++, event };
      points.push({ at: start, start: token }, { at: end, end: token });
    }
    points.sort((a, b) => a.at - b.at);
    let i = 0;
    while (i < points.length) {
      const at = points[i].at;
      while (i < points.length && points[i].at === at) {
        const p = points[i++];
        if (p.end) live.delete(p.end.key); else { live.add(p.start.key); push(p.start); }
      }
      while (heap.length && !live.has(heap[0].key)) pop();
      const end = points[i]?.at;
      if (heap.length && end > at) out.push({ start: at, end, event: heap[0].event });
    }
    return out;
  }
  function estimateMs(events, bounds) {
    return attributeTimelineMinutes(events, bounds).reduce((n, s) => n + s.end - s.start, 0);
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

  return { TABLES, MATCH_MS, EPISODE_GAP_MS, safeUrl, loadData, metadata, makeCorrection, buildRecord, episodes, summarize, search, estimateMs, cleanIntervals, intervalMs, membershipOverrides, attributeTimelineMinutes };
});
