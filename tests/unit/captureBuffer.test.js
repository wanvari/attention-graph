'use strict';
const assert = require('assert');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const CTStore = require('../../lib/store.js');
const CTCaptureBuffer = require('../../lib/captureBuffer.js');

function capture(id, overrides) {
  return {
    captureId: id,
    normalizedUrl: `https://a.example/${id}`,
    url: `https://a.example/${id}`,
    title: `Page ${id}`,
    domain: 'a.example',
    source: 'web',
    startedAt: new Date(2026, 2, 10, 9, 0).getTime(),
    activeMs: 60000,
    maxScrollDepth: 0.5,
    textHash: 'h1',
    extractedText: `text for ${id}`,
    textLength: 12,
    ...overrides
  };
}

async function freshStore() {
  const store = CTStore.createStore({ indexedDB: new IDBFactory(), IDBKeyRange });
  await store.open();
  return store;
}

(async () => {
  // --- text is only acknowledged once it is actually durable
  {
    const store = await freshStore();
    const buffer = CTCaptureBuffer.createCaptureBuffer({ store });
    const result = await buffer.submit(capture('c1'));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.textStored, true, 'a successful write reports the text as stored');
    assert.strictEqual(buffer.size, 0, 'written rows leave the buffer');
    const row = await store.get('captures', 'c1');
    assert.strictEqual(row.extractedText, 'text for c1');
    assert.strictEqual(row.dayKey, '2026-03-10', 'the day key is derived on write');
  }

  // --- a failed write keeps the rows AND withholds the acknowledgement
  {
    const store = await freshStore();
    const realBulkPut = store.bulkPut.bind(store);
    store.bulkPut = async () => { throw new Error('quota exceeded'); };
    const buffer = CTCaptureBuffer.createCaptureBuffer({ store });

    const result = await buffer.submit(capture('c1'));
    assert.strictEqual(result.textStored, false,
      'the content script must not be told the text is stored when the write failed');
    assert.strictEqual(buffer.size, 1, 'the row stays buffered for retry');
    assert.strictEqual(buffer.stats.failures, 1);
    assert.strictEqual(await store.get('captures', 'c1'), null);

    // The next flush, once the store recovers, delivers it.
    store.bulkPut = realBulkPut;
    const retry = await buffer.flush();
    assert.strictEqual(retry.written, 1);
    assert.strictEqual(buffer.size, 0);
    assert.strictEqual((await store.get('captures', 'c1')).extractedText, 'text for c1');
  }

  // --- an update arriving mid-write is not discarded by that flush
  {
    const store = await freshStore();
    let release;
    let signalEntered;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { signalEntered = resolve; });
    const realBulkPut = store.bulkPut.bind(store);
    let firstWrite = true;
    store.bulkPut = async (name, rows) => {
      if (firstWrite) {
        firstWrite = false;
        signalEntered();
        await gate;
      }
      return realBulkPut(name, rows);
    };
    const buffer = CTCaptureBuffer.createCaptureBuffer({ store });

    buffer.add(capture('c1', { activeMs: 1000 }));
    const flushing = buffer.flush();
    await entered; // the write is genuinely in flight now
    buffer.add(capture('c1', { activeMs: 99000 }));
    release();
    await flushing;

    assert.strictEqual(buffer.size, 1,
      'a row updated during the write stays pending instead of being dropped with the batch');
    await buffer.flush();
    assert.strictEqual((await store.get('captures', 'c1')).activeMs, 99000,
      'and the newer value is what ends up stored');
    assert.strictEqual(buffer.size, 0);
  }

  // --- text survives a later text-free update
  {
    const store = await freshStore();
    const buffer = CTCaptureBuffer.createCaptureBuffer({ store });
    await buffer.submit(capture('c1'));
    // The content script omits extractedText once it is stored.
    const followUp = capture('c1', { activeMs: 120000 });
    delete followUp.extractedText;
    const result = await buffer.submit(followUp);
    assert.strictEqual(result.textStored, false, 'a text-free update makes no claim about text');
    await buffer.flush();
    const row = await store.get('captures', 'c1');
    assert.strictEqual(row.extractedText, 'text for c1', 'stored text is preserved');
    assert.strictEqual(row.activeMs, 120000, 'the newer active time is applied');
  }

  // --- text-free updates are buffered, not written through
  {
    const store = await freshStore();
    const buffer = CTCaptureBuffer.createCaptureBuffer({ store });
    const followUp = capture('c2', { activeMs: 5000 });
    delete followUp.extractedText;
    const result = await buffer.submit(followUp);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(buffer.size, 1, 'buffered rather than written on every tick');
    assert.strictEqual(buffer.stats.flushes, 0);
    await buffer.flush();
    assert.strictEqual((await store.get('captures', 'c2')).activeMs, 5000);
  }

  // --- the pending cap forces a flush even without text
  {
    const store = await freshStore();
    const buffer = CTCaptureBuffer.createCaptureBuffer({ store });
    for (let i = 0; i < CTCaptureBuffer.FLUSH_AT_PENDING; i++) {
      const row = capture(`bulk-${i}`);
      delete row.extractedText;
      await buffer.submit(row);
    }
    assert.ok(buffer.stats.flushes >= 1, 'the buffer does not grow without bound');
    assert.strictEqual(buffer.size, 0);
  }

  // --- concurrent flushes are serialized
  {
    const store = await freshStore();
    let concurrent = 0;
    let maxConcurrent = 0;
    const realBulkPut = store.bulkPut.bind(store);
    store.bulkPut = async (name, rows) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 5));
      concurrent--;
      return realBulkPut(name, rows);
    };
    const buffer = CTCaptureBuffer.createCaptureBuffer({ store });
    buffer.add(capture('s1'));
    const a = buffer.flush();
    buffer.add(capture('s2'));
    const b = buffer.flush();
    buffer.add(capture('s3'));
    const c = buffer.flush();
    await Promise.all([a, b, c]);
    assert.strictEqual(maxConcurrent, 1, 'flushes never overlap');
    assert.strictEqual(buffer.size, 0);
  }

  // --- a capture with no id is rejected rather than buffered
  {
    const store = await freshStore();
    const buffer = CTCaptureBuffer.createCaptureBuffer({ store });
    assert.strictEqual(buffer.add({}), false);
    assert.strictEqual(buffer.size, 0);
    const result = await buffer.submit({ extractedText: 'x' });
    assert.strictEqual(result.ok, false);
  }

  console.log('captureBuffer tests passed');
})().catch(error => { console.error(error); process.exit(1); });
