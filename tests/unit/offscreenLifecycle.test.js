'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const h = { calls: [], closed: false, timers: new Map(), listener: null };
  const sandbox = {
    console: { error() {} }, Date,
    setTimeout: (fn, ms) => { const id = {}; h.timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => h.timers.delete(id),
    window: { close: () => { h.closed = true; h.calls.push('close'); } },
    chrome: { runtime: {
      onMessage: { addListener: fn => { h.listener = fn; } },
      sendMessage: (message, callback) => { h.calls.push(message.type); if (!options.missingReply) callback({ ok: true }); }
    } },
    CTStore: { createStore: () => ({ open: async () => {}, getSettingsMap: async () => ({}) }) },
    CTOllama: { DEFAULTS: {}, createClient: () => ({
      unloadEmbedModel: async () => { h.calls.push('unload-embed'); await options.embed?.(); },
      unloadChatModel: async () => { h.calls.push('unload-chat'); await options.chat?.(); }
    }) },
    CTPipeline: { createPipeline: () => ({ run: async () => { h.calls.push('run'); return options.run ? options.run() : { ok: true }; } }) }
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../offscreen/analysis.js'), 'utf8'), sandbox);
  h.dispatch = () => { let reply; h.listener({ type: 'RUN_PIPELINE', trigger: 'manual' }, {}, r => { reply = r; }); return reply; };
  return h;
}

(async () => {
  const model = deferred();
  const h = harness({ embed: () => model.promise });
  assert.equal(h.dispatch()?.started, true, 'offscreen explicitly acknowledges accepted work');
  await settle();
  assert.equal(h.dispatch()?.started, false, 'work during model cleanup is rejected, not silently dropped');
  assert.equal(h.calls.includes('RUN_COMPLETE'), false, 'worker completion is sent after model cleanup');
  assert.equal(h.closed, false);
  model.resolve(); await settle();
  assert.deepEqual(h.calls, ['run', 'unload-embed', 'unload-chat', 'RUN_COMPLETE', 'close']);
  assert.equal(h.timers.size, 0, 'completion acknowledgement cancels its timeout');

  const failed = harness({ run: async () => { throw Error('pipeline failed'); }, embed: async () => { throw Error('cleanup failed'); } });
  failed.dispatch(); await settle();
  assert.ok(failed.calls.includes('unload-chat'), 'both model cleanup attempts run even when one rejects');
  assert.equal(failed.closed, true, 'pipeline/cleanup errors cannot strand the offscreen host');

  const lostReply = harness({ missingReply: true });
  lostReply.dispatch(); await settle();
  assert.equal(lostReply.timers.size, 1, 'completion acknowledgement has a bounded timeout');
  assert.ok([...lostReply.timers.values()][0].ms <= 5000);
  for (const { fn } of lostReply.timers.values()) fn();
  await settle(); assert.equal(lostReply.closed, true, 'a missing worker reply cannot prevent shutdown');
  console.log('offscreen admission, cleanup ordering, failure and lost-reply recovery passed');
})().catch(error => { console.error(error); process.exit(1); });
