// Durable capture buffering for the service worker.
//
// A service worker is torn down whenever Chrome feels like it, taking its
// globals with it. Two rules follow, and both were violated by the first
// version of this code:
//   1. Never clear the buffer before the write resolves, and never swallow a
//      write failure — the rows must stay queued for the next attempt.
//   2. Never tell the content script its text is stored until it actually is.
//      The text is sent once per capture; a premature acknowledgement means it
//      is gone for good.
// Flushes are serialized so two of them cannot interleave their
// read-modify-write of the same capture row.
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'));
  } else {
    root.CTCaptureBuffer = factory(root.CTText);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText) {
  'use strict';

  const FLUSH_AT_PENDING = 50;

  function createCaptureBuffer(deps) {
    const store = deps.store;
    const buffer = new Map();       // captureId -> capture pending a durable write
    let chain = Promise.resolve();
    const stats = { flushes: 0, failures: 0, written: 0 };

    function add(capture) {
      if (!capture || !capture.captureId) return false;
      const existing = buffer.get(capture.captureId);
      // A later update legitimately omits the text; do not lose it.
      const merged = { ...existing, ...capture };
      if (capture.extractedText === undefined && existing && existing.extractedText !== undefined) {
        merged.extractedText = existing.extractedText;
      }
      buffer.set(capture.captureId, merged);
      return true;
    }

    async function doFlush() {
      if (!buffer.size) return { written: 0 };
      stats.flushes++;
      const pending = Array.from(buffer.entries());
      const rows = pending.map(([, capture]) => ({
        ...capture,
        dayKey: CTText.dayKeyFromMs(capture.startedAt)
      }));
      try {
        for (const row of rows) {
          if (row.extractedText === undefined) {
            const existing = await store.get('captures', row.captureId);
            row.extractedText = existing ? existing.extractedText : '';
          }
        }
        await store.bulkPut('captures', rows);
      } catch (error) {
        // Keep everything buffered so the next flush retries it.
        stats.failures++;
        return { written: 0, error };
      }
      // Durable. Drop exactly what was written, so updates that arrived during
      // the await survive.
      for (const [captureId, capture] of pending) {
        if (buffer.get(captureId) === capture) buffer.delete(captureId);
      }
      stats.written += rows.length;
      return { written: rows.length };
    }

    function flush() {
      chain = chain.then(doFlush, doFlush);
      return chain;
    }

    // Returns whether this capture's text is now durable, which is what the
    // content script needs before it stops resending it.
    async function submit(capture) {
      if (!add(capture)) return { ok: false, textStored: false };
      const carriesText = capture.extractedText !== undefined;
      if (carriesText || buffer.size >= FLUSH_AT_PENDING) {
        const result = await flush();
        return {
          ok: !result.error,
          textStored: carriesText && !result.error && !buffer.has(capture.captureId)
        };
      }
      return { ok: true, textStored: false };
    }

    return {
      add,
      flush,
      submit,
      stats,
      get size() { return buffer.size; },
      has: captureId => buffer.has(captureId),
      clear: () => buffer.clear()
    };
  }

  return { FLUSH_AT_PENDING, createCaptureBuffer };
});
