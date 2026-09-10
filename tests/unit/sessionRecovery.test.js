'use strict';
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const Store = require('../../lib/store'), Sessions = require('../../lib/sessions');

async function withManager(test) {
  const store = Store.createStore({ indexedDB: new IDBFactory(), IDBKeyRange }); await store.open();
  const state = { now: 1000000, failAlarm: false, failNotificationClear: false, alarms: new Map(), notifications: new Map() };
  const deps = { now: () => state.now, flush: async () => ({}),
    alarm: async (id, value) => state.alarms.set(id, value),
    clearAlarm: async id => { if (state.failAlarm) throw Error('alarm API temporarily unavailable'); state.alarms.delete(id); },
    notify: async (id, value) => state.notifications.set(id, value),
    clearNotification: async id => { if (state.failNotificationClear) throw Error('notification API temporarily unavailable'); state.notifications.delete(id); }
  };
  await store.put('topics', { topicId: 'topic', label: 'Private topic', state: 'active' });
  const manager = Sessions.createManager(store, deps);
  try { await test({ store, state, manager, restart: () => Sessions.createManager(store, deps) }); }
  finally { await store.close(); }
}

(async () => {
  for (const resumed of [false, true]) await withManager(async ({ store, state, manager, restart }) => {
    const { session } = await manager.start({ topicId: 'topic', durationMinutes: null });
    // A worker dies after persisting pause but before ending the session.
    const pauseAt = state.now + 5000; state.now += 60000;
    await store.setSetting('pauseIntervals', [{ start: pauseAt, end: resumed ? pauseAt + 20000 : null }]);
    assert.equal(await restart().reconcile(), null, 'startup recovers an interrupted pause, including one already resumed');
    const complete = await store.get('intent_sessions', session.sessionId);
    assert.equal(complete.status, 'complete'); assert.equal(complete.endReason, 'capture-paused');
    assert.equal(complete.endedAt, pauseAt, 'recap ends at the persisted pause, not recovery time');
    assert.equal(state.notifications.size, 0);
  });

  for (const pauseMinute of [5, 26]) await withManager(async ({ store, state, manager, restart }) => {
    const { session } = await manager.start({ topicId: 'topic', durationMinutes: 25 });
    const pauseAt = state.now + pauseMinute * 60000; state.now += 30 * 60000;
    await store.setSetting('pauseIntervals', [{ start: pauseAt, end: null }]);
    state.failAlarm = true;
    await restart().reconcile();
    let complete = await store.get('intent_sessions', session.sessionId);
    assert.equal(complete.status, 'complete', 'an alarm API failure cannot undo durable completion');
    assert.equal(complete.endedAt, Math.min(pauseAt, session.startedAt + 25 * 60000));
    assert.equal(complete.endReason, pauseMinute < 25 ? 'capture-paused' : 'timer');
    assert.equal(state.notifications.size, 0, 'pause notification suppression is durable before external cleanup');
    state.failAlarm = false; await restart().reconcile();
    assert.equal(state.alarms.size, 0, 'completed-session alarm cleanup retries after restart');
    assert.equal(state.notifications.size, 0, 'reconciliation never later emits the suppressed notification');
    complete = await store.get('intent_sessions', session.sessionId);
    assert.equal((await manager.end(session.sessionId)).endedAt, complete.endedAt, 'repeated completion is idempotent');
  });

  await withManager(async ({ store, state, manager, restart }) => {
    const { session } = await manager.start({ topicId: 'topic', durationMinutes: 25 });
    state.now += 26 * 60000; await manager.reconcile();
    assert.equal(state.notifications.size, 1);
    state.failNotificationClear = true;
    await manager.seen(session.sessionId);
    assert.ok((await store.get('intent_sessions', session.sessionId)).recapSeenAt);
    state.failNotificationClear = false; await restart().reconcile();
    assert.equal(state.notifications.size, 0, 'seen recap cleanup retries, rather than leaving a stale notification');
  });
  console.log('session recovery across partial pause, alarm and notification failures passed');
})().catch(error => { console.error(error); process.exit(1); });
