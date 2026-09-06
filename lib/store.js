// IndexedDB wrapper for the `cognitive-trails` v4 database.
// Pure of Chrome APIs; injectable indexedDB so it runs in Node with
// fake-indexeddb. UMD like every lib module.
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'), require('./privacy.js'));
  } else {
    root.CTStore = factory(root.CTText, root.CTPrivacy);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText, CTPrivacy) {
  'use strict';

  const DB_NAME = 'cognitive-trails';
  const DB_VERSION = 5;
  const V3_DB_NAME = 'attentionGraphTrustAudit';
  const MIGRATION_FLAG = 'v3MigrationDone';

  const TEXT_RETENTION_MS = 30 * 24 * 3600 * 1000;
  const EMBEDDING_MAX_IDLE_MS = 45 * 24 * 3600 * 1000;

  // Keys the options page is allowed to persist. Everything else in the
  // settings store (watermark, pauseIntervals, ...) is written by the
  // extension itself, never from a form.
  const EDITABLE_SETTINGS = [
    'days', 'maxNewPagesPerRun', 'embeddingModel', 'chatModel',
    'denylist', 'llmChatDomains', 'notificationsEnabled', 'idleGatingEnabled',
    'dutyCycle', 'numThread'
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
    intent_sessions: { keyPath: 'sessionId', indexes: { byStatus: 'status', byStartedAt: 'startedAt' } },
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
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => { database.close(); dbPromise = null; };
          resolve(database);
        };
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
        await this.migrateUrlIdentities();
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

      // One consistent read for the user-facing record. Raw captured text and
      // vectors are not needed to browse or search metadata and never escape
      // through this projection. The analysis APIs still read the full rows.
      async readSnapshot(names) {
        const tables = [...new Set(names)].filter(name => SCHEMA[name]);
        const out = {};
        if (!tables.length) return out;
        await tx(tables, 'readonly', handles => {
          for (const name of tables) {
            const request = handles[name].getAll();
            request.onsuccess = () => {
              out[name] = request.result.map(row => {
                const { extractedText, centroid, vector, ...metadata } = row;
                return metadata;
              });
            };
          }
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

      // Read/transform/write in one transaction; no await between snapshot and
      // commit. This also makes a user's grouping correction race-safe.
      async updateEvidence(transform) {
        const names = ['visits', 'captures', 'pages', 'topics', 'memberships', 'corrections', 'settings', 'embeddings'];
        let result;
        await tx(names, 'readwrite', (handles, transaction) => {
          const snapshot = {}; let pending = names.length;
          for (const name of names) {
            const request = handles[name].getAll();
            request.onsuccess = () => {
              snapshot[name] = request.result;
              if (--pending) return;
              try {
                result = transform(snapshot);
                for (const key of result.removeMemberships || []) handles.memberships.delete(key);
                for (const table of names) for (const row of result[table] || []) handles[table].put(row);
              } catch (error) { transaction.abort(); }
            };
          }
        });
        return result?.audit || null;
      },

      // ---- settings ----------------------------------------------------

      async getSetting(key, fallback) {
        const row = await this.get('settings', key);
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
            const value = values[key];
            const bounds = { days: [1, 90], maxNewPagesPerRun: [1, 200], dutyCycle: [0.05, 1], numThread: [1, 16] };
            if (bounds[key] && (!Number.isFinite(value) || value < bounds[key][0] || value > bounds[key][1] || (key !== 'dutyCycle' && !Number.isInteger(value)))) throw new Error(`Invalid ${key}`);
            if (['notificationsEnabled', 'idleGatingEnabled'].includes(key) && typeof value !== 'boolean') throw new Error(`Invalid ${key}`);
            if (['denylist', 'llmChatDomains'].includes(key) && (!Array.isArray(value) || value.length > 500 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 250))) throw new Error(`Invalid ${key}`);
            if (['embeddingModel', 'chatModel'].includes(key) && (typeof value !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(value))) throw new Error(`Invalid ${key}`);
            rows.push({ key, value });
          }
        }
        await this.bulkPut('settings', rows);
        return rows;
      },

      // ---- stage commits (see spec §3.4) -------------------------------

      // The only non-idempotent stage. Everything or nothing.
      async registryCommit({ topics, memberships, removeMemberships, events, pages }, testOptions) {
        const stores = ['topics', 'memberships', 'topic_events', 'pages', 'corrections'];
        return tx(stores, 'readwrite', (handles, transaction) => {
          const request = handles.corrections.getAll();
          request.onsuccess = () => {
            const overridden = new Set(request.result.filter(r => r.kind === 'page_membership').map(r => r.targetId));
            for (const topic of topics || []) handles.topics.put(topic);
            if (testOptions && testOptions.injectErrorAfterTopics) { transaction.abort(); return; }
            for (const key of removeMemberships || []) if (!overridden.has(key[1])) handles.memberships.delete(key);
            for (const membership of memberships || []) if (!overridden.has(membership.normalizedUrl)) handles.memberships.put(membership);
            for (const page of pages || []) if (!overridden.has(page.normalizedUrl)) handles.pages.put(page);
            for (const event of events || []) { const row = { ...event }; delete row.eventId; handles.topic_events.put(row); }
          };
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
        return this.get('embeddings', key);
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

      // Repair old identities from the original visit URLs, not the last page
      // aggregate. All reads and writes share a transaction, including the
      // version marker, so two extension pages can safely open concurrently.
      // History is retained; affected inferred memberships are reprocessed.
      async migrateUrlIdentities() {
        const version = CTText.URL_IDENTITY_VERSION || 2;
        if (await this.getSetting('urlIdentityVersion') === version) return;
        const names = ['settings', 'visits', 'captures', 'pages', 'memberships', 'topics',
          'embeddings', 'daily_metrics', 'baselines', 'briefs', 'transitions', 'uncategorized'];
        return tx(names, 'readwrite', handles => {
          const gate = handles.settings.get('urlIdentityVersion');
          gate.onsuccess = () => {
            if (gate.result?.value === version) return;
            const sourceNames = ['settings', 'visits', 'captures', 'pages', 'memberships', 'topics', 'embeddings'];
            const rows = {};
            let remaining = sourceNames.length;
            for (const name of sourceNames) {
              const request = handles[name].getAll();
              request.onsuccess = () => {
                rows[name] = request.result;
                if (--remaining === 0) repair();
              };
            }
            function repair() {
              const settings = Object.fromEntries(rows.settings.map(r => [r.key, r.value]));
              const changed = new Set();
              const events = [];
              const captures = [];
              const acceptable = raw => CTText.sanitizeUrl(raw) &&
                (!CTPrivacy || !CTPrivacy.isExcluded(raw, settings.denylist));
              for (const name of ['visits', 'captures']) {
                const key = name === 'visits' ? 'visitId' : 'captureId';
                for (const row of rows[name]) {
                  const old = row.normalizedUrl;
                  if (!acceptable(row.url)) {
                    changed.add(old);
                    handles[name].delete(row[key]);
                    continue;
                  }
                  const url = CTText.sanitizeUrl(row.url);
                  const normalizedUrl = CTText.normalizeUrl(url);
                  if (normalizedUrl !== old) changed.add(old);
                  const updated = { ...row, url, normalizedUrl };
                  if (url !== row.url || normalizedUrl !== old) handles[name].put(updated);
                  (name === 'visits' ? events : captures).push(updated);
                }
              }
              for (const page of rows.pages) {
                if (!acceptable(page.url) || CTText.normalizeUrl(page.url) !== page.normalizedUrl) changed.add(page.normalizedUrl);
                else if (CTText.sanitizeUrl(page.url) !== page.url) handles.pages.put({ ...page, url: CTText.sanitizeUrl(page.url) });
              }
              const byIdentity = new Map();
              for (const event of events) {
                const entry = byIdentity.get(event.normalizedUrl) || [];
                entry.push(event);
                byIdentity.set(event.normalizedUrl, entry);
              }
              const impactedNew = new Set();
              for (const original of rows.visits.concat(rows.captures)) {
                if (changed.has(original.normalizedUrl) && acceptable(original.url)) impactedNew.add(CTText.normalizeUrl(original.url));
              }
              for (const old of changed) handles.pages.delete(old);
              for (const identity of impactedNew) {
                const visits = byIdentity.get(identity) || [];
                const observed = captures.filter(c => c.normalizedUrl === identity);
                const last = visits.slice().sort((a, b) => b.visitTime - a.visitTime)[0] ||
                  observed.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
                if (!last) continue;
                const times = visits.map(v => v.visitTime).concat(observed.map(c => c.startedAt));
                handles.pages.put({ normalizedUrl: identity, url: last.url, title: last.title,
                  domain: CTText.extractDomain(last.url), source: last.source || 'web',
                  firstSeen: Math.min(...times), lastSeen: Math.max(...times), visitCount: visits.length,
                  dwellMs: visits.reduce((n, v) => n + (v.dwellMs || 0), 0),
                  activeMs: observed.reduce((n, c) => n + (c.activeMs || 0), 0),
                  hadTitle: Boolean(last.title), embeddingKey: null, embeddingVariant: null,
                  needsEmbedding: true, needsClassification: true, classificationStatus: 'pending',
                  classificationReason: null, metricsDirty: true });
              }
              const affectedTopics = new Set();
              for (const member of rows.memberships) {
                if (changed.has(member.normalizedUrl) || impactedNew.has(member.normalizedUrl)) {
                  handles.memberships.delete([member.topicId, member.normalizedUrl]);
                  affectedTopics.add(member.topicId);
                }
              }
              const pages = new Map(rows.pages.map(p => [p.normalizedUrl, p]));
              const embeddings = new Map(rows.embeddings.map(e => [e.key, e]));
              for (const topic of rows.topics) {
                if (!affectedTopics.has(topic.topicId)) continue;
                const kept = rows.memberships.filter(m => m.topicId === topic.topicId &&
                  !changed.has(m.normalizedUrl) && !impactedNew.has(m.normalizedUrl));
                const vectors = kept.map(m => embeddings.get(pages.get(m.normalizedUrl)?.embeddingKey))
                  .filter(Boolean).map(e => { try { return bufToVec(e.vector); } catch { return null; } }).filter(v => v?.length && [...v].every(Number.isFinite));
                const updated = { ...topic, totalDwellMs: kept.reduce((n, m) => n + (m.dwellMs || 0), 0) };
                if (!kept.length) updated.state = 'retired';
                if (vectors.length && vectors.every(v => v.length === vectors[0].length)) {
                  const centroid = new Float32Array(vectors[0].length);
                  for (const v of vectors) for (let i = 0; i < v.length; i++) centroid[i] += v[i];
                  const norm = Math.sqrt(centroid.reduce((n, v) => n + v * v, 0));
                  if (norm > 0) { for (let i = 0; i < centroid.length; i++) centroid[i] /= norm; updated.centroid = vecToBuf(centroid); }
                }
                handles.topics.put(updated);
              }
              if (changed.size) {
                // These are disposable projections of retained visit evidence.
                // Do not display stale totals while the repair queue is pending.
                for (const name of ['daily_metrics', 'baselines', 'briefs', 'transitions', 'uncategorized']) handles[name].clear();
                for (const page of rows.pages) {
                  if (!changed.has(page.normalizedUrl) && !impactedNew.has(page.normalizedUrl)) handles.pages.put({ ...page, url: CTText.sanitizeUrl(page.url), metricsDirty: true });
                }
                handles.settings.put({ key: 'urlIdentityRepair', value: { at: Date.now(), affectedPages: changed.size,
                  message: 'Page identities were repaired from recorded URLs. Affected topic groupings will be rebuilt.' } });
              }
              handles.settings.put({ key: 'urlIdentityVersion', value: version });
            }
          };
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
