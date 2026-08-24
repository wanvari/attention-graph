'use strict';
const assert = require('assert');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const CTStore = require('../../lib/store.js');

function freshFactory() {
  return new IDBFactory();
}

// Build a v3-shaped database inside the given factory.
function seedV3Db(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open('attentionGraphTrustAudit', 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('analyses', { keyPath: 'key' });
      db.createObjectStore('corrections', { keyPath: 'key' });
      db.createObjectStore('embeddings', { keyPath: 'key' });
      db.createObjectStore('settings', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['analyses', 'corrections', 'embeddings', 'settings'], 'readwrite');
      tx.objectStore('analyses').put({ key: 'latest-analysis', value: { ok: true, topics: [{ id: 'topic-1' }] } });
      tx.objectStore('corrections').put({
        key: 'topic:topic-1', kind: 'topic', targetId: 'topic-1', label: 'My label',
        pageUrls: ['https://a.example/x'], updatedAt: 1000
      });
      tx.objectStore('corrections').put({
        key: 'transition:transition-9', kind: 'transition', targetId: 'transition-9', type: 'topic_switch', updatedAt: 1001
      });
      tx.objectStore('embeddings').put({ key: 'bge-m3:latest|abc123', value: [0.6, 0.8], updatedAt: 999 });
      tx.objectStore('settings').put({ key: 'user-settings', value: { days: 14, chatModel: 'gemma3:12b', maxPagesForAi: 420 } });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

async function testSchemaCreation() {
  const store = CTStore.createStore({ indexedDB: freshFactory(), IDBKeyRange });
  await store.open();
  // every store accepts a row of its shape
  await store.put('visits', { visitId: 'v1', normalizedUrl: 'https://a.example/x', visitTime: 5, dayKey: '2026-03-01' });
  await store.put('topics', { topicId: 't1', state: 'active', lastActiveAt: 5 });
  await store.put('memberships', { topicId: 't1', normalizedUrl: 'https://a.example/x', lastDay: '2026-03-01' });
  const visits = await store.byIndex('visits', 'byDay', '2026-03-01');
  assert.strictEqual(visits.length, 1);
  const membership = await store.get('memberships', ['t1', 'https://a.example/x']);
  assert.ok(membership, 'composite keyPath roundtrips');
  // topic_events autoincrements
  await store.bulkPut('topic_events', [{ topicId: 't1', day: '2026-03-01', type: 'created', detail: {} }]);
  const events = await store.getAll('topic_events');
  assert.ok(events[0].eventId, 'autoIncrement assigned an eventId');
}

async function testMigrationFromV3() {
  const factory = freshFactory();
  await seedV3Db(factory);
  const store = CTStore.createStore({ indexedDB: factory, IDBKeyRange });
  await store.open();

  const embeddings = await store.getAll('embeddings');
  assert.strictEqual(embeddings.length, 1, 'embedding cache preserved');
  assert.strictEqual(embeddings[0].key, 'bge-m3:latest|abc123');
  assert.strictEqual(embeddings[0].model, 'bge-m3:latest');
  assert.strictEqual(embeddings[0].dim, 2);
  const vec = CTStore.bufToVec(embeddings[0].vector);
  assert.ok(Math.abs(vec[0] - 0.6) < 1e-6);
  assert.strictEqual(embeddings[0].lastUsedAt, 999, 'lastUsedAt seeded from updatedAt');

  const corrections = await store.getAll('corrections');
  assert.strictEqual(corrections.length, 2);
  const topicCorrection = corrections.find(c => c.kind === 'topic_label');
  assert.ok(topicCorrection, "v3 kind 'topic' re-keyed to 'topic_label'");
  assert.strictEqual(topicCorrection.value, 'My label');
  assert.deepStrictEqual(topicCorrection.pageUrls, ['https://a.example/x']);
  assert.ok(corrections.find(c => c.kind === 'transition_type'), "'transition' re-keyed to 'transition_type'");

  const settings = await store.getSettingsMap();
  assert.strictEqual(settings.days, 14);
  assert.strictEqual(settings.chatModel, 'gemma3:12b');
  assert.strictEqual(settings.maxPagesForAi, undefined, 'v3 page budget is not carried into v4 semantics');
  assert.ok(settings.v3MigrationDone, 'migration flagged done');

  // The v3 snapshot analysis is dropped along with the old database.
  const dbs = await factory.databases();
  assert.ok(!dbs.some(d => d.name === 'attentionGraphTrustAudit'), 'v3 DB deleted after successful migration');

  // Re-opening does not re-run migration.
  const again = await store.migrateFromV3();
  assert.strictEqual(again.reason, 'already-done');
}

async function testMigrationFailureLeavesV3Intact() {
  const factory = freshFactory();
  await seedV3Db(factory);
  const store = CTStore.createStore({ indexedDB: factory, IDBKeyRange, _failMigrationWrite: true });
  await store.open();
  assert.ok(store.migrationError, 'failure is surfaced');
  const settings = await store.getSettingsMap();
  assert.ok(!settings.v3MigrationDone, 'failed migration is not marked done');
  const dbs = await factory.databases();
  assert.ok(dbs.some(d => d.name === 'attentionGraphTrustAudit'), 'v3 DB survives a failed migration');

  // Retry without the injected failure succeeds against the same factory.
  await store.close();
  const retryStore = CTStore.createStore({ indexedDB: factory, IDBKeyRange });
  await retryStore.open();
  assert.strictEqual((await retryStore.getAll('embeddings')).length, 1);
  assert.ok((await retryStore.getSettingsMap()).v3MigrationDone);
}

async function testRegistryCommitRollsBack() {
  const store = CTStore.createStore({ indexedDB: freshFactory(), IDBKeyRange });
  await store.open();
  const payload = {
    topics: [{ topicId: 't1', state: 'active', lastActiveAt: 1 }],
    memberships: [{ topicId: 't1', normalizedUrl: 'https://a.example/x', lastDay: '2026-03-01' }],
    events: [{ topicId: 't1', day: '2026-03-01', type: 'created', detail: {} }]
  };
  await assert.rejects(
    () => store.registryCommit(payload, { injectErrorAfterTopics: true }),
    'aborted transaction must reject'
  );
  assert.strictEqual((await store.getAll('topics')).length, 0, 'topics rolled back');
  assert.strictEqual((await store.getAll('memberships')).length, 0);
  assert.strictEqual((await store.getAll('topic_events')).length, 0);

  await store.registryCommit(payload);
  assert.strictEqual((await store.getAll('topics')).length, 1, 'clean commit applies everything');
  assert.strictEqual((await store.getAll('memberships')).length, 1);
  assert.strictEqual((await store.getAll('topic_events')).length, 1);
}

async function testEmbeddingPruneRespectsMembership() {
  const store = CTStore.createStore({ indexedDB: freshFactory(), IDBKeyRange });
  await store.open();
  const now = Date.now();
  const old = now - 50 * 24 * 3600 * 1000;
  await store.bulkPut('embeddings', [
    { key: 'm|kept-in-use', model: 'm', vector: new ArrayBuffer(8), dim: 2, createdAt: old, lastUsedAt: old },
    { key: 'm|kept-fresh', model: 'm', vector: new ArrayBuffer(8), dim: 2, createdAt: now, lastUsedAt: now },
    { key: 'm|pruned', model: 'm', vector: new ArrayBuffer(8), dim: 2, createdAt: old, lastUsedAt: old }
  ]);
  await store.put('pages', { normalizedUrl: 'https://a.example/x', embeddingKey: 'm|kept-in-use', lastSeen: old, domain: 'a.example' });
  await store.put('pages', { normalizedUrl: 'https://b.example/x', embeddingKey: 'm|pruned', lastSeen: old, domain: 'b.example' });
  await store.put('memberships', { topicId: 't1', normalizedUrl: 'https://a.example/x', lastDay: '2026-01-01' });
  // b.example has no membership; its stale embedding goes.

  const removed = await store.pruneEmbeddings(now);
  assert.strictEqual(removed, 1);
  const remaining = (await store.getAll('embeddings')).map(r => r.key).sort();
  assert.deepStrictEqual(remaining, ['m|kept-fresh', 'm|kept-in-use'],
    'stale-but-membered and fresh embeddings survive; only the orphan goes');
}

async function testRetentionDeletesTextOnly() {
  const store = CTStore.createStore({ indexedDB: freshFactory(), IDBKeyRange });
  await store.open();
  const now = Date.now();
  const old = now - 31 * 24 * 3600 * 1000;
  await store.bulkPut('captures', [
    {
      captureId: 'c-old', normalizedUrl: 'https://a.example/x', startedAt: old, dayKey: '2026-02-01',
      extractedText: 'long old text', textHash: 'h1', activeMs: 120000, maxScrollDepth: 0.8
    },
    {
      captureId: 'c-new', normalizedUrl: 'https://b.example/x', startedAt: now, dayKey: '2026-03-10',
      extractedText: 'fresh text', textHash: 'h2', activeMs: 60000, maxScrollDepth: 0.5
    }
  ]);
  const swept = await store.retentionSweep(now);
  assert.strictEqual(swept, 1);
  const oldRow = await store.get('captures', 'c-old');
  assert.strictEqual(oldRow.extractedText, '', 'text removed');
  assert.strictEqual(oldRow.activeMs, 120000, 'aggregates kept');
  assert.strictEqual(oldRow.textHash, 'h1', 'hash kept');
  assert.strictEqual(oldRow.maxScrollDepth, 0.8);
  const newRow = await store.get('captures', 'c-new');
  assert.strictEqual(newRow.extractedText, 'fresh text', 'recent captures untouched');
}

async function testDayCommitReplacesDayRows() {
  const store = CTStore.createStore({ indexedDB: freshFactory(), IDBKeyRange });
  await store.open();
  await store.dayCommit('2026-03-10', {
    metrics: { day: '2026-03-10', activeMs: 100 },
    transitions: [{ day: '2026-03-10', sourceTopicId: 'a', targetTopicId: 'b', type: 'topic_switch', visitCount: 1 }],
    uncategorized: [{ day: '2026-03-10', normalizedUrl: 'https://x.example/1', reason: 'disagreement' }],
    baselines: [{ metric: 'topicEntropy', n: 14, mean: 2 }],
    brief: { day: '2026-03-10', items: [] }
  });
  // Recommit with different rows: old day rows are replaced, not appended.
  await store.dayCommit('2026-03-10', {
    metrics: { day: '2026-03-10', activeMs: 200 },
    transitions: [{ day: '2026-03-10', sourceTopicId: 'a', targetTopicId: 'c', type: 'topic_switch', visitCount: 2 }],
    uncategorized: []
  });
  const transitions = await store.getAll('transitions');
  assert.strictEqual(transitions.length, 1, 'day recommit replaces the day');
  assert.strictEqual(transitions[0].targetTopicId, 'c');
  assert.strictEqual((await store.get('daily_metrics', '2026-03-10')).activeMs, 200);
  assert.strictEqual((await store.getAll('uncategorized')).length, 0);
  assert.strictEqual((await store.getAll('baselines')).length, 1, 'baselines persist when omitted');
}

async function run() {
  await testSchemaCreation();
  await testMigrationFromV3();
  await testMigrationFailureLeavesV3Intact();
  await testRegistryCommitRollsBack();
  await testEmbeddingPruneRespectsMembership();
  await testRetentionDeletesTextOnly();
  await testDayCommitReplacesDayRows();
  console.log('store tests passed');
}

run().catch(error => { console.error(error); process.exit(1); });
