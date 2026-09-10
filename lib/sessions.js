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
      if (session.endReason !== 'timer' || session.notifiedAt || session.notificationDismissed || session.recapSeenAt) return session;
      try {
        await deps.notify(PREFIX + session.sessionId, NOTIFICATION);
        const notified = { ...session, notifiedAt: now() };
        await store.put('intent_sessions', notified);
        return notified;
      } catch { /* persisted completion remains available; reconciliation retries */ }
      return session;
    }
    async function settleComplete(session) {
      // Completion and dismissal are committed before touching browser APIs.
      // Successful side effects get durable markers; failures retry after a
      // worker restart without reopening the session or losing its boundary.
      if (!session.alarmCleared) try {
        await deps.clearAlarm(PREFIX + session.sessionId);
        const cleared = { ...session, alarmCleared: true };
        await store.put('intent_sessions', cleared); session = cleared;
      } catch { /* reconciliation retries cleanup */ }
      if (session.notificationDismissed || session.recapSeenAt) {
        if (!session.notificationCleared) try {
          await deps.clearNotification(PREFIX + session.sessionId);
          const cleared = { ...session, notificationCleared: true };
          await store.put('intent_sessions', cleared); session = cleared;
        } catch { /* reconciliation retries cleanup */ }
        return session;
      }
      return notifyPending(session);
    }
    function pauseBoundary(session, intervals, at) {
      const starts = intervals.filter(p => Number.isFinite(p.start) && p.start <= at &&
        (p.end ?? Infinity) > Math.max(p.start, session.startedAt)).map(p => Math.max(p.start, session.startedAt));
      return starts.length ? Math.min(...starts) : null;
    }
    async function end(sessionId, reason = 'user') {
      const session = await store.get('intent_sessions', sessionId);
      if (!session) throw new Error('Session no longer exists');
      if (session.status === 'complete') return settleComplete(session);
      const flushed = await deps.flush();
      if (flushed?.error) throw new Error('Could not save the latest capture. Please retry.');
      const at = now(), pauseAt = pauseBoundary(session, await store.getSetting('pauseIntervals', []), at);
      const boundary = pauseAt ?? at;
      const paused = pauseAt !== null || reason === 'capture-paused';
      const deadline = session.durationMinutes === null ? Infinity : session.startedAt + session.durationMinutes * 60000;
      const timedOut = boundary >= deadline;
      const complete = { ...session, status: 'complete', endedAt: Math.max(session.startedAt, Math.min(boundary, deadline)),
        completedAt: at, endReason: timedOut ? 'timer' : paused ? 'capture-paused' : reason,
        ...(paused ? { notificationDismissed: true } : {}) };
      await store.put('intent_sessions', complete);
      return settleComplete(complete);
    }
    async function reconcile() {
      const intervals = await store.getSetting('pauseIntervals', []);
      for (const session of await all()) {
        if (session.status === 'active') {
          if (pauseBoundary(session, intervals, now()) !== null) await end(session.sessionId, 'capture-paused');
          else if (session.durationMinutes !== null && session.startedAt + session.durationMinutes * 60000 <= now()) await end(session.sessionId, 'timer');
          else await schedule(session);
        } else await settleComplete(session);
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
      if (session.status !== 'complete') throw new Error('Session is still active');
      const seen = { ...session, recapSeenAt: now() };
      await store.put('intent_sessions', seen);
      await settleComplete(seen);
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
