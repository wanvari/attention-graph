// Durable intent sessions. The worker serializes every call through withWriter.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports ? factory(require('./text')) : factory(root.CTText);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTSessions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Text) {
  'use strict';
  const PREFIX = 'trail-session:';
  const NOTIFICATION = { type: 'basic', iconUrl: 'icon128.png', title: 'Cognitive Trails', message: 'Your session has ended. Open your recap when you are ready.' };
  function createManager(store, deps) {
    const now = deps.now || Date.now;
    const all = () => store.getAll('intent_sessions');
    async function schedule(session) {
      if (session.status === 'active' && session.durationMinutes !== null) await deps.alarm(PREFIX + session.sessionId, { when: session.startedAt + session.durationMinutes * 60000 });
    }
    async function notifyPending(session) {
      if (session.endReason !== 'timer' || session.notifiedAt || session.notificationDismissed || session.recapSeenAt) return;
      try {
        await deps.notify(PREFIX + session.sessionId, NOTIFICATION);
        await store.put('intent_sessions', { ...session, notifiedAt: now() });
      } catch { /* persisted completion remains available; reconciliation retries */ }
    }
    async function end(sessionId, reason = 'user') {
      const session = await store.get('intent_sessions', sessionId);
      if (!session) throw new Error('Session no longer exists');
      if (session.status === 'complete') return session;
      const flushed = await deps.flush();
      if (flushed?.error) throw new Error('Could not save the latest capture. Please retry.');
      const deadline = session.durationMinutes === null ? Infinity : session.startedAt + session.durationMinutes * 60000;
      const timedOut = now() >= deadline;
      const complete = { ...session, status: 'complete', endedAt: Math.max(session.startedAt, Math.min(now(), deadline)),
        completedAt: now(), endReason: timedOut ? 'timer' : reason };
      await store.put('intent_sessions', complete);
      await deps.clearAlarm(PREFIX + sessionId);
      if (reason !== 'capture-paused') await notifyPending(complete);
      else if (timedOut) await store.put('intent_sessions', { ...complete, notificationDismissed: true });
      return complete;
    }
    async function reconcile() {
      for (const session of await all()) {
        if (session.status === 'active') {
          if (session.durationMinutes !== null && session.startedAt + session.durationMinutes * 60000 <= now()) await end(session.sessionId, 'timer');
          else await schedule(session);
        } else await notifyPending(session);
      }
      return (await all()).find(s => s.status === 'active') || null;
    }
    async function start(input) {
      await reconcile();
      const active = (await all()).find(s => s.status === 'active');
      if (active) return { ok: false, reason: 'session-active', session: active };
      const intervals = await store.getSetting('pauseIntervals', []);
      if (intervals.some(i => i.end == null)) return { ok: false, reason: 'capture-paused' };
      const topic = typeof input.topicId === 'string' && await store.get('topics', input.topicId);
      if (!topic || topic.state === 'retired') throw new Error('Choose an available trail');
      if (![25, 50, 90, null].includes(input.durationMinutes)) throw new Error('Choose 25, 50, 90 minutes or untimed');
      if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000)) throw new Error('Session notes must be at most 1,000 characters');
      const name = await store.get('corrections', `trail:${topic.topicId}`);
      const session = { sessionId: Text.uuid(), topicId: topic.topicId, targetLabel: name?.value?.name || topic.label,
        startedAt: now(), durationMinutes: input.durationMinutes, note: (input.note || '').trim(), status: 'active', endedAt: null,
        endReason: null, notifiedAt: null, recapSeenAt: null };
      await store.put('intent_sessions', session);
      await schedule(session);
      return { ok: true, session };
    }
    async function seen(id) {
      const session = await store.get('intent_sessions', id);
      if (!session) throw new Error('Session no longer exists');
      await store.put('intent_sessions', { ...session, recapSeenAt: now() });
      await deps.clearNotification(PREFIX + id);
      return { ok: true };
    }
    async function clear() {
      for (const session of await all()) {
        await deps.clearAlarm(PREFIX + session.sessionId);
        await deps.clearNotification(PREFIX + session.sessionId);
      }
    }
    return { start, end, reconcile, seen, clear, all };
  }
  return { PREFIX, NOTIFICATION, createManager };
});
