'use strict';
const assert = require('assert');
const CTRegistry = require('../../lib/registry.js');
const CTCluster = require('../../lib/cluster.js');

// Helpers: unit vectors at a chosen cosine to [1,0].
const vecAt = c => Float32Array.from([c, Math.sqrt(Math.max(0, 1 - c * c))]);
const baseVec = Float32Array.from([1, 0]);

function makeTopic(overrides) {
  return {
    topicId: 'topic-a',
    label: 'Existing topic',
    labelSource: 'llm',
    centroid: baseVec,
    dim: 2,
    state: 'active',
    createdAt: 0,
    lastActiveDay: '2026-03-01',
    lastActiveAt: 0,
    dormantSince: null,
    confidence: 0.8,
    heuristicConfidence: 0.7,
    keywords: ['existing'],
    userCorrected: false,
    totalDwellMs: 60 * 60 * 1000,
    lineage: { parents: [], children: [], reason: 'origin' },
    ...overrides
  };
}

function makeCluster(overrides) {
  return {
    pages: [
      { normalizedUrl: 'https://new.example/1', dwellMs: 10 * 60000, activeMs: 5 * 60000, visitCount: 2, firstDay: '2026-03-10', lastDay: '2026-03-10' },
      { normalizedUrl: 'https://new.example/2', dwellMs: 5 * 60000, activeMs: 2 * 60000, visitCount: 1, firstDay: '2026-03-10', lastDay: '2026-03-10' }
    ],
    centroid: baseVec,
    heuristicConfidence: 0.7,
    keywords: ['new', 'cluster'],
    label: 'New cluster',
    labelSource: 'llm',
    labelConfidence: 0.8,
    ...overrides
  };
}

// --- match score boundaries: overlap 0 so score = 0.7 * cosine.
// score 0.79/0.80/0.81 <=> cosine ~ 1.1286/1.1429/... impossible with pure
// cosine, so boundary tests inject overlap via memberships instead.
{
  // cosine such that 0.7*cos = target - 0.3*overlapShare. Use overlap 1.0
  // (both cluster pages in recent memberships): score = 0.7*cos + 0.3.
  const memberships = [
    { topicId: 'topic-a', normalizedUrl: 'https://new.example/1', lastDay: '2026-03-09' },
    { topicId: 'topic-a', normalizedUrl: 'https://new.example/2', lastDay: '2026-03-09' }
  ];
  const scoreCase = (targetScore) => {
    const cos = (targetScore - 0.3) / 0.7;
    const decisions = CTRegistry.matchNewClusters(
      [makeCluster({ centroid: vecAt(cos) })],
      [makeTopic()],
      memberships,
      { today: '2026-03-10' }
    );
    return decisions[0];
  };
  assert.strictEqual(scoreCase(0.79).action, 'create', 'score 0.79 must not merge');
  assert.ok(scoreCase(0.79).nearMiss, 'score 0.79 records a near-miss');
  assert.strictEqual(scoreCase(0.801).action, 'merge', 'score just above 0.80 merges');
  assert.strictEqual(scoreCase(0.81).action, 'merge');
  assert.strictEqual(scoreCase(0.66).action, 'create');
  assert.ok(scoreCase(0.66).nearMiss, 'score 0.66 is a near-miss create');
  assert.deepStrictEqual(scoreCase(0.66).lineageParents, ['topic-a']);
  assert.strictEqual(scoreCase(0.64).action, 'create');
  assert.ok(!scoreCase(0.64).nearMiss, 'score 0.64 is a plain create');
  // exact boundaries
  assert.strictEqual(scoreCase(0.80).action, 'merge', 'score exactly 0.80 merges (>=)');
  assert.ok(scoreCase(0.65).nearMiss, 'score exactly 0.65 is a near-miss (>=)');
}

// --- two new clusters -> one existing topic: both merge, one absorption event
{
  const memberships = [
    { topicId: 'topic-a', normalizedUrl: 'https://new.example/1', lastDay: '2026-03-09' },
    { topicId: 'topic-a', normalizedUrl: 'https://new.example/2', lastDay: '2026-03-09' },
    { topicId: 'topic-a', normalizedUrl: 'https://other.example/1', lastDay: '2026-03-09' },
    { topicId: 'topic-a', normalizedUrl: 'https://other.example/2', lastDay: '2026-03-09' }
  ];
  const clusterB = makeCluster({
    pages: [
      { normalizedUrl: 'https://other.example/1', dwellMs: 6 * 60000, activeMs: 0, visitCount: 1, firstDay: '2026-03-10', lastDay: '2026-03-10' },
      { normalizedUrl: 'https://other.example/2', dwellMs: 6 * 60000, activeMs: 0, visitCount: 1, firstDay: '2026-03-10', lastDay: '2026-03-10' }
    ]
  });
  const topics = [makeTopic()];
  const decisions = CTRegistry.matchNewClusters([makeCluster(), clusterB], topics, memberships, { today: '2026-03-10' });
  assert.ok(decisions.every(d => d.action === 'merge' && d.topicId === 'topic-a'));
  const result = CTRegistry.applyMatches(
    decisions,
    new Map(topics.map(t => [t.topicId, t])),
    new Map(),
    { runId: 'r1', today: '2026-03-10', now: 1000 }
  );
  assert.strictEqual(result.topicRows.length, 1, 'one absorbing topic row');
  assert.strictEqual(result.membershipRows.length, 4);
  const merged = result.events.filter(e => e.type === 'merged' && e.detail.proposal === false);
  assert.strictEqual(merged.length, 1, 'exactly one absorption event for a double merge');
  assert.strictEqual(merged[0].detail.absorbedClusters, 2);
}

// --- one new cluster -> two existing topics within 0.03: proposal, no merge of topics
{
  const topicA = makeTopic({ topicId: 'topic-a', centroid: vecAt(0.99) });
  const topicB = makeTopic({ topicId: 'topic-b', centroid: vecAt(0.97), label: 'Other topic' });
  const memberships = [
    { topicId: 'topic-a', normalizedUrl: 'https://new.example/1', lastDay: '2026-03-09' },
    { topicId: 'topic-a', normalizedUrl: 'https://new.example/2', lastDay: '2026-03-09' },
    { topicId: 'topic-b', normalizedUrl: 'https://new.example/1', lastDay: '2026-03-09' },
    { topicId: 'topic-b', normalizedUrl: 'https://new.example/2', lastDay: '2026-03-09' }
  ];
  const decisions = CTRegistry.matchNewClusters([makeCluster({ centroid: baseVec })], [topicA, topicB], memberships, { today: '2026-03-10' });
  assert.strictEqual(decisions[0].action, 'merge');
  assert.strictEqual(decisions[0].topicId, 'topic-a', 'membership goes to the higher-scoring topic');
  assert.ok(decisions[0].mergeProposal, 'a proposal is emitted');
  const result = CTRegistry.applyMatches(
    decisions,
    new Map([[topicA.topicId, topicA], [topicB.topicId, topicB]]),
    new Map(),
    { runId: 'r1', today: '2026-03-10', now: 1000 }
  );
  const proposals = result.events.filter(e => e.type === 'merged' && e.detail.proposal);
  assert.strictEqual(proposals.length, 1);
  assert.strictEqual(result.topicRows.length, 1, 'topic-b is untouched: proposals never execute');
}

// --- dwell-weighted centroid update
{
  // old centroid [1,0] with 60 min dwell; new cluster centroid [0,1] with 15 min dwell
  const topic = makeTopic({ totalDwellMs: 60 * 60000 });
  const cluster = makeCluster({
    centroid: Float32Array.from([0, 1]),
    pages: [{ normalizedUrl: 'https://new.example/1', dwellMs: 15 * 60000, activeMs: 0, visitCount: 1, firstDay: '2026-03-10', lastDay: '2026-03-10' }]
  });
  const result = CTRegistry.applyMatches(
    [{ action: 'merge', cluster, topicId: 'topic-a', score: 0.9 }],
    new Map([['topic-a', topic]]),
    new Map(),
    { runId: 'r1', today: '2026-03-10', now: 1000 }
  );
  const updated = result.topicRows[0];
  assert.ok(updated.centroid[0] > updated.centroid[1], 'old dwell outweighs one new day');
  const expected = CTCluster.normalize(Float32Array.from([60, 15]));
  assert.ok(Math.abs(updated.centroid[0] - expected[0]) < 1e-5,
    'centroid weights are the topic total against the dwell this run adds');
  // totalDwellMs is RECOMPUTED from the topic's memberships, never accumulated
  // (runs re-ingest an overlap window, so accumulating would inflate it).
  // Here the topic ends up with exactly one membership worth 15 minutes.
  assert.strictEqual(updated.totalDwellMs, 15 * 60000);
}

// --- topic dwell is the sum over memberships, including untouched ones
{
  const topic = makeTopic({ totalDwellMs: 999 * 60000 }); // deliberately wrong stored value
  const existing = new Map([
    [CTRegistry.membershipKey('topic-a', 'https://old.example/1'), {
      topicId: 'topic-a', normalizedUrl: 'https://old.example/1',
      firstDay: '2026-03-01', lastDay: '2026-03-02', dwellMs: 20 * 60000, activeMs: 0, visitCount: 3
    }]
  ]);
  const pageTotals = new Map([
    ['https://new.example/1', { dwellMs: 10 * 60000, activeMs: 0, visitCount: 2, firstDay: '2026-03-10', lastDay: '2026-03-10' }],
    ['https://new.example/2', { dwellMs: 5 * 60000, activeMs: 0, visitCount: 1, firstDay: '2026-03-10', lastDay: '2026-03-10' }]
  ]);
  const result = CTRegistry.applyMatches(
    [{ action: 'merge', cluster: makeCluster(), topicId: 'topic-a', score: 0.9 }],
    new Map([['topic-a', topic]]),
    existing,
    { runId: 'r1', today: '2026-03-10', now: 1000, pageTotals }
  );
  assert.strictEqual(result.topicRows[0].totalDwellMs, 35 * 60000,
    'untouched membership (20m) plus the two recomputed rows (10m + 5m); the stale stored total is discarded');
  const rows = result.membershipRows;
  assert.strictEqual(rows.find(r => r.normalizedUrl === 'https://new.example/1').dwellMs, 10 * 60000,
    'membership dwell comes from the page total, not from adding this run to the stored row');
}

// --- relabel rule
{
  const run = (labelConfidence, newLabel, userCorrected) => {
    const topic = makeTopic({ label: 'Rust async runtimes', userCorrected: !!userCorrected });
    const cluster = makeCluster({ label: newLabel, labelConfidence });
    return CTRegistry.applyMatches(
      [{ action: 'merge', cluster, topicId: 'topic-a', score: 0.9 }],
      new Map([['topic-a', topic]]),
      new Map(),
      { runId: 'r1', today: '2026-03-10', now: 1000 }
    );
  };
  const relabeled = run(0.95, 'Sourdough fermentation');
  assert.strictEqual(relabeled.topicRows[0].label, 'Sourdough fermentation');
  assert.ok(relabeled.topicRows[0].keywords.includes('Rust async runtimes'), 'old label kept as alias');
  assert.ok(relabeled.events.some(e => e.type === 'relabeled'));

  const lowConf = run(0.85, 'Sourdough fermentation');
  assert.strictEqual(lowConf.topicRows[0].label, 'Rust async runtimes', 'confidence <= 0.9 keeps the old label');

  const similar = run(0.95, 'Rust async runtime');
  assert.strictEqual(similar.topicRows[0].label, 'Rust async runtimes', 'small edit distance keeps the old label');

  const corrected = run(0.99, 'Sourdough fermentation', true);
  assert.strictEqual(corrected.topicRows[0].label, 'Rust async runtimes', 'user-corrected labels are never overwritten');
}

// --- lifecycle: dormant on exact day boundaries 13/14/15
{
  const sweep = (lastActiveDay, today, extra) => CTRegistry.lifecycleSweep(
    [makeTopic({ lastActiveDay, ...extra })],
    { today, runId: 'r1' }
  );
  assert.strictEqual(sweep('2026-03-01', '2026-03-14').events.length, 0, '13 days: still active');
  const at14 = sweep('2026-03-01', '2026-03-15');
  assert.strictEqual(at14.events.length, 1, '14 days: dormant fires');
  assert.strictEqual(at14.events[0].type, 'dormant');
  assert.strictEqual(at14.events[0].day, '2026-03-15', 'event dated lastActiveDay + 14');
  assert.strictEqual(at14.updatedTopics[0].state, 'dormant');
  const at15 = sweep('2026-03-01', '2026-03-16');
  assert.strictEqual(at15.events[0].day, '2026-03-15', 'late run still dates the event to the crossing day');
}

// --- retirement at 119/120 dormant days, dwell 29/30 min
{
  const retireCase = (dormantDays, dwellMin, userCorrected) => CTRegistry.lifecycleSweep(
    [makeTopic({
      state: 'dormant',
      lastActiveDay: '2025-11-01',
      totalDwellMs: dwellMin * 60000,
      userCorrected: !!userCorrected,
      dormantSince: 1
    })],
    { today: require('../../lib/text.js').addDays('2025-11-01', dormantDays), runId: 'r1' }
  );
  assert.strictEqual(retireCase(119, 29).events.length, 0, '119 dormant days: not retired');
  const retired = retireCase(120, 29);
  assert.strictEqual(retired.events.length, 1);
  assert.strictEqual(retired.events[0].type, 'retired');
  assert.strictEqual(retireCase(120, 30).events.length, 0, '30 min total dwell is not "< 30 min"');
  assert.strictEqual(retireCase(200, 5, true).events.length, 0, 'userCorrected topics never retire');
}

// --- revival with dormantDays detail; paused days subtracted
{
  const dormantTopic = makeTopic({ state: 'dormant', lastActiveDay: '2026-03-01', dormantSince: 1 });
  const pausedDays = new Set(['2026-03-05', '2026-03-06', '2026-03-07']);
  const cluster = makeCluster({ pages: [{ normalizedUrl: 'https://new.example/1', dwellMs: 60000, activeMs: 0, visitCount: 1, firstDay: '2026-03-25', lastDay: '2026-03-25' }] });
  const result = CTRegistry.applyMatches(
    [{ action: 'merge', cluster, topicId: 'topic-a', score: 0.9 }],
    new Map([['topic-a', dormantTopic]]),
    new Map(),
    { runId: 'r1', today: '2026-03-25', now: 1000, pausedDays }
  );
  const revived = result.events.find(e => e.type === 'revived');
  assert.ok(revived, 'merging into a dormant topic emits revived');
  assert.strictEqual(revived.detail.dormantDays, 24 - 3, 'paused days do not count toward dormancy');
  assert.strictEqual(result.topicRows[0].state, 'active');
  assert.strictEqual(result.topicRows[0].dormantSince, null);
}

// --- paused days postpone the dormancy crossing
{
  const pausedDays = new Set(['2026-03-05', '2026-03-06']);
  const result = CTRegistry.lifecycleSweep(
    [makeTopic({ lastActiveDay: '2026-03-01' })],
    { today: '2026-03-15', runId: 'r1', pausedDays }
  );
  assert.strictEqual(result.events.length, 0, '14 raw days minus 2 paused = 12: not dormant yet');
  const later = CTRegistry.lifecycleSweep(
    [makeTopic({ lastActiveDay: '2026-03-01' })],
    { today: '2026-03-17', runId: 'r1', pausedDays }
  );
  assert.strictEqual(later.events.length, 1);
  assert.strictEqual(later.events[0].day, '2026-03-17', 'crossing day shifts by the paused days');
}

// --- first run: only created events
{
  const decisions = CTRegistry.matchNewClusters([makeCluster()], [], [], { today: '2026-03-01' });
  assert.strictEqual(decisions[0].action, 'create');
  const result = CTRegistry.applyMatches(decisions, new Map(), new Map(), {
    runId: 'r1', today: '2026-03-01', now: 1000, newTopicId: () => 't-fixed-1'
  });
  assert.deepStrictEqual(result.events.map(e => e.type), ['created']);
  assert.strictEqual(result.topicRows[0].topicId, 't-fixed-1');
  assert.strictEqual(result.topicRows[0].lineage.reason, 'origin');
  const sweep = CTRegistry.lifecycleSweep(result.topicRows, { today: '2026-03-01', runId: 'r1' });
  assert.strictEqual(sweep.events.length, 0, 'no dormant/revived on first run');
}

// --- 21-day gap: all topics dormant, each dated to its own crossing day
{
  const topics = [
    makeTopic({ topicId: 't1', lastActiveDay: '2026-03-01' }),
    makeTopic({ topicId: 't2', lastActiveDay: '2026-03-01' }),
    makeTopic({ topicId: 't3', lastActiveDay: '2026-02-27' })
  ];
  const result = CTRegistry.lifecycleSweep(topics, { today: '2026-03-22', runId: 'r1' });
  assert.strictEqual(result.events.length, 3, 'a long gap makes every topic dormant');
  assert.strictEqual(result.events.filter(e => e.day === '2026-03-15').length, 2, 'same lastActiveDay -> same crossing day');
  assert.strictEqual(result.events.find(e => e.topicId === 't3').day, '2026-03-13');
}

// --- membership rows take the page's authoritative totals, and keep the
//     widest day span they have ever seen
{
  const existing = new Map([[CTRegistry.membershipKey('topic-a', 'https://new.example/1'), {
    topicId: 'topic-a', normalizedUrl: 'https://new.example/1',
    firstDay: '2026-02-01', lastDay: '2026-02-20', dwellMs: 10 * 60000, activeMs: 60000, visitCount: 4
  }]]);
  const pageTotals = new Map([
    ['https://new.example/1', { dwellMs: 25 * 60000, activeMs: 7 * 60000, visitCount: 9, firstDay: '2026-02-05', lastDay: '2026-03-10' }]
  ]);
  const rows = CTRegistry.buildMembershipRows('topic-a', makeCluster(), existing, 'r2', pageTotals);
  const merged = rows.find(r => r.normalizedUrl === 'https://new.example/1');
  assert.strictEqual(merged.firstDay, '2026-02-01', 'the earlier stored firstDay is kept');
  assert.strictEqual(merged.lastDay, '2026-03-10', 'the later day wins');
  assert.strictEqual(merged.dwellMs, 25 * 60000, 'dwell is the page total, not stored + this run');
  assert.strictEqual(merged.visitCount, 9, 'visits are the page total, not stored + this run');
  assert.strictEqual(merged.activeMs, 7 * 60000);

  // Re-running with the same totals must be a no-op, which is the property
  // that keeps the 2 h re-ingest overlap from inflating the registry.
  const rerun = CTRegistry.buildMembershipRows(
    'topic-a', makeCluster(), new Map(rows.map(r => [CTRegistry.membershipKey(r.topicId, r.normalizedUrl), r])), 'r3', pageTotals
  );
  const again = rerun.find(r => r.normalizedUrl === 'https://new.example/1');
  assert.strictEqual(again.dwellMs, merged.dwellMs, 'idempotent across re-runs');
  assert.strictEqual(again.visitCount, merged.visitCount);

  // Without pageTotals (unit-test convenience) the cluster page's own values stand.
  const fallback = CTRegistry.buildMembershipRows('topic-a', makeCluster(), new Map(), 'r2');
  assert.strictEqual(fallback[0].dwellMs, 10 * 60000, 'falls back to the page object when no totals are supplied');
}

console.log('registry tests passed');
