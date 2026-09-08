// Read-only diagnostics can inspect an installed v4/v5 record without migration.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports ? factory(require('./trails')) : factory(root.CTTrails);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTDiagnostics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Trails) {
  'use strict';
  async function loadExisting(idb = indexedDB) {
    const db = await new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('The database is busy with an older extension page. Reload Cognitive Trails in chrome://extensions, then retry.')); }, 8000);
      const request = idb.open('cognitive-trails');
      request.onupgradeneeded = () => request.transaction.abort();
      request.onerror = () => { clearTimeout(timer); reject(new Error('No readable local record yet.')); };
      request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
    });
    try {
      const names = Trails.TABLES.filter(name => db.objectStoreNames.contains(name));
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(names, 'readonly'), result = { schemaVersion: db.version };
        for (const name of names) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => { result[name] = request.result.map(({ extractedText, centroid, vector, ...row }) => row); };
        }
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || new Error('Could not read the record.'));
      });
    } finally { db.close(); }
  }
  function inspect(snapshot, query, now = Date.now()) {
    const text = String(query || '').trim().toLowerCase();
    if (!text) return [];
    const record = Trails.buildRecord(snapshot, { now });
    const urls = new Set(record.events.filter(e => `${e.url} ${e.title}`.toLowerCase().includes(text)).map(e => e.normalizedUrl));
    for (const p of snapshot.pages || []) if (`${p.url} ${p.title}`.toLowerCase().includes(text)) urls.add(p.normalizedUrl);
    return [...urls].slice(0, 50).map(url => {
      const events = record.events.filter(e => e.normalizedUrl === url), page = (snapshot.pages || []).find(p => p.normalizedUrl === url);
      const members = (snapshot.memberships || []).filter(m => m.normalizedUrl === url);
      return { url, title: page?.title || events[0]?.title || url, schemaVersion: snapshot.schemaVersion,
        stored: { pageEstimatedMs: page?.dwellMs ?? null, pageVisitCount: page?.visitCount ?? null,
          visitEstimatedMs: (snapshot.visits || []).filter(v => v.normalizedUrl === url).reduce((n, v) => n + (v.dwellMs || 0), 0),
          memberships: members.map(m => ({ topicId: m.topicId, pageEstimatedMs: m.dwellMs ?? null,
            entireTrailEstimatedMs: (snapshot.topics || []).find(t => t.topicId === m.topicId)?.totalDwellMs ?? null })) },
        corrected: { pageEstimatedMs: Trails.estimateMs(events), visits: events.length,
          events: events.map(e => ({ at: e.time, estimatedMs: e.dwellMs, timing: e.timingMethod, grouping: e.groupingReason, topicIds: e.topicIds })) },
        captures: (snapshot.captures || []).filter(c => c.normalizedUrl === url).map(c => ({ startedAt: c.startedAt, updatedAt: c.updatedAt, endedAt: c.endedAt, activeMs: c.activeMs, timestampedIntervals: c.activityIntervals?.length ?? null })) };
    });
  }
  return { loadExisting, inspect };
});
