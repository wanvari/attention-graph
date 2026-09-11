// Frozen output oracle from 183ab41 (5.1.1). Do not optimize this reference.
// Literal observations and comparisons. No inference and no composite score.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports ? factory(require('../../../lib/text'), require('./trails-5.1.1')) : factory(root.CTText, root.CTTrails);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTDashboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Text, Trails) {
  'use strict';
  const MINUTE = 60000;
  const median = values => { const a = values.slice().sort((a, b) => a - b), n = a.length; return n ? n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2 : null; };
  function buildComparisonRange(days, metric, current) {
    const values = days.map(d => d[metric]).filter(m => m?.eligible && m.value !== null).map(m => m.value).sort((a, b) => a - b);
    const n = values.length, middle = n >> 1;
    const range = { n, median: median(values), q1: median(values.slice(0, middle)), q3: median(values.slice(n % 2 ? middle + 1 : middle)), direction: 'insufficient' };
    if (n >= 7 && current?.eligible && current.value !== null) range.direction = current.value < range.q1 ? 'below' : current.value > range.q3 ? 'above' : 'within';
    return range;
  }
  function localBounds(now, offset = 0) {
    const clock = new Date(now);
    const start = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate() + offset).getTime();
    const end = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate() + offset, clock.getHours(), clock.getMinutes(), clock.getSeconds(), clock.getMilliseconds()).getTime();
    return { from: start, to: end };
  }
  function transitions(events, bounds, pauses = []) {
    const rows = events.filter(e => e.time >= bounds.from && e.time < bounds.to).slice().sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const counts = new Map();
    for (const row of rows) counts.set(row.time, (counts.get(row.time) || 0) + 1);
    const pairs = []; let eligible = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i], gap = b.time - a.time;
      // A stable ID sort is useful for display, but cannot identify which of
      // two simultaneous visits preceded or followed another page.
      if (counts.get(a.time) > 1 || counts.get(b.time) > 1) continue;
      if (gap <= 0 || gap > 30 * MINUTE || Text.dayKeyFromMs(a.time) !== Text.dayKeyFromMs(b.time) || b.transition === 'reload' || a.normalizedUrl === b.normalizedUrl) continue;
      if (pauses.some(p => p.start <= b.time && (p.end ?? Infinity) > a.time)) continue;
      eligible++;
      if (a.topicIds.length !== 1 || b.topicIds.length !== 1) continue;
      pairs.push({ from: a, to: b, same: a.topicIds[0] === b.topicIds[0] });
    }
    return { pairs, eligible, uncovered: eligible - pairs.length };
  }
  function measure(record, bounds) {
    const slices = Trails.attributeTimelineMinutes(record.events, bounds);
    const starts = record.events.filter(e => e.time >= bounds.from && e.time < bounds.to);
    const contributing = new Map(starts.map(e => [e.id, e]));
    const byTopic = new Map(); let totalMs = 0, groupedMs = 0, measuredMs = 0, returnMs = 0;
    const day = Text.dayKeyFromMs(bounds.from), trailById = new Map(record.trails.map(t => [t.id, t]));
    for (const slice of slices) {
      const ms = slice.end - slice.start, id = slice.event.topicIds[0]; totalMs += ms;
      contributing.set(slice.event.id, slice.event);
      if (slice.event.measured) measuredMs += ms;
      if (id) {
        groupedMs += ms; byTopic.set(id, (byTopic.get(id) || 0) + ms);
        if (trailById.get(id) && Text.dayKeyFromMs(trailById.get(id).firstAt) < day) returnMs += ms;
      }
    }
    const ranking = [...byTopic].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const flow = transitions(record.events, bounds, record.settings?.pauseIntervals), same = flow.pairs.filter(p => p.same).length;
    const events = [...contributing.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const ratio = (numerator, denominator, eligible) => ({ numerator, denominator, value: denominator ? numerator / denominator : null, eligible });
    return { day, bounds, events, slices, byTopic, flow,
      totalMs, groupedMs, ungroupedMs: totalMs - groupedMs, measuredMs,
      coverage: { visits: events.length, groupedVisits: events.filter(e => e.topicIds.length).length, measuredVisits: events.filter(e => e.measured).length,
        exactTimingVisits: events.filter(e => e.timingMethod === 'observed-intervals').length, classifiedTransitions: flow.pairs.length, eligibleTransitions: flow.eligible },
      time: { value: totalMs, eligible: totalMs > 0 || events.some(e => e.measured) },
      continuity: ratio(same, flow.pairs.length, flow.pairs.length >= 3),
      top: { ...ratio(ranking[0]?.[1] || 0, groupedMs, groupedMs >= 10 * MINUTE), topicId: ranking[0]?.[0] || null },
      return: ratio(returnMs, groupedMs, groupedMs >= 10 * MINUTE)
    };
  }
  function buildDailySignals(record, options = {}) {
    const now = options.now ?? record.now ?? Date.now();
    const current = measure(record, localBounds(now));
    const days = Array.from({ length: options.lookbackDays ?? 28 }, (_, i) => measure(record, localBounds(now, -i - 1)));
    const comparisons = Object.fromEntries(['time', 'continuity', 'top', 'return'].map(key => [key, buildComparisonRange(days, key, current[key])]));
    const topTrail = record.trails.find(t => t.id === current.top.topicId);
    const returned = [...current.byTopic.keys()].filter(id => Text.dayKeyFromMs(record.trails.find(t => t.id === id).firstAt) < current.day);
    const observation = topTrail ? `${topTrail.label} held the most grouped time${returned.length ? `; ${returned.length} earlier trail${returned.length === 1 ? '' : 's'} returned` : ''}.`
      : current.events.length ? 'Pages are recorded; there is not enough grouped evidence for a trail summary yet.' : 'Your daily signals appear as eligible pages are recorded.';
    return { ...current, comparisons, observation, lookbackDays: days.length };
  }
  function buildSessionRecap(record, session) {
    const end = Math.min(record.now, session.endedAt ?? (session.durationMinutes ? session.startedAt + session.durationMinutes * MINUTE : record.now));
    const detail = measure(record, { from: session.startedAt, to: Math.max(session.startedAt, end) });
    const targetMs = detail.byTopic.get(session.topicId) || 0;
    return { ...detail, session, targetMs, otherMs: detail.groupedMs - targetMs, elapsedMs: Math.max(0, end - session.startedAt) };
  }
  function continuation(record) {
    const active = record.sessions.filter(s => s.status === 'active').sort((a, b) => b.startedAt - a.startedAt)[0];
    const recent = record.trails.slice().sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
    const trail = active ? record.trails.find(t => t.id === active.topicId) : recent.find(t => t.personal.pinned) || recent[0];
    return { session: active || null, trail: trail || null, page: trail?.events.at(-1) || record.events.at(-1) || null };
  }
  return { median, localBounds, transitions, measure, buildComparisonRange, buildDailySignals, buildSessionRecap, continuation,
    attributeTimelineMinutes: Trails.attributeTimelineMinutes };
});
