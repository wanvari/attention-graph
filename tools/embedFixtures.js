#!/usr/bin/env node
// Embeds fixtures/pages.json with live local Ollama (bge-m3) and writes
// fixtures/embeddings.bin (concatenated unit-normalized Float32 vectors) plus
// fixtures/index.json (row order, model, dim). Run once; commit the output so
// clustering and registry tests are real-vector tests without needing Ollama.
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:11434';
const MODEL = 'bge-m3:latest';
const BATCH = 32;

const fixturesDir = path.join(__dirname, '..', 'fixtures');
const pages = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'pages.json'), 'utf8'));

// Embedding input matches the pipeline (spec §4.2): title \n domain \n text[:1500]
function embeddingInput(page) {
  if (page.extractedText) {
    return `${page.title}\n${page.domain}\n${page.extractedText.slice(0, 1500)}`;
  }
  return `${page.title}\n${page.domain}\n${page.url.replace(/^https?:\/\//, '').replace(/[\/._-]/g, ' ')}`;
}

function normalize(vector) {
  let sumSq = 0;
  for (const v of vector) sumSq += v * v;
  const norm = Math.sqrt(sumSq) || 1;
  return vector.map(v => v / norm);
}

async function main() {
  const inputs = pages.map(embeddingInput);
  const vectors = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const response = await fetch(`${BASE}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, input: batch, keep_alive: '5m' })
    });
    if (!response.ok) throw new Error(`embed failed: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== batch.length) {
      throw new Error('embedding count mismatch');
    }
    vectors.push(...data.embeddings.map(normalize));
    process.stdout.write(`\rEmbedded ${Math.min(i + BATCH, inputs.length)}/${inputs.length}`);
  }
  process.stdout.write('\n');

  const dim = vectors[0].length;
  const flat = new Float32Array(vectors.length * dim);
  vectors.forEach((vec, row) => flat.set(vec, row * dim));
  fs.writeFileSync(path.join(fixturesDir, 'embeddings.bin'), Buffer.from(flat.buffer));
  fs.writeFileSync(path.join(fixturesDir, 'index.json'), JSON.stringify({
    model: MODEL,
    dim,
    count: vectors.length,
    generatedAt: new Date().toISOString(),
    urls: pages.map(p => p.url)
  }, null, 1));
  console.log(`Wrote ${vectors.length} x ${dim} vectors (${Math.round(flat.byteLength / 1024)} KB)`);
}

main().catch(error => { console.error(error); process.exit(1); });
