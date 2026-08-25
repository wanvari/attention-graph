// IndexedDB wrapper for the `cognitive-trails` v4 database.
// Pure of Chrome APIs; injectable indexedDB so it runs in Node with
// fake-indexeddb. UMD like every lib module.
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'));
  } else {
    root.CTStore = factory(root.CTText);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText) {
  'use strict';

  const DB_NAME = 'cognitive-trails';
  const DB_VERSION = 4;
  const V3_DB_NAME = 'attentionGraphTrustAudit';
  const MIGRATION_FLAG = 'v3MigrationDone';

  const TEXT_RETENTION_MS = 30 * 24 * 3600 * 1000;
  const EMBEDDING_MAX_IDLE_MS = 45 * 24 * 3600 * 1000;

  // Keys the options page is allowed to persist. Everything else in the
  // settings store (watermark, pauseIntervals, ...) is written by the
  // extension itself, never from a form.
  const EDITABLE_SETTINGS = [
    'days', 'maxNewPagesPerRun', 'embeddingModel', 'chatModel',
    'denylist', 'llmChatDomains', 'notificationsEnabled', 'idleGatingEnabled'
  ];

  const SCHEMA = {
    visits: { keyPath: 'visitId', indexes: { byTime: 'visitTime', byDay: 'dayKey', byNormUrl: 'normalizedUrl' } },
    captures: { keyPath: 'captureId', indexes: { byNormUrl: 'normalizedUrl', byDay: 'dayKey', byStartedAt: 'startedAt' } },
    pages: { keyPath: 'normalizedUrl', indexes: { byLastSeen: 'lastSeen', byDomain: 'domain' } },
    embeddings: { keyPath: 'key', indexes: { byLastUsed: 'lastUsedAt' } },
    topics: { keyPath: 'topicId', indexes: { byState: 'state', byLastActive: 'lastActiveAt' } },
    memberships: { keyPath: ['topicId', 'normalizedUrl'], indexes: { byTopic: 'topicId', byPage: 'normalizedUrl', byLastDay: 'lastDay' } },
    topic_events: { keyPath: 'eventId', autoIncrement: true, indexes: { byDay: 'day', byTopic: 'topicId' } },
    daily_metrics: { keyPath: 'day', indexes: {} },
    baselines: { keyPath: 'metric', indexes: {} },
    runs: { keyPath: 'runId', indexes: { byStartedAt: 'startedAt' } },
    briefs: { keyPath: 'day', indexes: {} },
    transitions: { keyPath: ['day', 'sourceTopicId', 'targetTopicId'], indexes: { byDay: 'day' } },
    uncategorized: { keyPath: ['day', 'normalizedUrl'], indexes: { byDay: 'day' } },
    corrections: { keyPath: 'correctionId', indexes: {} },
    settings: { keyPath: 'key', indexes: {} }
  };

  function vecToBuf(vector) {
    if (vector instanceof ArrayBuffer) return vector;
    if (ArrayBuffer.isView(vector)) return vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength);
    return Float32Array.from(vector || []).buffer;
  }

  function bufToVec(buffer) {
    if (!buffer) return null;
    if (Array.isArray(buffer)) return Float32Array.from(buffer);
    if (ArrayBuffer.isView(buffer)) return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    return new Float32Array(buffer);
  }

  function createStore(options) {
    const opts = options || {};
    const idb = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    const KeyRange = opts.IDBKeyRange || (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null);
    const dbName = opts.dbName || DB_NAME;
    if (!idb) throw new Error('No indexedDB implementation available');

    let dbPromise = null;
    const stats = { transactions: 0 };
    let migrationError = null;

    function openRaw() {
      return new Promise((resolve, reject) => {
        const request = idb.open(dbName, DB_VERSION);
        request.onupgradeneeded = event => {
          const db = request.result;
          for (const [name, def] of Object.entries(SCHEMA)) {
            if (db.objectStoreNames.contains(name)) continue;
            const store = db.createObjectStore(name, {
              keyPath: def.keyPath,
              autoIncrement: !!def.autoIncrement
            });
            for (const [indexName, keyPath] of Object.entries(def.indexes)) {
              store.createIndex(indexName, keyPath);
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('cognitive-trails DB open blocked by another connection'));
      });
    }

    function db() {
      if (!dbPromise) dbPromise = openRaw();
      return dbPromise;
    }

    function tx(storeNames, mode, work) {
      return db().then(database => new Promise((resolve, reject) => {
        stats.transactions++;
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        const transaction = database.transaction(names, mode);
        const handles = {};
        for (const name of names) handles[name] = transaction.objectStore(name);
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
        try {
          result = work(handles, transaction);
        } catch (error) {
          try { transaction.abort(); } catch { /* already aborted */ }
          reject(error);
        }
      }));
    }

    function reqValue(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    const api = {
      DB_NAME: dbName,
      DB_VERSION,
      EDITABLE_SETTINGS,
      TEXT_RETENTION_MS,
      EMBEDDING_MAX_IDLE_MS,
      stats,
      vecToBuf,
      bufToVec,
      get migrationError() { return migrationError; },

      async open() {
        await db();
        await this.migrateFromV3();
        return this;
      },

      async close() {
        if (!dbPromise) return;
        const database = await dbPromise;
        database.close();
        dbPromise = null;
      },

      resetStats() { stats.transactions = 0; },

      async get(storeName, key) {
        let out = null;
        await tx(storeName, 'readonly', handles => {
          reqValue(handles[storeName].get(key)).then(v => { out = v === undefined ? null : v; });
        });
        return out;
      },

      async put(storeName, row) {
        return tx(storeName, 'readwrite', handles => { handles[storeName].put(row); });
      },

      async bulkPut(storeName, rows) {
        if (!rows || !rows.length) return 0;
        await tx(storeName, 'readwrite', handles => {
          for (const row of rows) handles[storeName].put(row);
        });
        return rows.length;
      },

      async delete(storeName, key) {
        return tx(storeName, 'readwrite', handles => { handles[storeName].delete(key); });
      },

      async clear(storeName) {
        return tx(storeName, 'readwrite', handles => { handles[storeName].clear(); });
      },

      async count(storeName) {
        let out;
        await tx(storeName, 'readonly', handles => {
          reqValue(handles[storeName].count()).then(v => { out = v; });
        });
        return out;
      },

      async getAll(storeName, query, count) {
        let out;
        await tx(storeName, 'readonly', handles => {
          reqValue(handles[storeName].getAll(query || null, count)).then(v => { out = v || []; });
        });
        return out;
      },

      async byIndex(storeName, indexName, query, count) {
        let out;
        await tx(storeName, 'readonly', handles => {
          reqValue(handles[storeName].index(indexName).getAll(query || null, count)).then(v => { out = v || []; });
        });
        return out;
      },

      range(lower, upper, exclusiveLower, exclusiveUpper) {
        if (!KeyRange) throw new Error('IDBKeyRange unavailable');
        if (lower !== undefined && upper !== undefined) {
          return KeyRange.bound(lower, upper, !!exclusiveLower, !!exclusiveUpper);
        }
        if (lower !== undefined) return KeyRange.lowerBound(lower, !!exclusiveLower);
        return KeyRange.upperBound(upper, !!exclusiveUpper);
      },

      // ---- settings ----------------------------------------------------

      async getSetting(key, fallback) {
        const rows = await this.getAll('settings');
        const row = rows.find(r => r.key === key);
        return row ? row.value : fallback;
      },

      async setSetting(key, value) {
        return this.put('settings', { key, value });
      },

      async getSettingsMap() {
        const rows = await this.getAll('settings');
        const out = {};
        for (const row of rows) out[row.key] = row.value;
        return out;
      },

      // Persist only allowlisted keys from a form submission.
      async saveEditableSettings(values) {
        const rows = [];
        for (const key of EDITABLE_SETTINGS) {
          if (values && values[key] !== undefined && values[key] !== null && values[key] !== '') {
            rows.push({ key, value: values[key] });
          }
        }
        await this.bulkPut('settings', rows);
        return rows;
      },

      // ---- stage commits (see spec §3.4) -------------------------------

      // The only non-idempotent stage. Everything or nothing.
      async registryCommit({ topics, memberships, removeMemberships, events }, testOptions) {
        const stores = ['topics', 'memberships', 'topic_events'];
        return tx(stores, 'readwrite', (handles, transaction) => {
          for (const topic of topics || []) handles.topics.put(topic);
          if (testOptions && testOptions.injectErrorAfterTopics) {
            transaction.abort();
            return;
          }
          for (const key of removeMemberships || []) handles.memberships.delete(key);
          for (const membership of memberships || []) handles.memberships.put(membership);
          for (const event of events || []) {
            const row = { ...event };
            delete row.eventId; // autoIncrement assigns it
            handles.topic_events.put(row);
          }
        });
      },

      // One transaction per day for the derived layers.
      //
      // Transitions are recomputed from every visit on the day, so replacing
      // them wholesale is correct. Exclusions are NOT: an incremental run only
      // reconsiders the pages it touched, so wiping the day and writing back
      // the partial set erased exclusion records the run never looked at.
      // Exclusions are therefore upserted, and only removed for pages this run
      // positively categorized (`categorizedUrls`).
      async dayCommit(day, { metrics, transitions, uncategorized, categorizedUrls, baselines, brief }) {
        const stores = ['daily_metrics', 'transitions', 'uncategorized', 'baselines', 'briefs'];
        return tx(stores, 'readwrite', handles => {
          if (metrics) handles.daily_metrics.put(metrics);
          if (transitions) {
            const range = KeyRange.bound([day, ''], [day, '￿']);
            handles.transitions.delete(range);
            for (const row of transitions) handles.transitions.put(row);
          }
          for (const url of categorizedUrls || []) {
            handles.uncategorized.delete([day, url]);
          }
          for (const row of uncategorized || []) handles.uncategorized.put(row);
          for (const baseline of baselines || []) handles.baselines.put(baseline);
          if (brief) handles.briefs.put(brief);
        });
      },

      // ---- embeddings --------------------------------------------------

      async getEmbedding(key) {
        const rows = await this.getAll('embeddings');
        return rows.find(r => r.key === key) || null;
      },

      async getEmbeddings(keys) {
        let out;
        await tx('embeddings', 'readonly', handles => {
          const results = new Array(keys.length).fill(null);
          keys.forEach((key, index) => {
            reqValue(handles.embeddings.get(key)).then(row => { results[index] = row || null; });
          });
          out = results;
        });
        return out;
      },

      async touchEmbeddings(keys, now) {
        const at = now || Date.now();
        return tx('embeddings', 'readwrite', handles => {
          for (const key of keys) {
            const request = handles.embeddings.get(key);
            request.onsuccess = () => {
              if (request.result) handles.embeddings.put({ ...request.result, lastUsedAt: at });
            };
          }
        });
      },

      // Prune embeddings idle > 45 days whose page has no membership at all.
      async pruneEmbeddings(nowMs, maxIdleMs) {
        const now = nowMs ?? Date.now();
        const cutoff = now - (maxIdleMs ?? EMBEDDING_MAX_IDLE_MS);
        const [memberships, pages, embeddings] = await Promise.all([
          this.getAll('memberships'),
          this.getAll('pages'),
          this.getAll('embeddings')
        ]);
        const memberUrls = new Set(memberships.map(m => m.normalizedUrl));
        const keysInUse = new Set(
          pages.filter(p => memberUrls.has(p.normalizedUrl) && p.embeddingKey).map(p => p.embeddingKey)
        );
        const doomed = embeddings
          .filter(row => (Number(row.lastUsedAt) || 0) < cutoff && !keysInUse.has(row.key))
          .map(row => row.key);
        if (doomed.length) {
          await tx('embeddings', 'readwrite', handles => {
            for (const key of doomed) handles.embeddings.delete(key);
          });
        }
        return doomed.length;
      },

      // Strip extractedText from captures older than the retention window.
      async retentionSweep(nowMs, retentionMs) {
        const cutoff = (nowMs ?? Date.now()) - (retentionMs ?? TEXT_RETENTION_MS);
        const captures = await this.getAll('captures');
        const stale = captures.filter(c => Number(c.startedAt) < cutoff && c.extractedText);
        if (stale.length) {
          await tx('captures', 'readwrite', handles => {
            for (const capture of stale) {
              handles.captures.put({ ...capture, extractedText: '' });
            }
          });
        }
        return stale.length;
      },

      // ---- destructive -------------------------------------------------

      async wipe() {
        const names = Object.keys(SCHEMA);
        await tx(names, 'readwrite', handles => {
          for (const name of names) handles[name].clear();
        });
      },

      // ---- migration from the v3 database ------------------------------

      async migrateFromV3() {
        const done = await this.getSetting(MIGRATION_FLAG);
        if (done) return { migrated: false, reason: 'already-done' };
        let hasOld = true;
        if (typeof idb.databases === 'function') {
          try {
            const list = await idb.databases();
            hasOld = list.some(info => info && info.name === V3_DB_NAME);
          } catch { hasOld = true; }
        }
        if (!hasOld) {
          await this.setSetting(MIGRATION_FLAG, { at: Date.now(), from: 'fresh-install' });
          return { migrated: false, reason: 'no-v3-db' };
        }
        try {
          const oldDb = await new Promise((resolve, reject) => {
            const request = idb.open(V3_DB_NAME);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const readAll = storeName => new Promise((resolve, reject) => {
            if (!oldDb.objectStoreNames.contains(storeName)) return resolve([]);
            const transaction = oldDb.transaction(storeName, 'readonly');
            const request = transaction.objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
          });
          const [oldEmbeddings, oldCorrections, oldSettings] = await Promise.all([
            readAll('embeddings'), readAll('corrections'), readAll('settings')
          ]);
          oldDb.close();
          if (opts._failMigrationWrite) throw new Error('injected migration failure');

          const now = Date.now();
          const embeddingRows = oldEmbeddings
            .filter(row => row && row.key && Array.isArray(row.value))
            .map(row => ({
              key: row.key,
              model: String(row.key).split('|')[0],
              vector: vecToBuf(row.value),
              dim: row.value.length,
              createdAt: Number(row.updatedAt) || now,
              lastUsedAt: Number(row.updatedAt) || now
            }));
          const kindMap = { topic: 'topic_label', transition: 'transition_type' };
          const correctionRows = oldCorrections
            .filter(row => row && (row.kind === 'topic' || row.kind === 'transition'))
            .map(row => ({
              correctionId: row.key || `${row.kind}:${row.targetId}`,
              kind: kindMap[row.kind],
              targetId: row.targetId || null,
              value: row.kind === 'topic' ? row.label : row.type,
              pageUrls: Array.isArray(row.pageUrls) ? row.pageUrls : [],
              createdAt: Number(row.updatedAt) || now
            }));
          const settingsRows = [];
          const userSettings = (oldSettings.find(r => r.key === 'user-settings') || {}).value || {};
          for (const key of ['days', 'embeddingModel', 'chatModel']) {
            if (userSettings[key] !== undefined) settingsRows.push({ key, value: userSettings[key] });
          }

          // The v3 snapshot analysis is deliberately NOT imported: its topics
          // have no stable identity and would seed the registry with
          // unvalidated state. Fresh registry, preserved embedding cache.
          await tx(['embeddings', 'corrections', 'settings'], 'readwrite', handles => {
            for (const row of embeddingRows) handles.embeddings.put(row);
            for (const row of correctionRows) handles.corrections.put(row);
            for (const row of settingsRows) handles.settings.put(row);
            handles.settings.put({
              key: MIGRATION_FLAG,
              value: { at: now, embeddings: embeddingRows.length, corrections: correctionRows.length }
            });
          });
          await new Promise(resolve => {
            const request = idb.deleteDatabase(V3_DB_NAME);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          });
          return { migrated: true, embeddings: embeddingRows.length, corrections: correctionRows.length };
        } catch (error) {
          // Leave the v3 DB untouched so nothing is lost; surface the failure.
          migrationError = error;
          return { migrated: false, reason: 'error', error: String(error && error.message || error) };
        }
      }
    };

    return api;
  }

  return { createStore, SCHEMA, DB_NAME, DB_VERSION, V3_DB_NAME, EDITABLE_SETTINGS, vecToBuf, bufToVec };
});
