// Golden replay (spec §7.3): the recorded real-model transcript drives the
// full sequential pipeline without Ollama. Fails loudly when a prompt hash
// is missing (i.e. prompts changed since the last tools/recordGolden.js).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeEnv, goldenTransport } = require('../helpers/pipelineHarness.js');

const goldenPath = path.join(__dirname, '..', '..', 'fixtures', 'golden', 'calls.json');

(async () => {
  if (!fs.existsSync(goldenPath)) {
    console.log('golden replay skipped: fixtures/golden/calls.json not recorded yet');
    return;
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const env = await makeEnv({
    transport: goldenTransport(golden),
    settings: { maxNewPagesPerRun: 400 }
  });
  for (const day of golden.runDays) {
    const result = await env.runThroughDay(day);
    assert.strictEqual(result.ok, true, `replay run through day ${day} failed at ${result.stage}: ${result.error}`);
  }

  const topics = await env.store.getAll('topics');
  assert.ok(topics.length >= 10, `real-model replay produces a full registry (got ${topics.length})`);
  const events = await env.store.getAll('topic_events');
  assert.ok(events.some(e => e.type === 'dormant'), 'lifecycle: dormancy recorded');
  assert.ok(events.some(e => e.type === 'revived'), 'lifecycle: revival recorded');
  const runs = await env.store.getAll('runs');
  assert.ok(runs.every(r => r.status === 'ok'), 'all replay runs ok');
  const briefs = await env.store.getAll('briefs');
  assert.ok(briefs.length >= golden.runDays.length - 1, 'briefs written for run days');

  console.log(`golden replay passed (${golden.calls.length} recorded chat calls, ${topics.length} topics)`);
})().catch(error => { console.error(error); process.exit(1); });
