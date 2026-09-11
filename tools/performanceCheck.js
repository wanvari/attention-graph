#!/usr/bin/env node
// Same synthetic records, frozen 5.1.1 oracle, no model calls or user history.
'use strict';
const fs = require('node:fs'), os = require('node:os'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const T = require('../lib/trails'), D = require('../lib/dashboard');
const OldT = require('../tests/helpers/reference/trails-5.1.1'), OldD = require('../tests/helpers/reference/dashboard-5.1.1');
const { makeRecordFixture } = require('../tests/helpers/performanceFixture');
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = { generatedAt: new Date().toISOString(), baseline: '183ab41', node: process.version, cpu: os.cpus()[0].model,
  scope: 'Node CPU only, synthetic history. Excludes browser DOM, IndexedDB and model latency. Alternating versions, five repetitions; no accuracy inference from timing.', cases: [] };
for (const [count, pages, topics] of [[20000, 1000, 100], [100000, 5000, 500]]) {
  const { data, now } = makeRecordFixture(count, pages, topics);
  const samples = { baseline: [], optimized: [] };
  for (let round = 0; round < 5; round++) for (const variant of round % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
    global.gc?.(); const t = variant === 'baseline' ? OldT : T, d = variant === 'baseline' ? OldD : D;
    const start = performance.now(), record = t.buildRecord(data, { now }), built = performance.now();
    const signals = d.buildDailySignals(record), end = performance.now();
    samples[variant].push({ recordMs: built - start, dashboardMs: end - built, totalMs: end - start });
    assert.equal(signals.totalMs, D.buildDailySignals(T.buildRecord(data, { now })).totalMs);
  }
  const result = { visits: count, pages, trails: topics, samples, median: Object.fromEntries(Object.entries(samples).map(([variant, rows]) => [variant,
    Object.fromEntries(['recordMs', 'dashboardMs', 'totalMs'].map(k => [k, Math.round(median(rows.map(r => r[k])) * 100) / 100]))])) };
  report.cases.push(result); console.log(JSON.stringify({ ...result, samples: undefined }));
}
const output = process.argv[2] || 'validation/performance-2026-09-11.json';
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(output);
