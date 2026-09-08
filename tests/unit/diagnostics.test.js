'use strict';
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const D = require('../../lib/diagnostics'), S = require('../../lib/store');
(async () => {
 const idb = new IDBFactory();
 const old = await new Promise((resolve, reject) => {
   const request = idb.open('cognitive-trails', 4);
   request.onupgradeneeded = () => {
     request.result.createObjectStore('visits', { keyPath: 'visitId' });
     request.result.createObjectStore('captures', { keyPath: 'captureId' });
   };
   request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
 });
 const url = 'https://status.example.test/';
 await new Promise(resolve => {
   const tx = old.transaction(['visits', 'captures'], 'readwrite');
   tx.objectStore('visits').put({ visitId: 'a', url, normalizedUrl: url, title: 'Service Status', visitTime: 1000, dwellMs: 805 * 60000 });
   tx.objectStore('captures').put({ captureId: 'b', url, normalizedUrl: url, startedAt: 1000, endedAt: 8000, activeMs: 7000, extractedText: 'PRIVATE BODY' });
   tx.oncomplete = resolve;
 });
 const snap = await D.loadExisting(idb);
 assert.equal(snap.schemaVersion, 4, 'diagnostics do not migrate');
 assert.ok(!('extractedText' in snap.captures[0]));
 const result = D.inspect(snap, 'status', 100000);
 assert.equal(result[0].stored.visitEstimatedMs, 805 * 60000);
 assert.equal(result[0].corrected.pageEstimatedMs, 7000);
 assert.equal(old.version, 4);
 // An old page blocking upgrade must report an actionable error, then permit
 // retry after that page closes, without a leaked successful connection.
 const store = S.createStore({ indexedDB: idb, IDBKeyRange });
 await assert.rejects(store.open(), /Reload Cognitive Trails/);
 old.close();
 await store.open();
 assert.equal((await store.get('visits', 'a')).visitId, 'a');
 await store.put('intent_sessions', { sessionId: 'preserved', status: 'active', startedAt: 1000 });
 assert.equal((await store.getAll('intent_sessions')).length, 1);
 await store.close();
 await assert.rejects(D.loadExisting(new IDBFactory()), /No readable/);
 console.log('read-only legacy diagnostics, privacy, blocked migration recovery and schema 5 preservation passed');
})().catch(error => { console.error(error); process.exit(1); });
