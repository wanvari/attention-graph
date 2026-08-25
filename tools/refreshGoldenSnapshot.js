#!/usr/bin/env node
// Regenerates fixtures/golden/snapshot.json by REPLAYING the committed
// transcript (fixtures/golden/calls.json) through the current pipeline.
// No Ollama needed: the model's answers are already recorded. Use this after
// a pipeline change that alters stored values but not prompts; use
// tools/recordGolden.js when the prompts themselves change.
'use strict';
const fs = require('fs');
const path = require('path');
const { makeEnv, goldenTransport } = require('../tests/helpers/pipelineHarness.js');

const goldenDir = path.join(__dirname, '..', 'fixtures', 'golden');

async function main() {
  const golden = JSON.parse(fs.readFileSync(path.join(goldenDir, 'calls.json'), 'utf8'));
  const env = await makeEnv({
    transport: goldenTransport(golden),
    settings: { maxNewPagesPerRun: 400 }
  });
  for (const day of golden.runDays) {
    const result = await env.runThroughDay(day);
    if (!result.ok) {
      console.error(`replay through day ${day} failed at ${result.stage}: ${result.error}`);
      process.exit(1);
    }
    console.log(`day ${day}: ${JSON.stringify(result.counts)}`);
  }
  const snapshot = {};
  for (const storeName of ['topics', 'memberships', 'topic_events', 'daily_metrics', 'baselines', 'briefs', 'transitions', 'uncategorized', 'runs', 'visits', 'pages']) {
    let rows = await env.store.getAll(storeName);
    if (storeName === 'topics') rows = rows.map(({ centroid, ...rest }) => rest);
    if (storeName === 'pages') rows = rows.map(({ embeddingKey, ...rest }) => rest);
    snapshot[storeName] = rows;
  }
  fs.writeFileSync(path.join(goldenDir, 'snapshot.json'), JSON.stringify(snapshot, null, 1));
  console.log(`Refreshed snapshot: ${Object.values(snapshot).reduce((n, r) => n + r.length, 0)} rows`);
}

main().catch(error => { console.error(error); process.exit(1); });
