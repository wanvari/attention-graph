'use strict';
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Store = require('../../lib/store.js');

(async () => {
  const store = Store.createStore({ indexedDB: new IDBFactory(), IDBKeyRange });
  await store.open();
  await store.put('captures', { captureId: 'c', url: 'https://example.test/a', normalizedUrl: 'https://example.test/a', startedAt: 1000, extractedText: 'PRIVATE', activeMs: 10 });
  await store.put('topics', { topicId: 't', label: 'A', centroid: Store.vecToBuf([1, 0]) });
  store.resetStats();
  const snapshot = await store.readSnapshot(['captures', 'topics']);
  assert.equal(store.stats.transactions, 1);
  assert.equal(snapshot.captures[0].extractedText, undefined);
  assert.equal(snapshot.topics[0].centroid, undefined);
  assert.equal((await store.get('captures', 'c')).extractedText, 'PRIVATE');

  await assert.rejects(store.registryCommit({ topics: [{ topicId: 'new' }], pages: [{ normalizedUrl: 'x', classificationStatus: 'categorized' }] }, { injectErrorAfterTopics: true }));
  assert.equal(await store.get('pages', 'x'), null);
  await store.registryCommit({ topics: [{ topicId: 'new' }], pages: [{ normalizedUrl: 'x', classificationStatus: 'categorized' }] });
  assert.equal((await store.get('pages', 'x')).classificationStatus, 'categorized');

  await store.wipe();
  await store.put('pages', { normalizedUrl: 'https://youtube.com/watch', url: 'https://www.youtube.com/watch?v=B', title: 'B' });
  await store.bulkPut('visits', ['A', 'B'].map((id, i) => ({ visitId: id, url: `https://www.youtube.com/watch?v=${id}&utm_source=test`, normalizedUrl: 'https://youtube.com/watch', title: id, visitTime: 10000 + i * 10000, dayKey: '2026-09-05', dwellMs: 100 })));
  await store.put('captures', { captureId: 'secret', url: 'https://example.test/#/login?token=SECRET', normalizedUrl: 'https://example.test/', startedAt: 1000, extractedText: 'SECRET' });
  await store.put('topics', { topicId: 'old', state: 'active', centroid: Store.vecToBuf([1, 0]), totalDwellMs: 200 });
  await store.put('memberships', { topicId: 'old', normalizedUrl: 'https://youtube.com/watch', dwellMs: 200 });
  await Promise.all([store.migrateUrlIdentities(), store.migrateUrlIdentities()]);
  const pages = await store.getAll('pages');
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map(p => p.normalizedUrl).sort(), ['https://youtube.com/watch?v=A', 'https://youtube.com/watch?v=B']);
  assert.ok(pages.every(p => p.needsEmbedding && p.needsClassification && p.metricsDirty));
  assert.equal((await store.getAll('visits')).length, 2);
  assert.ok((await store.getAll('visits')).every(v => !v.url.includes('utm_')));
  assert.equal(await store.count('memberships'), 0);
  assert.equal((await store.get('topics', 'old')).state, 'retired');
  assert.equal(await store.count('captures'), 0);
  await store.migrateUrlIdentities();
  assert.equal(await store.count('pages'), 2, 'identity migration is idempotent');
  await store.close();
  {
    const store = Store.createStore({ indexedDB: new IDBFactory(), IDBKeyRange });
    await store.open();
    await store.saveEditableSettings({ maxNewPagesPerRun: 100, days: 14 });
    for (const invalid of [{ maxNewPagesPerRun: 1000000 }, { dutyCycle: -1 }, { days: NaN }, { idleGatingEnabled: 'false' }, { denylist: 'example.com' }]) {
      await assert.rejects(() => store.saveEditableSettings({ days: 7, ...invalid }));
    }
    assert.equal(await store.getSetting('days'), 14, 'invalid submission writes nothing');
  }
  console.log('store lifecycle tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
