// Archived 12b requests test backwards-compatible JSON parsing only.
// Current pipeline replay lives in current.test.js with full, fresh transcripts.
// The legacy recorder truncated long prompts, so only complete requests can
// be replayed honestly. No reply is substituted for a changed prompt.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CTOllama = require('../../lib/ollama.js');
const { goldenTransport } = require('../helpers/pipelineHarness.js');
const goldenPath = path.join(__dirname, '..', '..', 'fixtures', 'golden', 'calls.json');

(async () => {
  if (!fs.existsSync(goldenPath)) throw new Error('Required legacy transcript is missing');
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const transport = goldenTransport(golden);
  const client = CTOllama.createClient({ transport, embeddingModel: 'bge-m3:latest',
    chatModel: golden.chatModel, dutyCycle: 1 });
  let completePrompts = 0;
  for (const call of golden.calls) {
    // The historical recorder truncated prompts at 2000 chars. Those cannot
    // be replayed as exact requests; they are not reconstructed or run as current pipeline evidence. Never guess or silently substitute a reply.
    if (call.prompt.length >= 2000) continue;
    const result = await client.chatJson(call.prompt, call.kind);
    if (call.kind === 'label_topics') {
      assert.ok(Array.isArray(result.topics) && result.topics.length);
      assert.ok(result.topics.every(t => t.id && typeof t.label === 'string'));
    } else {
      assert.ok(Array.isArray(result.transitions) && result.transitions.length);
      assert.ok(result.transitions.every(t => t.id && typeof t.type === 'string'));
    }
    completePrompts++;
  }
  assert.ok(completePrompts >= 5, 'all complete archived request types were replayed');
  assert.deepStrictEqual(transport.misses, [], 'every replayed request exactly matches a recorded hash');
  console.log(`legacy protocol replay passed (${completePrompts} complete archived requests)`);
})().catch(error => { console.error(error); process.exit(1); });
