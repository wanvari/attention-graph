'use strict';
const assert = require('assert');
const CTOllama = require('../../lib/ollama.js');

// --- fence-tolerant JSON parsing (gemma wraps JSON in Markdown constantly)
{
  assert.deepStrictEqual(
    CTOllama.parseOllamaJson('```json\n{"topic":"test","confidence":0.82}\n```'),
    { topic: 'test', confidence: 0.82 }
  );
  assert.deepStrictEqual(CTOllama.parseOllamaJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(CTOllama.parseOllamaJson('  {"a":1}  '), { a: 1 });
  // Prose on either side of the JSON is recovered from.
  assert.deepStrictEqual(
    CTOllama.parseOllamaJson('Sure! Here is the JSON:\n{"verdict":"keep"}\nHope that helps.'),
    { verdict: 'keep' }
  );
  assert.deepStrictEqual(CTOllama.parseOllamaJson('[{"id":"c0"}]'), [{ id: 'c0' }]);

  // Unparseable output is tagged so callers can degrade this batch only,
  // rather than failing the whole run the way a transport error must.
  let thrown = null;
  try {
    CTOllama.parseOllamaJson('this is not JSON at all');
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'unparseable output throws');
  assert.strictEqual(thrown.code, 'parse', 'parse failures are distinguishable from transport failures');
}

// --- chat calls request an explicit context window and temperature 0
{
  let body = null;
  const transport = async (url, options) => {
    body = JSON.parse(options.body);
    return { message: { content: '{"ok":true}' } };
  };
  const client = CTOllama.createClient({ transport });
  (async () => {
    await client.chatJson('prompt text', 'label_topics');
    // Ollama defaults num_ctx to ~4k and silently truncates the batched
    // prompts; requesting it per call keeps stock gemma3:12b usable instead
    // of requiring a hand-built "-32k" Modelfile that does not exist.
    assert.ok(!/-32k$/.test(CTOllama.DEFAULTS.chatModel),
      'the default chat model must not depend on a custom Modelfile');
    assert.strictEqual(body.model, 'gemma3:12b');
    assert.strictEqual(body.options.num_ctx, CTOllama.DEFAULTS.chatContextTokens);
    assert.strictEqual(body.options.temperature, 0);
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.keep_alive, '10m', 'chat keeps the model warm for follow-up calls');
  })().catch(error => { console.error(error); process.exit(1); });
}

(async () => {
  // --- embedding batches, retry-once, and keep_alive
  {
    let calls = 0;
    const transport = async (url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.strictEqual(body.keep_alive, '5m', 'embeds unload shortly after, leaving room for chat');
      return { embeddings: body.input.map(() => [1, 0, 0]) };
    };
    const client = CTOllama.createClient({ transport, embedBatchSize: 2 });
    const vectors = await client.embed(['a', 'b', 'c', 'd', 'e']);
    assert.strictEqual(vectors.length, 5);
    assert.strictEqual(calls, 3, '5 inputs at batch size 2 = 3 calls');
  }
  {
    let calls = 0;
    const transport = async (url, options) => {
      calls++;
      if (calls === 1) throw new Error('transient');
      const body = JSON.parse(options.body);
      return { embeddings: body.input.map(() => [1, 0]) };
    };
    const client = CTOllama.createClient({ transport });
    const vectors = await client.embed(['a']);
    assert.strictEqual(vectors.length, 1, 'a transient failure is retried once');
    assert.strictEqual(calls, 2);
  }
  {
    const client = CTOllama.createClient({ transport: async () => { throw new Error('down'); } });
    await assert.rejects(() => client.embed(['a']), 'a second failure propagates');
  }
  {
    // A response that does not match the batch size is an error, not silently
    // mismatched vectors attached to the wrong pages.
    const client = CTOllama.createClient({
      transport: async () => ({ embeddings: [[1, 0]] })
    });
    await assert.rejects(() => client.embed(['a', 'b']), /did not match input batch/);
  }

  // --- health reporting, including the Chrome-origin 403 case
  {
    const ok = CTOllama.createClient({
      transport: async () => ({ models: [{ name: 'bge-m3:latest' }, { name: 'gemma3:12b' }] })
    });
    const health = await ok.health();
    assert.strictEqual(health.ok, true);
    assert.deepStrictEqual(health.missing, []);
  }
  {
    const missing = CTOllama.createClient({
      transport: async () => ({ models: [{ name: 'bge-m3:latest' }] })
    });
    const health = await missing.health();
    assert.strictEqual(health.ok, false);
    assert.deepStrictEqual(health.missing, ['gemma3:12b']);
  }
  {
    // 403 means Ollama is running but rejected the extension origin — a
    // different problem, with a different fix, than Ollama being down.
    const rejected = CTOllama.createClient({
      transport: async () => {
        const error = new Error('403 Forbidden');
        error.status = 403;
        throw error;
      }
    });
    const health = await rejected.health();
    assert.strictEqual(health.ok, false);
    assert.strictEqual(health.reachable, true);
    assert.strictEqual(health.originRejected, true);
  }
  {
    const down = CTOllama.createClient({
      transport: async () => { throw new Error('ECONNREFUSED'); }
    });
    const health = await down.health();
    assert.strictEqual(health.ok, false);
    assert.strictEqual(health.reachable, false);
  }

  // --- the endpoint is fixed to localhost
  assert.strictEqual(CTOllama.BASE_URL, 'http://localhost:11434');

  console.log('ollama tests passed');
})().catch(error => { console.error(error); process.exit(1); });
