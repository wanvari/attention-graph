'use strict';
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange, IDBObjectStore } = require('fake-indexeddb');
const S = require('../../lib/store'), I = require('../../lib/integrity');
const project = ({ extractedText, vector, centroid, ...row }) => row;
(async () => {
  const idb = new IDBFactory();
  const old = await new Promise((resolve, reject) => {
    const request = idb.open('cognitive-trails', 5);
    request.onupgradeneeded = () => { for (const [n, def] of Object.entries(S.SCHEMA)) {
      const s = request.result.createObjectStore(n, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
      for (const [i, key] of Object.entries(def.indexes)) s.createIndex(i, key);
    }};
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const source = { captures: [{ captureId: 'c', url: 'https://a.example.test/', normalizedUrl: 'https://a.example.test/', startedAt: 1000, endedAt: 3500, activeMs: 2500, activityIntervals: [[1000, 3500]], extractedText: 'retained '.repeat(1000) }],
    topics: [{ topicId: 't', label: 'Existing', centroid: S.vecToBuf([0.3, 0.7]) }], embeddings: [{ key: 'm|1', model: 'm', vector: S.vecToBuf([0.3, 0.7]) }] };
  await new Promise(resolve => { const tx = old.transaction([...Object.keys(source), 'settings'], 'readwrite');
    for (const [name, rows] of Object.entries(source)) for (const row of rows) tx.objectStore(name).put(row);
    for (const [key, value] of [['v3MigrationDone', true], ['urlIdentityVersion', 2]]) tx.objectStore('settings').put({ key, value });
    tx.oncomplete = resolve;
  }); old.close();
  const a = S.createStore({ indexedDB: idb, IDBKeyRange }), b = S.createStore({ indexedDB: idb, IDBKeyRange });
  await a.open(); await b.open();
  for (const [name, rows] of Object.entries(source)) assert.deepEqual(await a.getAll(name), rows, 'schema upgrade preserves every original byte/field');
  const names = [...Object.keys(source), 'settings', 'visits', 'corrections', 'intent_sessions'];
  const calls = [], getAll = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function(...args) { calls.push(this.name); return getAll.apply(this, args); };
  try {
    const first = await a.readSnapshot(names, { reuseUnchanged: true });
    for (const [name, rows] of Object.entries(source)) assert.deepEqual(first[name], rows.map(project));
    assert.ok(!calls.some(n => ['captures', 'topics', 'embeddings'].includes(n)), 'metadata reads never deserialize raw text/vector stores');
    calls.length = 0; assert.equal(await a.readSnapshot(names, { reuseUnchanged: true }), first);
    assert.deepEqual(calls, ['_snapshot_revisions'], 'unchanged refresh reads only revisions');
    await b.put('captures', { ...source.captures[0], activeMs: 3000, extractedText: 'a revised private body' });
    calls.length = 0; const second = await a.readSnapshot(names, { reuseUnchanged: true });
    assert.equal(second.captures[0].activeMs, 3000); assert.equal(second.topics, first.topics);
    assert.deepEqual(calls, ['_snapshot_revisions', '_metadata_captures']);
    assert.equal((await a.get('captures', 'c')).extractedText, 'a revised private body');
    const revision = await a.readSnapshot(names, { reuseUnchanged: true });
    await assert.rejects(b.registryCommit({ topics: [{ topicId: 't', label: 'Must roll back' }] }, { injectErrorAfterTopics: true }));
    assert.equal(await a.readSnapshot(names, { reuseUnchanged: true }), revision, 'abort rolls back source, projection and revision together');
    for (const [table, row] of [['visits', { visitId: 'v' }], ['corrections', { correctionId: 'x' }], ['intent_sessions', { sessionId: 's', status: 'active' }], ['settings', { key: 'pauseIntervals', value: [{ start: 2000 }] }]]) {
      const before = await a.readSnapshot(names, { reuseUnchanged: true }); await b.put(table, row);
      const after = await a.readSnapshot(names, { reuseUnchanged: true }); assert.notEqual(after[table], before[table]);
    }
    await b.retentionSweep(100000, 0); assert.equal((await a.get('captures', 'c')).extractedText, '');
    assert.equal((await a.readSnapshot(names)).captures[0].activeMs, 3000);
    await b.delete('captures', IDBKeyRange.bound('a', 'z')); assert.equal((await a.readSnapshot(names)).captures.length, 0);
    await b.setSetting('evidenceRepairVersion', 3); calls.length = 0;
    assert.equal(await I.repair(b, { once: true }), null);
    assert.deepEqual(calls, [], 'completed startup repair does not load any full table');
    await b.wipe(); const empty = await a.readSnapshot(names, { reuseUnchanged: true });
    assert.ok(Object.values(empty).every(rows => rows.length === 0), 'wipe also clears projections and invalidates another reader');
    await b.put('captures', source.captures[0]);
    assert.deepEqual((await a.readSnapshot(names, { reuseUnchanged: true })).captures, source.captures.map(project), 'post-deletion writes cannot reuse an old snapshot');
  } finally { IDBObjectStore.prototype.getAll = getAll; await a.close(); await b.close(); }
  console.log('schema-5 projection migration, raw preservation, cross-context revision reuse, abort, retention, ranges, repair gate and deletion passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
