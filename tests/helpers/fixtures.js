// Shared fixture loading for tests: pages + real committed bge-m3 vectors.
'use strict';
const fs = require('fs');
const path = require('path');
const CTText = require('../../lib/text.js');

const fixturesDir = path.join(__dirname, '..', '..', 'fixtures');

let cache = null;

function load() {
  if (cache) return cache;
  const pages = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'pages.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'index.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(fixturesDir, 'embeddings.bin'));
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const byUrl = new Map();
  index.urls.forEach((url, row) => {
    byUrl.set(url, flat.subarray(row * index.dim, (row + 1) * index.dim));
  });
  const enriched = pages.map(page => ({
    ...page,
    normalizedUrl: CTText.normalizeUrl(page.url),
    embedding: byUrl.get(page.url),
    dwellMs: 5 * 60 * 1000,
    activeMs: 3 * 60 * 1000,
    visitCount: 2,
    firstDay: '2026-03-01',
    lastDay: '2026-03-01'
  }));
  const visits = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'visits.json'), 'utf8'));
  cache = { pages: enriched, index, visits };
  return cache;
}

function topicPages(topicId, count) {
  const { pages } = load();
  const out = pages.filter(p => p.groundTruthTopic === topicId);
  return count ? out.slice(0, count) : out;
}

module.exports = { load, topicPages };
