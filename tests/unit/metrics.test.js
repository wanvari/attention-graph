'use strict';
const assert = require('assert');
const CTMetrics = require('../../lib/metrics.js');
const CTText = require('../../lib/text.js');

const MIN = 60 * 1000;

function visit(url, minuteOfDay, dwellMin, extra) {
  // Anchored to 2026-03-10 local.
  const t = new Date(2026, 2, 10, 0, 0, 0, 0).getTime() + minuteOfDay * MIN;
  return {
    normalizedUrl: url,
    visitTime: t,
    dwellMs: dwellMin * MIN,
    endsSession: false,
    transition: 'link',
    source: 'web',
    ...extra
  };
}

const topicsById = new Map([
  ['tA', { topicId: 'tA', label: 'Topic A', centroid: Float32Array.from([1, 0]) }],
  ['tB', { topicId: 'tB', label: 'Topic B', centroid: Float32Array.from([0, 1]) }],
  ['tC', { topicId: 'tC', label: 'Topic C', centroid: Float32Array.from([0.9, Math.sqrt(1 - 0.81)]) }]
]);

// --- entropy
assert.strictEqual(CTMetrics.entropyBits([1]), 0, 'one topic = 0 bits');
assert.strictEqual(CTMetrics.entropyBits([0.5, 0.5]), 1, 'two equal topics = 1 bit');
assert.strictEqual(CTMetrics.entropyBits([0.25, 0.25, 0.25, 0.25]), 2, 'four equal = 2 bits');
assert.strictEqual(CTMetrics.entropyBits([]), 0);
assert.strictEqual(CTMetrics.entropyBits([1, 0, 0]), 0, 'zero shares ignored');

// --- computeDayMetrics basics + lowData boundary at exactly 10:00 min
{
  const topicByUrl = new Map([['https://a.example/1', 'tA']]);
  const mk = totalMin => CTMetrics.computeDayMetrics('2026-03-10', {
    dayVisits: [visit('https://a.example/1', 540, totalMin)],
    topicByUrl,
    topicsById
  });
  assert.strictEqual(mk(9 + 59 / 60).lowData, true, '9:59 is low data');
  assert.strictEqual(mk(10).lowData, false, '10:00 exactly is not low data');
}

// --- switches per active hour and continuity; DST day does not distort rates
{
  const topicByUrl = new Map([
    ['https://a.example/1', 'tA'],
    ['https://a.example/2', 'tA'],
    ['https://b.example/1', 'tB'],
    ['https://c.example/1', 'tC']
  ]);
  const dayVisits = [
    visit('https://a.example/1', 540, 10),
    visit('https://a.example/2', 550, 10),  // same topic flow
    visit('https://b.example/1', 560, 20),  // switch (cosine 0 < 0.58)
    visit('https://a.example/1', 580, 10),  // switch back
    visit('https://c.example/1', 590, 10)   // adjacent (cosine 0.9 >= 0.58)
  ];
  const metrics = CTMetrics.computeDayMetrics('2026-03-10', { dayVisits, topicByUrl, topicsById });
  assert.strictEqual(metrics.activeMs, 60 * MIN);
  // 4 transitions: same, switch, switch, adjacent => 2 switches / 1 active hour
  assert.strictEqual(metrics.switchesPerActiveHour, 2);
  assert.strictEqual(metrics.continuityShare, 0.5, 'same + adjacent over 4 transitions');
  assert.strictEqual(metrics.activeTopicCount, 3);
  assert.strictEqual(metrics.categorizedShare, 1);

  // A 23-hour DST day carries the same activeMs sum, so the rate is identical
  // by construction: rates divide by measured active time, not wall clock.
  const dstVisits = dayVisits.map(v => ({ ...v, visitTime: v.visitTime - 2 * 24 * 3600 * 1000 })); // 2026-03-08
  const dstMetrics = CTMetrics.computeDayMetrics('2026-03-08', { dayVisits: dstVisits, topicByUrl, topicsById });
  assert.strictEqual(dstMetrics.switchesPerActiveHour, metrics.switchesPerActiveHour);
}

// --- transitions: reloads and session ends skipped, uncovered counted
{
  const topicByUrl = new Map([
    ['https://a.example/1', 'tA'],
    ['https://b.example/1', 'tB']
  ]);
  const dayVisits = [
    visit('https://a.example/1', 540, 5),
    visit('https://unknown.example/x', 545, 5),          // uncovered endpoint
    visit('https://b.example/1', 550, 5),                // uncovered endpoint
    visit('https://a.example/1', 555, 5, { endsSession: true }),
    visit('https://b.example/1', 600, 5),                // after session end: skipped
    visit('https://b.example/1', 605, 5, { transition: 'reload' }) // reload skipped
  ];
  const { transitions, uncoveredTransitions } = CTMetrics.buildDayTransitions('2026-03-10', dayVisits, topicByUrl, topicsById, {});
  assert.strictEqual(uncoveredTransitions, 2, 'transitions touching unknown pages are counted, not invented');
  const covered = transitions.reduce((sum, t) => sum + t.visitCount, 0);
  assert.strictEqual(covered, 1, 'only b->a before the session end counts');
}

// --- focused runs: >= 5 min dwell, broken by topic change and session end
{
  const topicByUrl = new Map([
    ['https://a.example/1', 'tA'],
    ['https://a.example/2', 'tA'],
    ['https://b.example/1', 'tB']
  ]);
  const dayVisits = [
    visit('https://a.example/1', 540, 3),
    visit('https://a.example/2', 545, 4),   // run tA: 7 min => kept
    visit('https://b.example/1', 550, 2),   // run tB: 2 min => dropped
    visit('https://a.example/1', 560, 6)    // run tA: 6 min => kept
  ];
  const runs = CTMetrics.buildFocusedRuns(dayVisits, topicByUrl, topicsById, {});
  assert.strictEqual(runs.length, 2);
  assert.ok(runs.every(r => r.dwellMs >= 5 * MIN));
  assert.strictEqual(runs[0].label, 'Topic A');
}

// --- convergence: needs both sources within the trailing 7 days inclusive
{
  const topicByUrl = new Map([['https://a.example/1', 'tA'], ['https://chat.example/1', 'tA']]);
  const webVisit = visit('https://a.example/1', 540, 5);
  const chatVisit = visit('https://chat.example/1', 560, 5, { source: 'llm_chat' });
  assert.deepStrictEqual(CTMetrics.convergentTopicIds([webVisit, chatVisit], topicByUrl), ['tA']);
  assert.deepStrictEqual(CTMetrics.convergentTopicIds([webVisit], topicByUrl), [], 'one source is not convergence');
  const metrics = CTMetrics.computeDayMetrics('2026-03-10', {
    dayVisits: [webVisit], windowVisits: [webVisit, chatVisit], topicByUrl, topicsById
  });
  assert.strictEqual(metrics.convergenceCount, 1);
}

// --- baselines: n=13 -> null, n=14 -> value; std=0 -> z=0; clamp at ±4
{
  const history = n => Array.from({ length: n }, (_, i) => ({
    day: CTText.addDays('2026-03-20', -(i + 1)),
    topicEntropy: 2.0,
    lowData: false
  }));
  const thirteen = CTMetrics.computeBaseline('topicEntropy', history(13), '2026-03-20');
  assert.strictEqual(thirteen.mean, null, '13 days is not enough for a baseline');
  assert.strictEqual(thirteen.n, 13);
  const fourteen = CTMetrics.computeBaseline('topicEntropy', history(14), '2026-03-20');
  assert.strictEqual(fourteen.mean, 2.0);
  assert.strictEqual(fourteen.n, 14);

  // constant metric: std 0 -> z 0
  const z0 = CTMetrics.zScore(3.5, fourteen);
  assert.strictEqual(z0.z, 0, 'constant baseline yields z=0, not Infinity');
  assert.strictEqual(z0.band, 'within');

  // varied history for clamping
  const varied = Array.from({ length: 20 }, (_, i) => ({
    day: CTText.addDays('2026-03-25', -(i + 1)),
    topicEntropy: 2.0 + (i % 2 ? 0.1 : -0.1),
    lowData: false
  }));
  const baseline = CTMetrics.computeBaseline('topicEntropy', varied, '2026-03-25');
  const clamped = CTMetrics.zScore(1000, baseline);
  assert.strictEqual(clamped.z, 4, 'z clamps at +4');
  assert.strictEqual(clamped.band, 'unusual');
  assert.strictEqual(CTMetrics.zScore(-1000, baseline).z, -4);

  // building state
  const building = CTMetrics.zScore(2, thirteen);
  assert.strictEqual(building.z, null);
  assert.ok(building.bandText.includes('13/14'));
}

// --- lowData days and today are excluded from baselines
{
  const history = [];
  for (let i = 1; i <= 20; i++) {
    history.push({ day: CTText.addDays('2026-03-25', -i), activeMs: 100, lowData: i % 2 === 0 });
  }
  history.push({ day: '2026-03-25', activeMs: 999999, lowData: false }); // today must not count
  const baseline = CTMetrics.computeBaseline('activeMs', history, '2026-03-25');
  assert.strictEqual(baseline.n, 10, 'only low-data-free prior days count');
  assert.strictEqual(baseline.mean, null, '10 < 14 so no baseline yet');
}

// --- band boundaries
{
  const baseline = { metric: 'x', n: 20, mean: 10, std: 1 };
  assert.strictEqual(CTMetrics.zScore(10.9, baseline).band, 'within');
  assert.strictEqual(CTMetrics.zScore(11.1, baseline).band, 'outside');
  assert.strictEqual(CTMetrics.zScore(12.1, baseline).band, 'unusual');
}

console.log('metrics tests passed');
