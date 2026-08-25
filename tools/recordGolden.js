#!/usr/bin/env node
// Records a real sequential pipeline execution over the fixtures against
// LIVE local Ollama (chat calls only; embeddings come from the committed
// cache). The recording replays in tests/demo without Ollama. Re-run this
// whenever a prompt changes (the golden replay fails loudly on a changed
// prompt hash).
'use strict';
const fs = require('fs');
const path = require('path');
const { makeEnv, recordingTransport } = require('../tests/helpers/pipelineHarness.js');

const goldenDir = path.join(__dirname, '..', 'fixtures', 'golden');

// Sequential runs at these fixture days give the demo its lifecycle story:
// day 21 crosses sourdough dormancy, day 25 revives it, day 28 closes out.
const RUN_DAYS = [7, 14, 21, 25, 28];

async function main() {
  const recordings = [];
  const env = await makeEnv({
    transport: recordingTransport(recordings),
    settings: { maxNewPagesPerRun: 400 }
  });
  const runSummaries = [];
  for (const day of RUN_DAYS) {
    process.stdout.write(`Running pipeline through fixture day ${day}...\n`);
    const result = await env.runThroughDay(day);
    if (!result.ok) {
      console.error(`Run through day ${day} failed at ${result.stage}: ${result.error}`);
      process.exit(1);
    }
    runSummaries.push({ day, runId: result.runId, counts: result.counts });
    process.stdout.write(`  ok: ${JSON.stringify(result.counts)}\n`);
  }

  fs.mkdirSync(goldenDir, { recursive: true });
  fs.writeFileSync(path.join(goldenDir, 'calls.json'), JSON.stringify({
    recordedAt: new Date().toISOString(),
    chatModel: 'gemma3:12b',
    runDays: RUN_DAYS,
    runSummaries,
    calls: recordings
  }, null, 1));

  // Snapshot the final database state for the read-only demo (ui/demo.html):
  // every store the surfaces read, serialized with vectors dropped.
  const snapshot = {};
  for (const storeName of ['topics', 'memberships', 'topic_events', 'daily_metrics', 'baselines', 'briefs', 'transitions', 'uncategorized', 'runs', 'visits', 'pages']) {
    let rows = await env.store.getAll(storeName);
    if (storeName === 'topics') rows = rows.map(({ centroid, ...rest }) => rest);
    if (storeName === 'pages') rows = rows.map(({ embeddingKey, ...rest }) => rest);
    snapshot[storeName] = rows;
  }
  fs.writeFileSync(path.join(goldenDir, 'snapshot.json'), JSON.stringify(snapshot, null, 1));
  console.log(`Recorded ${recordings.length} chat calls and a ${Object.values(snapshot).reduce((n, r) => n + r.length, 0)}-row snapshot to fixtures/golden/`);
}

main().catch(error => { console.error(error); process.exit(1); });
