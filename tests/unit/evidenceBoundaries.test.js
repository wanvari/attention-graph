'use strict';
const assert = require('node:assert/strict');
const T = require('../../lib/trails'), D = require('../../lib/dashboard'), MapData = require('../../ui/mapData');
const now = new Date(2026, 8, 10, 15).getTime(), base = now - 60 * 60000;
const a = 'https://example.test/observed', b = 'https://example.test/estimated';
const topics = [{ topicId: 'a', label: 'A' }, { topicId: 'b', label: 'B' }];
const corrections = [a, b].map((url, i) => ({ kind: 'page_membership', targetId: url, value: { topicId: topics[i].topicId } }));

(async () => {
  // A background navigation's guessed gap cannot displace timestamped,
  // visible/focused activity on another tab, even if it started more recently.
  const mixed = T.buildRecord({ topics, corrections,
    captures: [{ captureId: 'active-tab', url: a, startedAt: base, endedAt: base + 300000,
      activeMs: 300000, activityIntervals: [[base, base + 300000]] }],
    visits: [{ visitId: 'background', url: b, visitTime: base + 60000, dwellMs: 300000 }]
  }, { now });
  const daily = D.buildDailySignals(mixed);
  assert.equal(daily.measuredMs, 300000, 'retain all supported interaction when estimates overlap');
  assert.equal(daily.totalMs, 360000, 'the estimate only fills the unsupported remainder');
  assert.equal(daily.byTopic.get('a'), 300000);
  assert.equal(D.buildSessionRecap(mixed, { startedAt: base, endedAt: base + 360000, topicId: 'a' }).targetMs, 300000);

  const visits = [0, 1, 2, 3].map((n) => ({ visitId: `v${n}`, url: n % 2 ? b : a, visitTime: base + n * 60000, dwellMs: 60000 }));
  const snapshot = { topics, corrections, visits, settings: [{ key: 'pauseIntervals', value: [{ start: base + 30000, end: base + 45000 }] }] };
  const paused = T.buildRecord(snapshot, { now }), signals = D.buildDailySignals(paused);
  assert.equal(signals.flow.eligible, 2, 'a pause breaks the sequence even when it is shorter than 30 minutes');
  assert.equal(signals.flow.pairs.length, 2);
  assert.equal(signals.continuity.eligible, false, 'a pause cannot manufacture enough comparison evidence');
  assert.equal(signals.totalMs, 225000, 'the paused interval also contributes no time');
  const map = await MapData.build({ readSnapshot: async () => snapshot }, { now });
  assert.equal(map.transitions.length, 0, 'one sequence on each side of a pause is not a repeated connection');

  const coincident = T.buildRecord({ topics, corrections, visits: visits.map(v => ({ ...v, visitTime: base })) }, { now });
  assert.equal(D.buildDailySignals(coincident).flow.eligible, 0, 'equal timestamps establish no ordering between tabs');
  const tiedMiddle = T.buildRecord({ topics, corrections, visits: [0, 1, 1, 2, 3].map((minute, i) => ({
    visitId: `tie-${i}`, url: i % 2 ? b : a, visitTime: base + minute * 60000, dwellMs: 60000
  })) }, { now });
  assert.equal(D.buildDailySignals(tiedMiddle).flow.eligible, 1, 'neither side of a tied timestamp has an identifiable predecessor/successor');

  // Independent, deterministic sweep oracle: conservation, clipping, and
  // precedence under input permutations. Includes nested and disjoint spans.
  let seed = 0x51ab;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const quality = e => e.timingMethod === 'observed-intervals' ? 2 : e.measured ? 1 : 0;
  for (let trial = 0; trial < 100; trial++) {
    const events = Array.from({ length: 8 }, (_, n) => ({ id: String(n), time: random(15),
      measured: n % 3 !== 0, timingMethod: n % 3 === 2 ? 'observed-intervals' : 'history-gap-estimate',
      intervals: Array.from({ length: 3 }, () => { const start = random(30); return [start, start + random(12)]; }) }));
    const slices = T.attributeTimelineMinutes(events, { from: 3, to: 35 });
    const actual = new Map();
    for (const slice of slices) for (let tick = slice.start; tick < slice.end; tick++) {
      assert.ok(!actual.has(tick), 'overlap is allocated once'); actual.set(tick, slice.event.id);
    }
    const expected = new Map();
    for (let tick = 3; tick < 35; tick++) {
      const covering = events.filter(e => e.intervals.some(([start, end]) => start <= tick && end > tick));
      covering.sort((a, b) => quality(b) - quality(a) || b.time - a.time || b.id.localeCompare(a.id));
      if (covering[0]) expected.set(tick, covering[0].id);
    }
    assert.deepEqual(actual, expected, `bounded allocation agrees with oracle, trial ${trial}`);
    assert.deepEqual(T.attributeTimelineMinutes(events.slice().reverse(), { from: 3, to: 35 }).map(s => [s.start, s.end, s.event.id]), slices.map(s => [s.start, s.end, s.event.id]));
  }
  console.log('evidence precedence, pause boundaries, map/recap consistency and 100 allocation oracle cases passed');
})().catch(error => { console.error(error); process.exit(1); });
