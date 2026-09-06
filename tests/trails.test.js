'use strict';
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const CTTrails = require('../lib/trails.js');
const CTText = require('../lib/text.js');
const CTStore = require('../lib/store.js');
const at = (day, hour = 12, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const now = at(5, 20);
const a = 'https://docs.example.test/rust';
const b = 'https://notes.example.test/async';
const c = 'https://other.example.test/page';
function snapshot() {
  return {
    topics: [{ topicId: 'rust', label: 'Async Rust', centroid: [1, 0], state: 'active' }],
    memberships: [{ topicId: 'rust', normalizedUrl: a }, { topicId: 'rust', normalizedUrl: b }],
    pages: [{ normalizedUrl: a, url: a, title: 'Rust guide' }],
    visits: [
      { visitId: 'a1', normalizedUrl: a, url: a, title: 'Rust guide', visitTime: at(1), dwellMs: 300000 },
      { visitId: 'b1', normalizedUrl: b, url: b, title: 'Async patterns', visitTime: at(1, 12, 10), dwellMs: 120000 },
      { visitId: 'a2', normalizedUrl: a, url: a, title: 'Rust guide', visitTime: at(3), dwellMs: 60000 },
      { visitId: 'a3', normalizedUrl: a, url: a, title: 'Rust guide', visitTime: at(3, 14), dwellMs: 60000 },
      { visitId: 'c1', normalizedUrl: c, url: c, title: 'Unclassified recipe', visitTime: at(4), dwellMs: 60000 }
    ],
    captures: [], corrections: [], runs: [], settings: []
  };
}

// A trail is backed by ordered visits. Repeats remain separate, while page
// and return-day counts have their own exact, inspectable denominators.
{
  const record = CTTrails.buildRecord(snapshot(), { now });
  assert.equal(record.visitCount, 5);
  assert.equal(record.pageCount, 3);
  assert.equal(record.categorizedCount, 4);
  assert.equal(record.trails[0].returnDays, 1);
  assert.equal(record.trails[0].pageCount, 2);
  assert.equal(record.trails[0].visitCount, 4);
  assert.equal(record.trails[0].sourceCount, 2);
  assert.deepEqual(record.trails[0].episodes.map(s => s.events.map(v => v.id)), [['a1', 'b1'], ['a2'], ['a3']]);
  assert.equal(record.events[0].url, a);
  assert.equal(record.trails[0].estimatedMs, 540000);
}

// Pages captured today can be recovered before the very first inference run.
// Capture metadata contains everything this model needs; page text is absent.
{
  const record = CTTrails.buildRecord({ captures: [
    { captureId: 'live', normalizedUrl: c, url: c, title: 'A fresh recipe', startedAt: at(5), updatedAt: at(5, 12, 2), activeMs: 65000 }
  ] }, { now });
  assert.equal(record.visitCount, 1);
  assert.equal(record.trails.length, 0);
  assert.equal(record.pendingCount, 1);
  assert.equal(record.measuredCount, 1);
  assert.equal(record.estimatedMs, 65000);
  assert.equal(CTTrails.search(record, { query: 'fresh recipe' }).length, 1);
  assert.equal(CTTrails.search(record, { ungrouped: true }).length, 1);
}

// Capture/history reconciliation is one-to-one, choosing the nearest visit.
// It neither duplicates an ingested visit nor erases a second real opening.
{
  const data = snapshot();
  data.captures = [
    { captureId: 'observed', normalizedUrl: a, url: a, startedAt: at(1) + 500, updatedAt: at(1, 12, 2), activeMs: 40000 },
    { captureId: 'second-opening', normalizedUrl: a, url: a, title: 'Second opening', startedAt: at(1) + 20000, updatedAt: at(1, 12, 2), activeMs: 15000 }
  ];
  const record = CTTrails.buildRecord(data, { now });
  assert.equal(record.visitCount, 6);
  assert.equal(record.events.find(e => e.id === 'a1').captureId, 'observed');
  assert.equal(record.events.find(e => e.id === 'a1').dwellMs, 25000, '15 seconds belong to the later opening, never both');
  assert.equal(record.pendingCount, 1);
  assert.equal(record.measuredCount, 2);
}

// Initial capture zeros are unknown, observed zeros really do lower dwell.
{
  const data = snapshot();
  data.captures = [{ captureId: 'initial', normalizedUrl: a, startedAt: at(1), updatedAt: at(1) + 500, activeMs: 0 }];
  assert.equal(CTTrails.buildRecord(data, { now }).events[0].dwellMs, 300000);
  data.captures[0].updatedAt = at(1) + 10000;
  const record = CTTrails.buildRecord(data, { now });
  assert.equal(record.events[0].dwellMs, 0);
  assert.equal(record.measuredCount, 1);
}

// Overlapping browser intervals count once, so separate tabs do not inflate time.
{
  assert.equal(CTTrails.estimateMs([
    { time: 1000, dwellMs: 10000 }, { time: 5000, dwellMs: 10000 },
    { time: 30000, dwellMs: 2000 }
  ]), 16000);
}

// Search covers topics, titles, hostnames, date text and date bounds; all
// terms must match one visit. No classifier result is required for retrieval.
{
  const data = snapshot();
  data.corrections = [CTTrails.makeCorrection('rust', { name: 'Learning Rust', note: 'Try the borrow checker example', pinned: true }, now)];
  const record = CTTrails.buildRecord(data, { now });
  assert.equal(CTTrails.search(record, { query: 'Learning checker' }).length, 4);
  assert.equal(CTTrails.search(record, { query: 'Async Rust' }).length, 4);
  assert.equal(CTTrails.search(record, { query: 'Unclassified recipe' }).length, 1);
  assert.equal(CTTrails.search(record, { query: 'notes.example.test' }).length, 1);
  assert.equal(CTTrails.search(record, { query: '2026-09-03' }).length, 2);
  assert.equal(CTTrails.search(record, { from: '2026-09-02', to: '2026-09-03' }).length, 2);
  assert.equal(CTTrails.search(record, { query: 'guide nonexistent' }).length, 0);
  assert.equal(CTTrails.search(record, { query: 'recipe', trailId: 'rust' }).length, 0);
  assert.equal(record.trails[0].suggestedLabel, 'Async Rust');
  assert.equal(record.trails[0].label, 'Learning Rust');
  assert.equal(data.topics[0].label, 'Async Rust', 'customization does not mutate inferred topic');
}

// Even corrupted legacy URLs must never produce executable navigation links.
{
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/private', 'https://user:password@example.test/a', 'junk']) {
    assert.equal(CTTrails.safeUrl(url), null);
    assert.equal(CTTrails.buildRecord({ visits: [{ visitId: url, url, visitTime: at(1) }] }, { now }).visitCount, 0);
  }
  assert.equal(CTTrails.buildRecord({ visits: [{ visitId: 'future', url: a, visitTime: now + 1000 }] }, { now }).visitCount, 0);
}

(async () => {
  const store = CTStore.createStore({ indexedDB: new IDBFactory(), IDBKeyRange });
  await store.open();
  const seed = snapshot();
  for (const [table, rows] of Object.entries(seed)) if (rows.length) await store.bulkPut(table, rows);
  await store.put('captures', { captureId: 'private-text', normalizedUrl: c, url: c, title: 'Visible title', startedAt: at(5), extractedText: 'SHOULD NEVER REACH THE UI' });
  store.resetStats();
  const data = await CTTrails.loadData(store);
  assert.equal(store.stats.transactions, 1, 'metadata read uses one atomic snapshot transaction');
  assert.ok(!('extractedText' in data.captures[0]), 'page text is not copied to the record surface');
  assert.ok(!('centroid' in data.topics[0]), 'model vectors are not copied to the record surface');
  assert.equal(CTTrails.buildRecord(data, { now }).visitCount, 6);
  const row = CTTrails.makeCorrection('rust', { name: 'My trail', note: 'Come back here', pinned: true }, now);
  await store.put('corrections', row);
  const reloaded = CTTrails.buildRecord(await CTTrails.loadData(store), { now });
  assert.equal(reloaded.trails[0].label, 'My trail');
  assert.equal(reloaded.trails[0].personal.note, 'Come back here');
  assert.equal(reloaded.trails[0].personal.pinned, true);
  await store.close();
  console.log('trails tests passed');
})().catch(error => { console.error(error); process.exit(1); });
