'use strict';
// Execute the real worker and its message/alarm wiring. Delayed IndexedDB,
// health checks and maintenance exercise the asynchronous wipe barrier.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const CTStore = require('../../lib/store.js');
const CTOllama = require('../../lib/ollama.js');
const root = path.resolve(__dirname, '../..');
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

async function harness() {
  const store = CTStore.createStore({ indexedDB: new IDBFactory(), IDBKeyRange });
  await store.open();
  const handlers = {};
  const events = [];
  const storage = {};
  const h = { store, handlers, events, storage, hasOffscreen: false, idleState: 'idle', fetch: null, failClose: false };
  const event = name => ({ addListener(fn) { handlers[name] = fn; } });
  const chrome = {
    runtime: {
      id: 'test-extension', onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'),
      getURL: value => `chrome-extension://test-extension/${value}`,
      getContexts: async () => h.hasOffscreen ? [{}] : [],
      sendMessage: async message => { events.push(message.type); }
    },
    storage: { local: {
      set: async values => { Object.assign(storage, values); },
      clear: async () => { for (const key of Object.keys(storage)) delete storage[key]; }
    } },
    declarativeNetRequest: { updateDynamicRules: async () => {} },
    alarms: { create() {}, onAlarm: event('alarm') },
    idle: { queryState: (_, reply) => reply(h.idleState) },
    offscreen: {
      createDocument: async () => { h.hasOffscreen = true; events.push('create'); },
      closeDocument: async () => {
        if (h.failClose) throw new Error('close failed');
        h.hasOffscreen = false;
        events.push('close');
      }
    },
    notifications: { onClicked: event('notification'), create() {} },
    action: { onClicked: event('action') },
    history: { search: (_, reply) => reply([]), getVisits: (_, reply) => reply([]) },
    tabs: {}, windows: {}
  };
  const sandbox = {
    chrome, navigator: {}, console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: (...args) => h.fetch ? h.fetch(...args) : Promise.resolve({ ok: true, json: async () => ({ models: [CTOllama.DEFAULTS.embeddingModel, CTOllama.DEFAULTS.chatModel].map(name => ({ name })) }) }),
    CTStore: { createStore: () => store },
    CTText: require('../../lib/text.js'), CTPrivacy: require('../../lib/privacy.js'),
    CTCaptureBuffer: require('../../lib/captureBuffer.js'), CTOllama,
    CTTrails: require('../../lib/trails.js'), CTOllamaRules: require('../../lib/ollamaRules.js'), importScripts() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), sandbox);
  h.send = (message, sender = {}) => new Promise(resolve => handlers.message(message, sender, resolve));
  h.capture = (id, overrides = {}) => ({
    type: 'CAPTURE_UPDATE', capture: { captureId: id, url: `https://example.com/article?id=${id}`, title: 'Article', startedAt: Date.now() - 5000,
      updatedAt: Date.now(), activeMs: 4000, textHash: 'hash', textLength: 20, extractedText: 'Some useful material', ...overrides }
  });
  return h;
}

(async () => {
  {
    const h = await harness();
    const entered = deferred(), gate = deferred();
    const put = h.store.bulkPut.bind(h.store);
    h.store.bulkPut = async (...args) => { entered.resolve(); await gate.promise; return put(...args); };
    const writing = h.send(h.capture('flight'));
    await entered.promise;
    const deleting = h.send({ type: 'DELETE_EVERYTHING' });
    const late = await h.send(h.capture('late'));
    assert.strictEqual(late.ok, false, 'wipe refuses new capture messages immediately');
    gate.resolve();
    await writing;
    assert.strictEqual((await deleting).ok, true);
    assert.strictEqual((await h.store.getAll('captures')).length, 0, 'in-flight capture cannot resurrect after wipe');
    assert.strictEqual(h.storage.ctPaused, true, 'deletion leaves sensors paused');
    const cutoff = await h.store.getSetting('historyImportAfter');
    assert.ok(cutoff > 0, 'deletion remembers only the future-history cutoff');
    await h.send({ type: 'SET_CAPTURE_PAUSED', paused: false });
    assert.strictEqual((await h.send(h.capture('old', { startedAt: cutoff - 1 }))).ok, false, 'delayed old capture still rejected after resume');
  }
  {
    const h = await harness();
    await h.send(h.capture('terminal'));
    const message = h.capture('terminal', { activeMs: 4800, endedAt: Date.now() });
    delete message.capture.extractedText;
    message.final = true;
    assert.strictEqual((await h.send(message)).ok, true);
    assert.ok((await h.store.get('captures', 'terminal')).endedAt, 'final state is durable without an alarm or explicit flush');
    assert.strictEqual((await h.send(h.capture('secret', { url: 'https://example.com/#/login?token=FAKE' }))).ok, false, 'worker rechecks raw sensitive routes');
    assert.strictEqual((await h.send(h.capture('private'), { tab: { incognito: true } })).ok, false);
    await h.send(h.capture('safe', { url: 'https://example.com/watch?v=42&utm_source=test#anchor', normalizedUrl: 'untrusted' }));
    const row = await h.store.get('captures', 'safe');
    assert.strictEqual(row.url, 'https://example.com/watch?v=42');
    assert.strictEqual(row.normalizedUrl, row.url, 'worker derives identity instead of trusting supplied metadata');
  }
  {
    const h = await harness();
    const entered = deferred(), gate = deferred();
    h.fetch = async () => { entered.resolve(); await gate.promise; return { ok: true, json: async () => ({ models: [CTOllama.DEFAULTS.embeddingModel, CTOllama.DEFAULTS.chatModel].map(name => ({ name })) }) }; };
    const starting = h.send({ type: 'RUN_PIPELINE_MANUAL' });
    await entered.promise;
    const deleting = h.send({ type: 'DELETE_EVERYTHING' });
    assert.strictEqual((await h.send({ type: 'RUN_PIPELINE_MANUAL' })).started, false, 'new starts blocked while deleting');
    gate.resolve();
    await starting;
    await deleting;
    assert.strictEqual(h.hasOffscreen, false, 'a start already awaiting health cannot leave a writer after deletion');
    assert.ok(h.events.indexOf('close') > h.events.indexOf('create'));
  }
  {
    const h = await harness();
    const entered = deferred(), gate = deferred();
    h.store.retentionSweep = async () => { entered.resolve(); await gate.promise; return 0; };
    h.handlers.alarm({ name: 'retention' });
    await entered.promise;
    const deleting = h.send({ type: 'DELETE_EVERYTHING' });
    h.handlers.alarm({ name: 'retention' });
    gate.resolve();
    await deleting;
    assert.ok((await h.store.getSetting('lastRetentionSweep')) == null, 'maintenance completes before wipe and cannot write a late setting');
  }
  {
    const h = await harness();
    await h.send(h.capture('keep'));
    h.hasOffscreen = true;
    h.failClose = true;
    assert.strictEqual((await h.send({ type: 'DELETE_EVERYTHING' })).ok, false, 'failure to stop analysis is not reported as a successful wipe');
    assert.ok(await h.store.get('captures', 'keep'), 'do not wipe beneath an unstoppable writer');
  }
  {
    const h = await harness();
    h.idleState = 'active';
    await h.store.setSetting('runBlockedSince', Date.now() - 10 * 86400000);
    await h.store.setSetting('testMode', true);
    await h.send({ type: 'TEST_FIRE_ALARM', alarm: 'daily' });
    assert.strictEqual(h.hasOffscreen, false, 'enabled idle gate never overrides an active laptop after starvation');
    const status = await h.send({ type: 'GET_STATUS' });
    assert.strictEqual(status.ollama, true);
    assert.strictEqual(status.health.reachable, true);
    assert.strictEqual(status.health.missing.length, 0);
  }
  {
    const h = await harness();
    await h.store.put('topics', { topicId: 'note-topic', label: 'Suggested subject' });
    const row = { kind: 'trail_metadata', targetId: 'note-topic', value: { name: 'My name', note: 'Continue here', pinned: true } };
    assert.equal((await h.send({ type: 'SAVE_TRAIL_METADATA', row })).ok, true);
    assert.equal((await h.store.get('corrections', 'trail:note-topic')).value.note, 'Continue here');
    assert.equal((await h.store.get('topics', 'note-topic')).label, 'Suggested subject');
    assert.equal((await h.send({ type: 'SAVE_PREFERENCES', values: { days: 7, watermark: 1 } })).ok, true);
    assert.equal(await h.store.getSetting('watermark'), undefined);
    assert.equal((await h.send({ type: 'SAVE_PREFERENCES', values: { maxNewPagesPerRun: 1000000 } })).ok, false);
    await h.send({ type: 'DELETE_EVERYTHING' });
    assert.equal((await h.send({ type: 'SAVE_TRAIL_METADATA', row })).ok, false, 'stale page cannot resurrect a deleted note');
    assert.equal((await h.store.getAll('corrections')).length, 0);
  }
  {
    const h = await harness();
    assert.equal((await h.send({ type: 'RUN_PIPELINE_MANUAL' })).started, true);
    assert.equal((await h.store.getAll('runs')).length, 0, 'offscreen has not yet written its run row');
    const second = await h.send({ type: 'RUN_PIPELINE_MANUAL' });
    assert.equal(second.started, false, 'duplicate dispatch is refused before the first heartbeat');
    assert.equal(h.events.filter(e => e === 'RUN_PIPELINE').length, 1);
  }
  console.log('background lifecycle tests passed');
})().catch(error => { console.error(error); process.exit(1); });
