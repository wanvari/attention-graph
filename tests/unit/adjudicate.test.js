'use strict';
const assert = require('assert');
const CTAdjudicate = require('../../lib/adjudicate.js');

const MIN = 60 * 1000;

// A blended 6-page cluster across three domains: always gates adjudication.
function makeCluster(overrides) {
  const pages = Array.from({ length: 6 }, (_, i) => ({
    normalizedUrl: `https://site${i % 3}.example/p${i}`,
    url: `https://site${i % 3}.example/p${i}`,
    title: `Page ${i}`,
    domain: `site${i % 3}.example`,
    dwellMs: 5 * MIN,
    visitCount: 2,
    lastDay: '2026-03-10',
    embedding: Float32Array.from([1, 0])
  }));
  return {
    pages,
    label: 'Blended cluster',
    labelConfidence: 0.5,
    heuristicConfidence: 0.5,
    dominantDomainShare: 0.34,
    centroid: Float32Array.from([1, 0]),
    keywords: ['mixed'],
    ...overrides
  };
}

// Scripted client: queue of responses; each chatJson call shifts one.
function makeClient(queue) {
  const calls = [];
  return {
    calls,
    async chatJson(prompt, kind) {
      calls.push({ prompt, kind });
      if (!queue.length) throw new Error('queue exhausted');
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

const parseError = () => {
  const error = new Error('Ollama response was not parseable JSON');
  error.code = 'parse';
  return error;
};

async function run(queue, clusterOverrides, options) {
  const client = makeClient(queue);
  const result = await CTAdjudicate.adjudicateClusters([makeCluster(clusterOverrides)], client, options || {});
  return { ...result, client };
}

const splitGroups = (a, b) => [
  { label: 'Group A', page_indexes: a },
  { label: 'Group B', page_indexes: b }
];
// Reversed-pass indexes for the same page set: index i becomes 5 - i.
const rev = indexes => indexes.map(i => 5 - i);

(async () => {
  // --- agreed keep applies label and confidence min
  {
    const { clusters, summary } = await run([
      { verdict: 'keep', label: 'Home office setup', confidence: 0.85, rationale: 'One task.' },
      { verdict: 'Keep', confidence: 0.75 } // casing variant accepted
    ]);
    assert.strictEqual(summary.kept, 1);
    assert.strictEqual(clusters.length, 1);
    assert.strictEqual(clusters[0].label, 'Home office setup');
    assert.strictEqual(clusters[0].labelConfidence, 0.75, 'confidence is the min of both passes');
    assert.strictEqual(clusters[0].adjudication, 'kept');
  }

  // --- agreed uncategorized moves every page out
  {
    const { clusters, uncategorized, summary } = await run([
      { verdict: '  UNCATEGORIZED ', confidence: 0.3 }, // whitespace variant
      { verdict: 'uncategorized', confidence: 0.2 }
    ]);
    assert.strictEqual(summary.uncategorized, 1);
    assert.strictEqual(clusters.length, 0);
    assert.strictEqual(uncategorized.length, 6);
    assert.ok(uncategorized.every(u => u.reason === 'agreed_uncategorized'));
  }

  // --- verdict disagreement
  {
    const { clusters, uncategorized, summary } = await run([
      { verdict: 'keep', confidence: 0.8 },
      { verdict: 'uncategorized', confidence: 0.4 }
    ]);
    assert.strictEqual(summary.disagreed, 1);
    assert.strictEqual(clusters.length, 0);
    assert.ok(uncategorized.every(u => u.reason === 'disagreement'));
  }

  // --- unparseable verdict counts as disagreement
  {
    const { summary, uncategorized } = await run([
      { verdict: 'definitely-keep-this', confidence: 0.9 },
      { verdict: 'keep', confidence: 0.9 }
    ]);
    assert.strictEqual(summary.disagreed, 1);
    assert.strictEqual(uncategorized.length, 6);
  }

  // --- LLM error keeps the topic (infrastructure is not evidence)
  {
    const { clusters, uncategorized, summary } = await run([
      new Error('ollama offline')
    ]);
    assert.strictEqual(summary.errors, 1);
    assert.strictEqual(clusters.length, 1, 'topic kept on error');
    assert.strictEqual(uncategorized.length, 0);
  }
  // timeout on pass 2 specifically
  {
    const { clusters, summary } = await run([
      { verdict: 'keep', confidence: 0.8 },
      new Error('timeout')
    ]);
    assert.strictEqual(summary.errors, 1);
    assert.strictEqual(clusters.length, 1);
  }
  // parse error mid-adjudication is also just an error for this topic
  {
    const { clusters, summary } = await run([parseError()]);
    assert.strictEqual(summary.errors, 1);
    assert.strictEqual(clusters.length, 1);
  }

  // --- §4.6 split: identical groupings (pass 2 reversed) -> clean split
  {
    const { clusters, uncategorized, summary } = await run([
      { verdict: 'split', confidence: 0.8, groups: splitGroups([0, 1, 2], [3, 4, 5]) },
      { verdict: 'split', confidence: 0.8, groups: splitGroups(rev([0, 1, 2]), rev([3, 4, 5])) }
    ]);
    assert.strictEqual(summary.split, 1);
    assert.strictEqual(clusters.length, 2, 'both groups become clusters');
    assert.strictEqual(uncategorized.length, 0);
    assert.strictEqual(clusters.reduce((n, c) => n + c.pages.length, 0), 6);
    assert.ok(clusters.every(c => c.adjudication === 'split'));
  }

  // --- same verdict, disjoint groupings -> disagreement
  {
    const { summary, uncategorized } = await run([
      { verdict: 'split', confidence: 0.8, groups: splitGroups([0, 1, 2], [3, 4, 5]) },
      { verdict: 'split', confidence: 0.8, groups: splitGroups(rev([0, 3]), rev([1, 4])) }
    ]);
    assert.strictEqual(summary.disagreed, 1, 'agreeing on "split" alone is not agreement');
    assert.ok(uncategorized.every(u => u.reason === 'disagreement'));
  }

  // --- Jaccard boundary at 0.59 vs 0.61
  {
    // pass1 pairs for [0,1,2],[3,4,5]: {01,02,12,34,35,45} = 6 pairs.
    // pass2 identical on group A but group B = [3,4] only: pairs {01,02,12,34} = 4.
    // intersection 4, union 6 -> 0.667 >= 0.60: applies pass 1 groups minus disputed.
    const above = await run([
      { verdict: 'split', confidence: 0.8, groups: splitGroups([0, 1, 2], [3, 4, 5]) },
      { verdict: 'split', confidence: 0.8, groups: [
        { label: 'A', page_indexes: rev([0, 1, 2]) },
        { label: 'B', page_indexes: rev([3, 4]) }
      ] }
    ]);
    assert.strictEqual(above.summary.split, 1, 'Jaccard 0.667 passes the 0.60 bar');
    // pages 3 and 5 are disputed (pairs 35, 45 in symmetric difference);
    // page 4 is in a disputed pair too (45) -> group B dissolves entirely.
    assert.ok(above.uncategorized.length >= 1);
    assert.ok(above.uncategorized.every(u => u.reason === 'split_leftover'));

    // pass2 shares only {01} with pass1's {01,02,12,34,35,45}:
    // intersection 1, pass2 also has {23}: union 7 -> 0.14 < 0.60.
    const below = await run([
      { verdict: 'split', confidence: 0.8, groups: splitGroups([0, 1, 2], [3, 4, 5]) },
      { verdict: 'split', confidence: 0.8, groups: [
        { label: 'A', page_indexes: rev([0, 1]) },
        { label: 'B', page_indexes: rev([2, 3]) }
      ] }
    ]);
    assert.strictEqual(below.summary.disagreed, 1, 'low pair-Jaccard is disagreement');
  }

  // --- groups with < 2 members dissolve
  {
    const { summary } = await run([
      { verdict: 'split', confidence: 0.8, groups: [
        { label: 'A', page_indexes: [0] },
        { label: 'B', page_indexes: [1] }
      ] },
      { verdict: 'split', confidence: 0.8, groups: splitGroups(rev([0, 1, 2]), rev([3, 4, 5])) }
    ]);
    assert.strictEqual(summary.disagreed, 1, 'pass 1 producing no usable groups is disagreement');
  }

  // --- out-of-range and duplicate indexes are ignored
  {
    const { clusters, summary } = await run([
      { verdict: 'split', confidence: 0.8, groups: splitGroups([0, 1, 2], [3, 4, 5]) },
      { verdict: 'split', confidence: 0.8, groups: [
        { label: 'A', page_indexes: [...rev([0, 1, 2]), 99, -1, rev([0, 1, 2])[0]] },
        { label: 'B', page_indexes: rev([3, 4, 5]) }
      ] }
    ]);
    assert.strictEqual(summary.split, 1, 'junk indexes do not break agreement');
    assert.strictEqual(clusters.length, 2);
  }

  // --- pages beyond the 24-page prompt follow the split as beyond_budget
  {
    const bigPages = Array.from({ length: 30 }, (_, i) => ({
      normalizedUrl: `https://s${i % 3}.example/p${i}`,
      url: `https://s${i % 3}.example/p${i}`,
      title: `Page ${i}`,
      domain: `s${i % 3}.example`,
      dwellMs: (30 - i) * MIN, // page order by importance = index order
      visitCount: 1,
      lastDay: '2026-03-10',
      embedding: Float32Array.from([1, 0])
    }));
    const client = makeClient([
      { verdict: 'split', confidence: 0.8, groups: splitGroups(Array.from({ length: 12 }, (_, i) => i), Array.from({ length: 12 }, (_, i) => i + 12)) },
      { verdict: 'split', confidence: 0.8, groups: splitGroups(Array.from({ length: 12 }, (_, i) => 23 - i), Array.from({ length: 12 }, (_, i) => 11 - i)) }
    ]);
    const result = await CTAdjudicate.adjudicateClusters([makeCluster({ pages: bigPages })], client, {});
    assert.strictEqual(result.summary.split, 1);
    const beyond = result.uncategorized.filter(u => u.reason === 'beyond_budget');
    assert.strictEqual(beyond.length, 6, '30 pages - 24 shown = 6 beyond budget');
  }

  // --- compute cap: at most 4 topics x 2 calls
  {
    const clusters = Array.from({ length: 6 }, () => makeCluster({}));
    const responses = [];
    for (let i = 0; i < 8; i++) responses.push({ verdict: 'keep', confidence: 0.8 });
    const client = makeClient(responses);
    const result = await CTAdjudicate.adjudicateClusters(clusters, client, {});
    assert.strictEqual(client.calls.length, 8, 'exactly 4 x 2 chat calls');
    assert.strictEqual(result.summary.audited, 4);
    assert.strictEqual(result.clusters.length, 6, 'unaudited clusters pass through');
  }

  // --- gate: clean single-domain confident cluster is not audited
  {
    const clean = makeCluster({
      dominantDomainShare: 1,
      heuristicConfidence: 0.8,
      labelConfidence: 0.95,
      label: 'Clean topic'
    });
    const client = makeClient([]);
    const result = await CTAdjudicate.adjudicateClusters([clean], client, {});
    assert.strictEqual(client.calls.length, 0, 'no audit budget spent');
    assert.strictEqual(result.clusters.length, 1);
  }

  // --- gate: MIXED label always audits, even when heuristics look fine
  {
    const mixed = makeCluster({
      dominantDomainShare: 1, heuristicConfidence: 0.9, label: 'MIXED'
    });
    const client = makeClient([
      { verdict: 'uncategorized', confidence: 0.2 },
      { verdict: 'uncategorized', confidence: 0.2 }
    ]);
    const result = await CTAdjudicate.adjudicateClusters([mixed], client, {});
    assert.strictEqual(result.summary.audited, 1);
  }

  // --- gate fires on incoherence, NOT on domain diversity.
  // Regression: with content embeddings an honest research topic spans many
  // domains, so a domain-share gate audited every real topic and gemma's
  // split-happiness then dumped them into uncategorized. Cohesion is the
  // signal; domain diversity alone must never trigger an audit.
  {
    const multiDomainCohesive = makeCluster({
      dominantDomainShare: 0.20,   // five domains, like a real research topic
      cohesion: 0.86,
      heuristicConfidence: 0.80,
      labelConfidence: 0.9
    });
    const client = makeClient([]);
    const result = await CTAdjudicate.adjudicateClusters([multiDomainCohesive], client, {});
    assert.strictEqual(client.calls.length, 0, 'a cohesive multi-domain topic must not spend audit budget');
    assert.strictEqual(result.clusters.length, 1);
    assert.strictEqual(result.uncategorized.length, 0, 'and must not be excluded');

    const singleDomainIncoherent = makeCluster({
      dominantDomainShare: 1,      // one domain, but the pages do not cohere
      cohesion: 0.55,
      heuristicConfidence: 0.75,
      labelConfidence: 0.9
    });
    const client2 = makeClient([
      { verdict: 'uncategorized', confidence: 0.3 },
      { verdict: 'uncategorized', confidence: 0.3 }
    ]);
    const result2 = await CTAdjudicate.adjudicateClusters([singleDomainIncoherent], client2, {});
    assert.strictEqual(result2.summary.audited, 1, 'low cohesion gates even on a single domain');
  }

  // --- gate survives optimistic LLM confidence (heuristic is the evidence)
  {
    const optimistic = makeCluster({ labelConfidence: 0.95 });
    const client = makeClient([
      { verdict: 'uncategorized', confidence: 0.3 },
      { verdict: 'uncategorized', confidence: 0.3 }
    ]);
    const result = await CTAdjudicate.adjudicateClusters([optimistic], client, {});
    assert.strictEqual(result.summary.audited, 1, 'blended evidence gates regardless of self-reported 0.95');
  }

  console.log('adjudicate tests passed');
})().catch(error => { console.error(error); process.exit(1); });
