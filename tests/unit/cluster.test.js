'use strict';
const assert = require('assert');
const CTCluster = require('../../lib/cluster.js');
const { load, topicPages } = require('../helpers/fixtures.js');

// deterministic shuffle for the order-invariance sweep
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rand) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function partitionSignature(clusters) {
  return clusters
    .map(c => (c.pages || c).map(p => p.normalizedUrl).sort().join(','))
    .sort()
    .join(';');
}

// --- order invariance on real embeddings: 20 shuffles, identical partitions
{
  const sample = [
    ...topicPages('sourdough-baking', 8),
    ...topicPages('rust-async', 8),
    ...topicPages('kubernetes-networking', 8),
    ...topicPages('houseplant-care', 8)
  ];
  const rand = mulberry32(42);
  const reference = partitionSignature(CTCluster.agglomerate(sample, {}).clusters.map(pages => ({ pages })));
  for (let i = 0; i < 20; i++) {
    const shuffledInput = shuffled(sample, rand);
    const result = CTCluster.agglomerate(shuffledInput, {});
    assert.strictEqual(
      partitionSignature(result.clusters.map(pages => ({ pages }))),
      reference,
      `shuffle ${i + 1}: partition must not depend on input order`
    );
  }
  // and the partition should actually separate the four ground-truth topics
  const result = CTCluster.agglomerate(sample, {});
  const bigClusters = result.clusters.filter(c => c.length >= 3);
  assert.strictEqual(bigClusters.length, 4, 'four distinct fixture topics should form four clusters');
  for (const cluster of bigClusters) {
    const truths = new Set(cluster.map(p => p.groundTruthTopic));
    assert.strictEqual(truths.size, 1, 'no cluster should blend ground-truth topics');
  }
}

// --- threshold boundary: two pages at cosine just below/above the cut
{
  const makePage = (url, vector) => ({ normalizedUrl: url, embedding: Float32Array.from(vector), dwellMs: 5 * 60000 });
  // unit vectors with a chosen cosine c: [1,0] and [c, sqrt(1-c^2)]
  const at = c => [makePage('https://a.example/x', [1, 0]), makePage('https://b.example/y', [c, Math.sqrt(1 - c * c)])];
  const below = CTCluster.agglomerate(at(0.699), { clusterThreshold: 0.70 });
  assert.strictEqual(below.clusters.length, 2, 'cosine 0.699 stays split at threshold 0.70');
  const above = CTCluster.agglomerate(at(0.701), { clusterThreshold: 0.70 });
  assert.strictEqual(above.clusters.length, 1, 'cosine 0.701 merges at threshold 0.70');
}

// --- singleton routing: thin singletons excluded, dwell-backed ones kept
{
  const distinct = (url, seedVec, dwellMs) => ({
    normalizedUrl: url, embedding: Float32Array.from(seedVec), dwellMs, domain: 'x.example', visitCount: 1
  });
  const result = CTCluster.clusterNewPages([
    distinct('https://a.example/1', [1, 0, 0], 30 * 1000),       // thin: < 2 min
    distinct('https://b.example/2', [0, 1, 0], 5 * 60 * 1000)    // real singleton
  ], {});
  assert.strictEqual(result.thinSingletons.length, 1);
  assert.strictEqual(result.thinSingletons[0].normalizedUrl, 'https://a.example/1');
  assert.strictEqual(result.clusters.length, 1, 'a dwell-backed singleton becomes a 1-page topic');
  assert.ok(result.clusters[0].heuristicConfidence < 0.7, 'thin evidence penalty applies to 1-page topics');
}

// --- 20-topic cap: overflow goes to beyondBudget, smallest dwell first
{
  const pages = [];
  for (let i = 0; i < 25; i++) {
    const vec = new Array(32).fill(0);
    vec[i % 32] = 1; // orthogonal => 25 singleton clusters
    pages.push({
      normalizedUrl: `https://site${i}.example/p`,
      embedding: Float32Array.from(vec),
      dwellMs: (i + 3) * 60 * 1000, // all above thin threshold, increasing dwell
      domain: `site${i}.example`,
      visitCount: 1
    });
  }
  const result = CTCluster.clusterNewPages(pages, {});
  assert.strictEqual(result.clusters.length, 20, 'new topics per run cap at 20');
  assert.strictEqual(result.beyondBudget.length, 5);
  const keptMinDwell = Math.min(...result.clusters.map(c => c.dwellMs));
  const droppedMaxDwell = Math.max(...result.beyondBudget.map(p => p.dwellMs));
  assert.ok(keptMinDwell >= droppedMaxDwell, 'the smallest clusters by dwell are the ones deferred');
}

// --- edge cases
{
  assert.deepStrictEqual(CTCluster.agglomerate([], {}).clusters, [], 'empty input');
  const single = CTCluster.agglomerate([{ normalizedUrl: 'https://x.example/a', embedding: Float32Array.from([1, 0]) }], {});
  assert.strictEqual(single.clusters.length, 1, 'single page forms one cluster');

  const twin = { normalizedUrl: 'https://x.example/a', embedding: Float32Array.from([0.6, 0.8]) };
  const twin2 = { normalizedUrl: 'https://x.example/b', embedding: Float32Array.from([0.6, 0.8]) };
  const identical = CTCluster.agglomerate([twin, twin2], {});
  assert.strictEqual(identical.clusters.length, 1, 'identical vectors merge');

  const zero = { normalizedUrl: 'https://z.example/a', embedding: Float32Array.from([0, 0, 0]) };
  const zeroResult = CTCluster.agglomerate([zero], {});
  assert.strictEqual(zeroResult.clusters.length, 0, 'zero vector is rejected, not divided by zero');
  assert.strictEqual(zeroResult.rejected.length, 1);

  const nan = { normalizedUrl: 'https://n.example/a', embedding: Float32Array.from([NaN, 1]) };
  const nanResult = CTCluster.agglomerate([nan], {});
  assert.strictEqual(nanResult.rejected.length, 1, 'NaN vector is rejected and reported');
  assert.strictEqual(nanResult.clusters.length, 0);
}

// --- assignToExistingTopics honors the 0.78 threshold and skips retired topics
{
  const page = { normalizedUrl: 'https://p.example/a', embedding: Float32Array.from([1, 0]) };
  const topicAt = (id, c, state) => ({
    topicId: id, state: state || 'active',
    centroid: Float32Array.from([c, Math.sqrt(1 - c * c)])
  });
  const hit = CTCluster.assignToExistingTopics([page], [topicAt('t1', 0.80)], {});
  assert.strictEqual(hit.assigned.get('t1').length, 1);
  const miss = CTCluster.assignToExistingTopics([page], [topicAt('t1', 0.76)], {});
  assert.strictEqual(miss.remainder.length, 1, 'below 0.78 the page stays unassigned');
  const retired = CTCluster.assignToExistingTopics([page], [topicAt('t1', 0.99, 'retired')], {});
  assert.strictEqual(retired.remainder.length, 1, 'retired topics never absorb new pages');
}

// --- centroid: unit length, weighted
{
  const c = CTCluster.centroid([Float32Array.from([1, 0]), Float32Array.from([0, 1])], [3, 1]);
  const norm = Math.sqrt(c[0] * c[0] + c[1] * c[1]);
  assert.ok(Math.abs(norm - 1) < 1e-6, 'centroid is unit length');
  assert.ok(c[0] > c[1], 'weights bias the centroid');
}

// Invalid dimensions fail loudly at the aggregation boundary instead of
// constructing a partly NaN centroid that poisons every later comparison.
{
  assert.throws(() => CTCluster.centroid([Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])]),
    /different embedding dimensions/);
  assert.strictEqual(CTCluster.isValidVector([1e308, 1e308]), false, 'overflow is invalid');
  assert.strictEqual(CTCluster.cosine([NaN, 1], [1, 0]), 0);
}

console.log('cluster tests passed');
