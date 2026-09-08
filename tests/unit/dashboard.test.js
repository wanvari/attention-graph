'use strict';
const assert = require('node:assert/strict'), { performance } = require('node:perf_hooks');
const D = require('../../lib/dashboard'), T = require('../../lib/trails');
const at = (day, hour = 12, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const now = at(5, 14), a = 'https://a.example/x', b = 'https://b.example/y', c = 'https://c.example/z';
const data = { visits: [], topics: [{ topicId: 'a', label: 'A' }, { topicId: 'b', label: 'B' }], memberships: [{ topicId: 'a', normalizedUrl: a }, { topicId: 'a', normalizedUrl: b }, { topicId: 'b', normalizedUrl: c }] };
for (let day = -22; day <= 5; day++) for (let n = 0; n < 4; n++) data.visits.push({ visitId: `${day}:${n}`, url: n === 3 ? c : n % 2 ? b : a, normalizedUrl: n === 3 ? c : n % 2 ? b : a, visitTime: at(day, 12, n * 5), dwellMs: 5 * 60000 });
const record = T.buildRecord(data, { now }), signals = D.buildDailySignals(record);
assert.equal(signals.totalMs, 20 * 60000);
assert.equal(signals.continuity.value, 2 / 3);
assert.equal(signals.top.value, 0.75);
assert.equal(signals.return.value, 1);
assert.equal(signals.comparisons.top.n, 27);
assert.equal(signals.comparisons.top.direction, 'within');
assert.equal(signals.coverage.eligibleTransitions, 3);
assert.equal(signals.groupedMs + signals.ungroupedMs, signals.totalMs);
assert.equal(D.median([4, 1, 3, 2]), 2.5);
const days = Array.from({ length: 7 }, (_, i) => ({ top: { eligible: true, value: i + 1 } }));
const range = D.buildComparisonRange(days, 'top', { eligible: true, value: 8 });
assert.deepEqual([range.median, range.q1, range.q3, range.direction], [4, 2, 6, 'above']);
assert.equal(D.buildComparisonRange(days, 'top', { eligible: true, value: 2 }).direction, 'within');
assert.equal(D.buildComparisonRange(days.slice(0, 6), 'top', { eligible: true, value: 1 }).direction, 'insufficient');
assert.equal(D.buildDailySignals(T.buildRecord({}, { now })).top.value, null);
// Time-of-day truncation applies to every comparison, with local calendar
// arithmetic across month boundaries and DST (not subtracting 24h).
const late = { ...data, visits: data.visits.concat({ visitId: 'late', normalizedUrl: a, url: a, visitTime: at(4, 20), dwellMs: 1800000 }) };
assert.equal(D.buildDailySignals(T.buildRecord(late, { now })).comparisons.time.median, 20 * 60000);
const start = at(5, 23, 50), end = at(6, 0, 10);
const cross = T.buildRecord({ captures: [{ captureId: 'cross', url: a, startedAt: start, endedAt: end, activeMs: 1200000, activityIntervals: [[start, end]] }], topics: data.topics,
  corrections: [{ kind: 'page_membership', targetId: a, value: { topicId: 'a' } }] }, { now: end });
assert.equal(D.buildDailySignals(cross).totalMs, 10 * 60000);
const recap = D.buildSessionRecap(cross, { topicId: 'a', startedAt: start, endedAt: end, durationMinutes: null });
assert.equal(recap.targetMs, 20 * 60000); assert.equal(recap.otherMs, 0);
const pairs = D.transitions([
  { id: '1', time: at(5), normalizedUrl: a, topicIds: ['a'] },
  { id: '2', time: at(5) + 1000, normalizedUrl: b, topicIds: [] },
  { id: '3', time: at(5) + 2000, normalizedUrl: c, topicIds: ['b'] },
  { id: '4', time: at(5) + 3000, normalizedUrl: c, topicIds: ['b'], transition: 'reload' }
], D.localBounds(now));
assert.equal(pairs.pairs.length, 0); assert.equal(pairs.uncovered, 2, 'ungrouped endpoints do not become artificial same-trail transitions');
for (const [zone, date] of [['America/Los_Angeles', '2026-03-09T12:00:00'], ['America/Los_Angeles', '2026-11-02T12:00:00']]) {
  const old = process.env.TZ; process.env.TZ = zone;
  const bounds = D.localBounds(new Date(date).getTime(), -1);
  assert.equal(new Date(bounds.to).getHours(), 12); assert.equal(new Date(bounds.from).getHours(), 0);
  if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
}
const started = performance.now(); for (let i = 0; i < 3; i++) D.buildDailySignals(record);
assert.ok((performance.now() - started) / 3 < 100, 'daily computation fits the 100ms fixture budget');
console.log('daily signals, comparisons, boundaries and recap tests passed');

// A day consisting solely of unknown status-page gaps is not a zero-minute
// comparison day: it has no usable timing evidence.
{
  const T = require('../../lib/trails'), D = require('../../lib/dashboard');
  const now = new Date(2026, 8, 7, 12).getTime();
  const record = T.buildRecord({ visits: [{ visitId: 'unknown', url: 'https://status.example.test/', title: 'Service status', visitTime: now - 60000, dwellMs: 60000 }] }, { now });
  const signals = D.buildDailySignals(record);
  assert.equal(signals.totalMs, 0); assert.equal(signals.time.eligible, false);
}
