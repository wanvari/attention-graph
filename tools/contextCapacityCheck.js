#!/usr/bin/env node
// Reproduce the long-input boundary on the installed local runtime; no app writes.
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const E = require('./contextExperiment'), O = require('../lib/ollama');
(async () => {
  const input = E.makeInput(E.makeCases().find(p => p.id === 'long-6'), 'full8000');
  const report = { generatedAt: new Date().toISOString(), inputId: 'long-6', chars: input.length, sha256: crypto.createHash('sha256').update(input).digest('hex'),
    ollama: await O.fetchTransport(`${O.BASE_URL}/api/version`, { method: 'GET' }, 4000), cases: [] };
  for (const [options, truncate] of [[{}, false], [{ num_ctx: 8192 }, false], [{ num_ctx: 8192 }, true], [{ num_ctx: 8192, num_batch: 4096 }, false]]) {
    const client = O.createClient({}); await client.unloadEmbedModel();
    const request = { model: O.DEFAULTS.embeddingModel, input: [input], keep_alive: '2m', options, truncate };
    const start = Date.now();
    const response = await fetch(`${O.BASE_URL}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(request), signal: AbortSignal.timeout(45000) });
    const data = await response.json(), elapsedMs = Date.now() - start;
    const ps = await O.fetchTransport(`${O.BASE_URL}/api/ps`, { method: 'GET' }, 4000);
    report.cases.push({ options, truncate, status: response.status, error: data.error || null, inputTokens: data.prompt_eval_count ?? null,
      vectorDimensions: data.embeddings?.[0]?.length ?? null, runtime: (ps.models || []).map(m => ({ name: m.name, context_length: m.context_length, size_vram: m.size_vram })), elapsedMs });
    await new Promise(resolve => setTimeout(resolve, elapsedMs)); await client.unloadEmbedModel();
  }
  const output = path.resolve(__dirname, '../validation/context-capacity-2026-09-11.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
})().catch(e => { console.error(e); process.exitCode = 1; });
