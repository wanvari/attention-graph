#!/usr/bin/env node
// Live production-profile check using synthetic history and an EMPTY vector cache.
// No personal browser history is read. Requires local Ollama and both models.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { makeEnv } = require('../tests/helpers/pipelineHarness');
const O = require('../lib/ollama');
const P = require('../lib/pipeline');
const L = require('../lib/label');
const T = require('../lib/trails');
const Text = require('../lib/text');
const root = path.resolve(__dirname, '..');
const report = { generatedAt: new Date().toISOString(), scope: 'Synthetic 28-day history, empty embedding cache, live production model profile. One laptop; not a human evaluation or proof of broad hardware support.',
  host: { platform: os.platform(), arch: os.arch(), memoryBytes: os.totalmem(), cpu: os.cpus()[0].model }, profile: O.DEFAULTS, calls: [], runs: [], peakResidentBytes: 0, modelOverlap: false };
try { report.host.model = execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim(); } catch {}
const recording = { recordedAt: new Date().toISOString(), chatModel: O.DEFAULTS.chatModel, runDays: [], calls: [] };
const output = path.join(root, 'validation', 'laptop-2026-09-05.json');
let deadline = Infinity;
const transport = async (url, opts, timeout) => {
  const started = performance.now();
  const result = await O.fetchTransport(url, opts, timeout);
  if (opts.body && !String(opts.headers?.['x-prompt-kind']).startsWith('unload')) {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/api/chat')) {
      const prompt = body.messages.at(-1).content;
      recording.calls.push({ kind: opts.headers['x-prompt-kind'], prompt, promptHash: Text.hashString(prompt), request: body, response: result });
    }
    report.calls.push({ kind: opts.headers?.['x-prompt-kind'], model: body.model, durationMs: Math.round(performance.now() - started), inputs: body.input?.length,
      promptTokens: result.prompt_eval_count, outputTokens: result.eval_count, loadDurationMs: Math.round((result.load_duration || 0) / 1e6), doneReason: result.done_reason });
    const ps = await O.fetchTransport(`${O.BASE_URL}/api/ps`, { method: 'GET' }, 5000);
    const ownModels = (ps.models || []).filter(m => [O.DEFAULTS.chatModel, O.DEFAULTS.embeddingModel].includes(m.name || m.model));
    report.peakResidentBytes = Math.max(report.peakResidentBytes, ownModels.reduce((sum, m) => sum + m.size_vram, 0));
    if (ownModels.length > 1) report.modelOverlap = true;
  }
  return result;
};
(async () => {
  const env = await makeEnv({ transport, clientOptions: { ...O.DEFAULTS, beforeCall: () => {
    if (Date.now() >= deadline) { const e = new Error('Three-minute work window ended'); e.code = 'deferred'; throw e; }
  } }, settings: { ...P.DEFAULTS, ...L.DEFAULTS, maxNewTopicsPerRun: 12 } });
  const health = await env.ollama.health();
  if (!health.ok) throw new Error(`Local models unavailable: ${JSON.stringify(health)}`);
  await env.store.clear('embeddings');
  await env.ollama.unloadEmbedModel(); await env.ollama.unloadChatModel();
  try {
    for (let i = 0; i < 10; i++) {
      deadline = Date.now() + 180000;
      Object.keys(env.ollama.stats).forEach(k => { env.ollama.stats[k] = 0; });
      const start = performance.now(), firstCall = report.calls.length;
      recording.runDays.push(28);
      const result = await env.runThroughDay(28);
      const pages = await env.store.getAll('pages');
      const pending = pages.filter(p => p.needsEmbedding || p.needsClassification).length;
      const run = { pass: i + 1, elapsedMs: Math.round(performance.now() - start), result, pending, calls: report.calls.length - firstCall, pacingMs: env.ollama.stats.pacedMs };
      report.runs.push(run); console.log(JSON.stringify(run));
      await env.ollama.unloadEmbedModel(); await env.ollama.unloadChatModel();
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
      if (!result.ok && !result.deferred) throw new Error(result.error);
      if (!pending && result.ok) break;
    }
    const data = await T.loadData(env.store);
    const start = performance.now();
    const record = T.buildRecord(data, { now: env.clock.now });
    report.recordBuildMs = Math.round((performance.now() - start) * 100) / 100;
    report.summary = T.summarize(record.events);
    report.topics = (await env.store.getAll('topics')).map(({ topicId, label, state }) => ({ topicId, label, state }));
    const memberships = await env.store.getAll('memberships');
    const truth = new Map(env.fixtures.pages.map(p => [Text.normalizeUrl(p.url), p.groundTruthTopic]));
    let pairs = 0, matching = 0;
    const assigned = new Set(memberships.map(m => m.normalizedUrl));
    const ingested = await env.store.getAll('pages');
    const isNoise = t => ['ambiguous', 'junk'].includes(t);
    for (let i = 0; i < memberships.length; i++) for (let j = i + 1; j < memberships.length; j++) {
      const a = memberships[i], b = memberships[j];
      if (a.topicId !== b.topicId || !truth.has(a.normalizedUrl) || !truth.has(b.normalizedUrl)) continue;
      pairs++; if (!isNoise(truth.get(a.normalizedUrl)) && truth.get(a.normalizedUrl) === truth.get(b.normalizedUrl)) matching++;
    }
    report.grouping = { ingestedPages: ingested.length, memberships: memberships.length,
      clearPages: ingested.filter(p => truth.has(p.normalizedUrl) && !isNoise(truth.get(p.normalizedUrl))).length,
      clearPagesGrouped: ingested.filter(p => !isNoise(truth.get(p.normalizedUrl)) && assigned.has(p.normalizedUrl)).length,
      noisePages: ingested.filter(p => isNoise(truth.get(p.normalizedUrl))).length,
      noisePagesGrouped: ingested.filter(p => isNoise(truth.get(p.normalizedUrl)) && assigned.has(p.normalizedUrl)).length, sameTrailPairs: pairs, sameTruthPairs: matching, pairPrecision: pairs ? matching / pairs : null,
      note: 'Pair precision measures only grouped fixture pages; coverage is separate. It does not validate inferred intention or real-world label quality.' };
    const sample = await env.store.readSnapshot(['visits', 'captures', 'pages', 'topics', 'memberships', 'topic_events', 'daily_metrics', 'baselines', 'runs', 'briefs', 'transitions', 'uncategorized', 'corrections', 'settings']);
    fs.mkdirSync(path.join(root, 'fixtures', 'current'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fixtures', 'current', 'calls.json'), JSON.stringify(recording, null, 2) + '\n');
    const embeddings = await env.store.getAll('embeddings');
    fs.writeFileSync(path.join(root, 'fixtures', 'current', 'vectors.json'), JSON.stringify(embeddings.map(e => ({ key: e.key, model: e.model, vector: Array.from(new Float32Array(e.vector)), dim: e.dim }))) + '\n');
    fs.writeFileSync(path.join(root, 'fixtures', 'current', 'snapshot.json'), JSON.stringify(sample) + '\n');
    report.complete = report.runs.at(-1).pending === 0;
    if (!report.complete) throw new Error('Backlog did not finish within 10 bounded runs');
    if (report.modelOverlap) throw new Error('Embedding and chat models overlapped');
  } finally { await env.ollama.unloadEmbedModel(); await env.ollama.unloadChatModel(); }
})().catch(error => { report.error = error.message; process.exitCode = 1; console.error(error); }).finally(() => {
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(`Report: ${output}`);
});
