#!/usr/bin/env node
// Performance budget check (spec §7.8). Live Ollama, fixture data. Records
// per-stage timings and polls /api/ps for model residency during the run.
// Pass: total < 5 min; both models never resident together > 60 s.
// A "normal day" p50 target (< 2 min) is measured with an incremental run.
'use strict';
const { makeEnv } = require('../tests/helpers/pipelineHarness.js');
const CTOllama = require('../lib/ollama.js');

async function pollPs(samples, stop) {
  const client = CTOllama.createClient({});
  while (!stop.done) {
    const models = await client.runningModels();
    if (models) samples.push({ at: Date.now(), models: models.map(m => m.name) });
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

async function main() {
  const health = await CTOllama.createClient({}).health();
  if (!health.ok) {
    console.error('Live Ollama required:', health);
    process.exit(1);
  }

  const samples = [];
  const stop = { done: false };
  const poller = pollPs(samples, stop);

  // Full first run over all 28 days (worst case: every page new).
  const env = await makeEnv({ transport: CTOllama.fetchTransport, settings: { maxNewPagesPerRun: 400 } });
  const t0 = Date.now();
  const full = await env.runThroughDay(27);
  const fullMs = Date.now() - t0;
  if (!full.ok) { console.error('full run failed', full); process.exit(1); }

  // Incremental "normal day": one more day on top of the warm registry.
  const t1 = Date.now();
  const incremental = await env.runThroughDay(28);
  const incrementalMs = Date.now() - t1;
  stop.done = true;
  await poller;

  // Both models resident simultaneously?
  let bothResidentMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    if (prev.models.length >= 2) bothResidentMs += samples[i].at - prev.at;
  }

  console.log('--- bench results ---');
  console.log(`full first run:   ${(fullMs / 1000).toFixed(1)}s  stages: ${JSON.stringify(full.timingsMs)}`);
  console.log(`incremental day:  ${(incrementalMs / 1000).toFixed(1)}s  stages: ${JSON.stringify(incremental.timingsMs)}`);
  console.log(`chat calls: full=${JSON.stringify(full.counts)}, incremental=${JSON.stringify(incremental.counts)}`);
  console.log(`both models resident simultaneously: ${(bothResidentMs / 1000).toFixed(0)}s (samples: ${samples.length})`);

  const pass = fullMs < 5 * 60 * 1000 && incrementalMs < 2 * 60 * 1000 && bothResidentMs <= 60 * 1000;
  console.log(pass ? 'PASS: within budget' : 'FAIL: budget exceeded');
  process.exit(pass ? 0 : 1);
}

main().catch(error => { console.error(error); process.exit(1); });
