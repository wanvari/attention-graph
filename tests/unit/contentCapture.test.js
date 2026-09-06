'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');

function harness(url, html = '<main>A useful article about the material someone came here to read.</main>', delayedReplies = false) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let now = 1000000, clock = 0, visible = 'visible', focused = true, tick, changed;
  const messages = [], replies = [], inputs = {};
  w.Date.now = () => now;
  w.performance.now = () => clock;
  Object.defineProperty(w.document, 'visibilityState', { get: () => visible });
  w.document.hasFocus = () => focused;
  w.setInterval = fn => { tick = fn; return 1; };
  w.clearInterval = () => {};
  const add = w.addEventListener.bind(w);
  w.addEventListener = (type, fn, options) => { inputs[type] = fn; add(type, fn, options); };
  w.chrome = {
    runtime: {
      sendMessage: (message, reply) => {
        messages.push(JSON.parse(JSON.stringify(message)));
        if (delayedReplies) replies.push(reply);
        else reply({ ok: true, textStored: message.capture.extractedText !== undefined });
      }
    },
    storage: {
      local: { get: (_, reply) => reply({}) },
      onChanged: { addListener: fn => { changed = fn; } }
    }
  };
  for (const file of ['lib/privacy.js', 'lib/text.js', 'content/capture.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  return {
    dom, w, messages, replies,
    step(ms) { now += ms; clock += ms; tick(); },
    input() { inputs.pointerdown({ isTrusted: true }); },
    hide() { visible = 'hidden'; focused = false; w.document.dispatchEvent(new w.Event('visibilitychange')); },
    settings(values) { changed(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'local'); },
    end() { w.dispatchEvent(new w.Event('pagehide')); },
    last() { return messages[messages.length - 1]?.capture; }
  };
}

(async () => {
  {
    const h = harness('https://example.com/article');
    h.step(15000);
    assert.strictEqual(h.last().activeMs, 0, 'loading a page is not measured input');
    h.input();
    for (let i = 0; i < 5; i++) h.step(1000);
    h.hide();
    assert.strictEqual(h.last().activeMs, 5000, 'counts elapsed visible focused time following actual input');
    h.step(120000);
    h.end();
    assert.strictEqual(h.last().activeMs, 5000, 'hidden throttled timer does not add away time');
    h.dom.window.close();
  }
  {
    const h = harness('https://example.com/article');
    h.input();
    h.step(120000);
    assert.strictEqual(h.last().activeMs, 0, 'sleep gap outside input window adds no invented interaction');
    h.dom.window.close();
  }
  {
    const h = harness('https://example.com/#/login?token=FAKE');
    assert.strictEqual(h.messages.length, 0, 'sensitive hash page sends nothing');
    h.w.history.pushState({}, '', '/#/article/one');
    h.step(1000);
    assert.ok(h.last().url.endsWith('#/article/one'), 'an excluded SPA route can start capture on return to an allowed route');
    h.w.history.pushState({}, '', '/#/billing');
    h.step(1000);
    const count = h.messages.length;
    h.step(60000);
    assert.strictEqual(h.messages.length, count, 'sensitive SPA destination does not send or extract content');
    assert.ok(h.messages.every(message => !message.capture.url.includes('billing')));
    h.dom.window.close();
  }
  {
    const h = harness('https://claude.ai/chat/one', '<main><p>' + 'Initial discussion. '.repeat(550) + '</p><form>SECRET_FORM<textarea>PRIVATE_INPUT</textarea></form></main>');
    const initial = h.last();
    assert.ok(initial.extractedText.length <= 8000);
    assert.ok(!initial.extractedText.includes('SECRET_FORM'));
    h.w.document.querySelector('main').insertAdjacentHTML('beforeend', '<p>Newly arrived answer about orbital mechanics and transfer windows.</p>');
    await Promise.resolve();
    h.step(30000);
    assert.ok(!h.last().extractedText, 'dirty chat does not re-extract on each token/tick');
    h.step(30000);
    assert.ok(h.last().extractedText.includes('orbital mechanics'), 'new turns beyond 8000 characters appear in the bounded tail sample');
    assert.notStrictEqual(h.last().textHash, initial.textHash);
    assert.ok(h.last().extractedText.length <= 8000);
    for (let i = 0; i < 15; i++) {
      h.w.document.querySelector('main').insertAdjacentHTML('beforeend', `<p>Another response ${i}</p>`);
      await Promise.resolve();
      h.step(60000);
    }
    assert.ok(h.messages.filter(message => message.capture.extractedText !== undefined).length <= 13, 'chat refresh has an hourly compute/IPC cap');
    h.step(60 * 60000);
    assert.ok(h.last().extractedText.includes('Another response 14'), 'long-lived conversation refresh budget renews');
    h.dom.window.close();
  }
  {
    const h = harness('https://example.com/one', '<main>' + 'Readable content. '.repeat(50) + '</main>', true);
    h.w.history.pushState({}, '', '/two');
    h.step(1000);
    const successor = h.last().captureId;
    h.replies[0]({ ok: true, textStored: true });
    h.step(15000);
    assert.strictEqual(h.last().captureId, successor);
    assert.ok(h.last().extractedText, 'late acknowledgement from old route cannot suppress new route text');
    h.dom.window.close();
  }
  {
    const h = harness('https://example.com/article?utm_source=news&id=42');
    assert.strictEqual(h.last().url, 'https://example.com/article?id=42', 'raw tracking URLs never leave the sensor');
    h.settings({ ctPaused: true });
    const count = h.messages.length;
    h.step(60000);
    assert.strictEqual(h.messages.length, count);
    h.settings({ ctPaused: false });
    assert.notStrictEqual(h.last().captureId, h.messages[0].capture.captureId, 'resume starts a separate observed interval');
    h.dom.window.close();
  }
  console.log('content capture tests passed');
})().catch(error => { console.error(error); process.exit(1); });
