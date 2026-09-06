'use strict';
const assert = require('node:assert/strict'), { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const S = require('../../lib/store'), Sessions = require('../../lib/sessions');
(async () => {
  const store = S.createStore({ indexedDB: new IDBFactory(), IDBKeyRange }); await store.open();
  await store.put('topics', { topicId: 'private', label: 'PRIVATE TOPIC', state: 'active' });
  let now = 1000000, failNotify = false, failFlush = false;
  const alarms = new Map(), notifications = new Map();
  const deps = { now: () => now, flush: async () => failFlush ? { error: new Error('disk') } : {},
    alarm: async (id, value) => alarms.set(id, value), clearAlarm: async id => alarms.delete(id),
    notify: async (id, value) => { if (failNotify) throw Error('denied'); notifications.set(id, value); }, clearNotification: async id => notifications.delete(id) };
  let manager = Sessions.createManager(store, deps);
  for (const duration of [25, 50, 90, null]) {
    const result = await manager.start({ topicId: 'private', durationMinutes: duration, note: 'PRIVATE NOTE' });
    assert.equal(result.ok, true);
    assert.equal((await manager.start({ topicId: 'private', durationMinutes: 25 })).reason, 'session-active');
    assert.equal(alarms.has(Sessions.PREFIX + result.session.sessionId), duration !== null);
    now += 1000;
    await manager.end(result.session.sessionId); assert.equal(notifications.size, 0, 'manual end opens an in-app recap');
  }
  await assert.rejects(manager.start({ topicId: 'private', durationMinutes: 2 }), /Choose/);
  await assert.rejects(manager.start({ topicId: 'absent', durationMinutes: 25 }), /available/);
  const { session } = await manager.start({ topicId: 'private', durationMinutes: 25 });
  now += 30 * 60000; failFlush = true;
  await assert.rejects(manager.reconcile(), /save/);
  assert.equal((await store.get('intent_sessions', session.sessionId)).status, 'active');
  failFlush = false; failNotify = true;
  manager = Sessions.createManager(store, deps); await manager.reconcile();
  const complete = await store.get('intent_sessions', session.sessionId);
  assert.equal(complete.endedAt, session.startedAt + 25 * 60000, 'overdue startup uses planned deadline');
  assert.equal(complete.status, 'complete'); assert.equal(complete.notifiedAt, null);
  failNotify = false; await manager.reconcile();
  assert.equal(notifications.size, 1);
  assert.ok(!JSON.stringify([...notifications.values()]).includes('PRIVATE'));
  await manager.seen(session.sessionId); assert.equal(notifications.size, 0);
  const untimed = (await manager.start({ topicId: 'private', durationMinutes: null })).session;
  now += 86400000; await manager.reconcile();
  assert.equal((await store.get('intent_sessions', untimed.sessionId)).status, 'active');
  await manager.end(untimed.sessionId, 'capture-paused'); assert.equal(notifications.size, 0);
  await store.setSetting('pauseIntervals', [{ start: now, end: null }]);
  assert.equal((await manager.start({ topicId: 'private', durationMinutes: null })).reason, 'capture-paused');
  await manager.clear(); await store.wipe(); assert.equal((await manager.all()).length, 0); assert.equal(alarms.size, 0);
  await store.close(); console.log('durable sessions, restart, retry, pause and generic notification tests passed');
})().catch(e => { console.error(e); process.exit(1); });
