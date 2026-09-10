'use strict';
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const S = require('../../lib/store'), T = require('../../lib/trails'), I = require('../../lib/integrity'), C = require('../../lib/cluster');
const now = new Date(2026, 8, 5, 22).getTime(), start = now - 3600000;
const status = 'https://status.claude.com/', a = 'https://docs.example.test/a', b = 'https://guide.example.test/b';
const seed = () => ({ visits: [
  { visitId: 'status', normalizedUrl: status, url: status, title: 'Claude Status', visitTime: start, dwellMs: 805 * 60000 },
  { visitId: 'a', normalizedUrl: a, url: a, title: 'Guide', visitTime: start + 10000, dwellMs: 180000 },
  { visitId: 'b', normalizedUrl: b, url: b, title: 'Related material', visitTime: start + 300000, dwellMs: 180000 }
], captures: [{ captureId: 'brief', normalizedUrl: status, url: status, startedAt: start, endedAt: start + 8000, activeMs: 8000,
  activityIntervals: [[start, start + 8000]] }], pages: [status, a, b].map(url => ({ normalizedUrl: url, url, title: url === status ? 'Claude Status' : 'Guide', visitCount: 1, dwellMs: 805 * 60000 })),
  topics: [{ topicId: 'trail', label: 'Suggested topic', state: 'active', totalDwellMs: 805 * 60000, centroid: new Float32Array([1, 0]).buffer }],
  memberships: [status, a, b].map(url => ({ topicId: 'trail', normalizedUrl: url, dwellMs: 805 * 60000 })), settings: [], corrections: [] });
(async () => {
  const data = seed(), record = T.buildRecord(data, { now });
  assert.equal(record.events[0].dwellMs, 8000);
  assert.deepEqual(record.events[0].topicIds, []);
  assert.equal(record.events[0].groupingReason, 'operational-page');
  assert.equal(record.trails[0].estimatedMs, 360000, 'a brief page never borrows the trail aggregate');
  const store = S.createStore({ indexedDB: new IDBFactory(), IDBKeyRange }); await store.open();
  for (const [table, rows] of Object.entries(data)) await store.bulkPut(table, rows);
  const report = await I.repair(store, { now });
  assert.equal(report.removedMemberships, 1); assert.equal((await store.get('pages', status)).dwellMs, 8000);
  assert.equal((await store.get('topics', 'trail')).totalDwellMs, 360000);
  const again = await I.repair(store, { now }); assert.equal(again.changedPages + again.changedVisits + again.removedMemberships + again.changedTopics, 0);
  const correction = { correctionId: `page:${a}`, kind: 'page_membership', targetId: a, value: { topicId: null }, updatedAt: now };
  await I.repair(store, { now, correction });
  await store.registryCommit({ memberships: [{ topicId: 'trail', normalizedUrl: a }], pages: [{ normalizedUrl: a, classificationStatus: 'categorized' }] });
  assert.equal((await store.getAll('memberships')).some(m => m.normalizedUrl === a), false, 'late model commit cannot override the user');
  await I.repair(store, { now });
  assert.equal((await store.get('topics', 'trail')).totalDwellMs, 180000);
  await I.repair(store, { now, correction: { ...correction, value: { topicId: 'trail' }, updatedAt: now + 1 } });
  assert.equal((await store.get('pages', a)).classificationReason, null, 'reassignment clears stale exclusions');
  assert.equal((await store.get('pages', a)).classificationStatus, 'categorized');
  const brief = { url: status, normalizedUrl: status, title: 'Claude Status', visitCount: 1, dwellMs: 8000, activeMs: 8000, embedding: [1, 0] };
  const cfg = { memberVectorsByTopic: new Map([['x', [[1, 0], [1, 0]]]]) };
  const topics = [{ topicId: 'x', state: 'active', centroid: [1, 0] }];
  assert.equal(C.assignToExistingTopics([brief], topics, cfg).assigned.size, 0);
  assert.equal(C.clusterNewPages([brief, { ...brief, normalizedUrl: b }]).clusters.length, 0);
  const supported = { ...brief, url: a, normalizedUrl: a, visitCount: 2 };
  assert.equal(C.assignToExistingTopics([supported], topics, cfg).assigned.size, 1);
  assert.equal(C.assignToExistingTopics([supported], [...topics, { topicId: 'y', state: 'active', centroid: [0.999, 0.001] }], cfg).assigned.size, 0, 'ambiguous centroid matches abstain');
  assert.equal(C.assignToExistingTopics([supported], topics, { memberVectorsByTopic: new Map([['x', [[0, 1], [0, 1]]]]) }).assigned.size, 0, 'centroid alone is insufficient');
  const boundary = T.buildRecord({ captures: [{ captureId: 'new', url: a, startedAt: start, updatedAt: now,
    activityIntervals: [[start, start + 1000], [now - 2000, now + 5000]], activeMs: 12345678 }] }, { now });
  assert.equal(boundary.estimatedMs, 3000, 'measured slices clip at now and preserve gaps');
  assert.equal(T.estimateMs(boundary.events, { from: now - 1000, to: now }), 1000);
  const overlap = T.buildRecord({ visits: [
    { visitId: 'old', url: a, visitTime: start, dwellMs: 10000 }, { visitId: 'new', url: b, visitTime: start + 5000, dwellMs: 10000 }
  ] }, { now });
  assert.equal(overlap.estimatedMs, 15000); assert.equal(overlap.events.reduce((n, e) => n + e.dwellMs, 0), 15000);
  const refreshes = seed();
  refreshes.visits = Array.from({ length: 211 }, (_, i) => ({ visitId: `refresh-${i}`, normalizedUrl: status, url: status, title: 'Claude Status', visitTime: start - i * 3600000, dwellMs: 1800000, transition: 'link' }));
  refreshes.captures = [{ captureId: 'active-total', url: status, normalizedUrl: status, startedAt: start, activeMs: 35000 }];
  const refreshed = T.buildRecord(refreshes, { now });
  assert.equal(refreshed.estimatedMs, 35000, 'repeated operational gaps have unknown duration; legacy unfinished active totals are retained');
  assert.equal(refreshed.events.filter(e => e.timingMethod === 'operational-duration-unknown').length, 210);
  assert.equal(refreshed.trails.length, 0, 'repetition from operational refreshes cannot satisfy grouping evidence');
  const overlapping = seed(); overlapping.visits[1].visitTime = start + 1000; overlapping.visits[2].visitTime = start + 2000;
  const constrained = T.buildRecord(overlapping, { now });
  assert.equal(constrained.events.find(e => e.id === 'a').topicIds.length, 0, 'grouping uses time left after overlap allocation');
  const upgrading = S.createStore({ indexedDB: new IDBFactory(), IDBKeyRange }); await upgrading.open();
  for (const [table, rows] of Object.entries(seed())) await upgrading.bulkPut(table, rows);
  await upgrading.setSetting('evidenceRepairVersion', 2);
  await I.repair(upgrading, { now, once: true });
  assert.equal(await upgrading.getSetting('evidenceRepairVersion'), 3, 'existing installations receive the updated accounting rule');
  assert.equal((await upgrading.get('pages', status)).dwellMs, 8000);
  assert.equal((await upgrading.getAll('visits')).length, seed().visits.length, 'repair preserves original navigation records');
  assert.equal(await I.repair(upgrading, { now, once: true }), null, 'startup repair runs once per version');
  await upgrading.close();
  await store.close(); console.log('evidence integrity and correction regression tests passed');
})().catch(e => { console.error(e); process.exit(1); });
