// Exact current-profile replay of the live synthetic-month run. Full prompts
// and fresh vectors are committed; changed requests must fail explicitly.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv, goldenTransport } = require('../helpers/pipelineHarness');
const O = require('../../lib/ollama');
const P = require('../../lib/pipeline');
const L = require('../../lib/label');
const S = require('../../lib/store');
const directory = path.resolve(__dirname, '../../fixtures/current');
(async () => {
  const recording = JSON.parse(fs.readFileSync(path.join(directory, 'calls.json')));
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json')));
  const transport = goldenTransport(recording);
  const env = await makeEnv({ transport, clientOptions: { ...O.DEFAULTS, dutyCycle: 1 }, settings: { ...P.DEFAULTS, ...L.DEFAULTS } });
  await env.store.clear('embeddings');
  await env.store.bulkPut('embeddings', JSON.parse(fs.readFileSync(path.join(directory, 'vectors.json')))
    .map(e => ({ ...e, vector: S.vecToBuf(e.vector), createdAt: env.clock.now, lastUsedAt: env.clock.now })));
  for (const day of recording.runDays) {
    const result = await env.runThroughDay(day);
    assert.ok(result.ok, result.error);
  }
  assert.deepEqual(transport.misses, [], 'every prompt exactly matches a current recorded request');
  const pages = await env.store.getAll('pages');
  assert.ok(pages.every(p => !p.needsEmbedding && !p.needsClassification));
  const membership = rows => rows.map(m => `${m.topicId}|${m.normalizedUrl}`).sort();
  assert.deepEqual(membership(await env.store.getAll('memberships')), membership(snapshot.memberships));
  assert.deepEqual((await env.store.getAll('topics')).map(t => [t.topicId, t.label, t.state]), snapshot.topics.map(t => [t.topicId, t.label, t.state]));
  assert.ok(!(await env.store.getAll('topic_events')).some(e => e.type === 'revived'), 'backlog-only runs do not fabricate returns');
  console.log('current full-transcript pipeline replay passed');
})().catch(error => { console.error(error); process.exit(1); });
