#!/usr/bin/env node
// Records the self-consistency adjudication protocol running against LIVE
// gemma3:12b, with the audit gate deliberately widened.
//
// Why this exists: with content embeddings the production gate (cohesion <
// 0.70) is quiet — on the committed fixture it never fires, because the
// clusters really are coherent. That is the correct outcome, but it means the
// demo would show none of the protocol. This records the same code path with
// `cohesionThreshold` raised so every cluster is audited, so a reader can see
// the two passes, the reversed page order, the Jaccard grouping check, and
// what each verdict does. Output: fixtures/golden/audit-demo.json.
'use strict';
const fs = require('fs');
const path = require('path');
const CTOllama = require('../lib/ollama.js');
const CTAdjudicate = require('../lib/adjudicate.js');
const CTCluster = require('../lib/cluster.js');
const CTText = require('../lib/text.js');
const { load } = require('../tests/helpers/fixtures.js');

const goldenDir = path.join(__dirname, '..', 'fixtures', 'golden');

// Build clusters the way the pipeline does, from fixture pages.
function makeCluster(pages, label) {
  const cohesion = CTCluster.clusterCohesion(pages);
  const conf = CTCluster.heuristicConfidence(pages, cohesion);
  return {
    pages,
    centroid: CTCluster.centroid(pages.map(p => p.embedding), pages.map(p => (p.dwellMs || 0) + 1)),
    cohesion,
    heuristicConfidence: conf.value,
    dominantDomainShare: conf.dominantDomainShare,
    dwellMs: pages.reduce((sum, p) => sum + (p.dwellMs || 0), 0),
    keywords: CTText.keywordSummary(pages, 12),
    label,
    labelSource: 'llm',
    labelConfidence: 0.9
  };
}

async function main() {
  const { pages } = load();
  const byTruth = new Map();
  for (const page of pages) {
    if (!byTruth.has(page.groundTruthTopic)) byTruth.set(page.groundTruthTopic, []);
    byTruth.get(page.groundTruthTopic).push(page);
  }

  // Three deliberately contrasting cases.
  const cases = [
    {
      name: 'A coherent single-topic cluster',
      note: 'Every page is genuinely about Rust async runtimes. The expected honest verdict is keep — but note the model prefers to subdivide large coherent topics, which is exactly why the production gate does not audit clusters like this.',
      cluster: makeCluster(byTruth.get('rust-async').slice(0, 12), 'Async Rust Programming')
    },
    {
      name: 'A genuinely mixed cluster',
      note: 'Half sourdough baking, half Kubernetes networking, forced together. There is no honest shared theme; split or uncategorized are both defensible.',
      cluster: makeCluster(
        [...byTruth.get('sourdough-baking').slice(0, 6), ...byTruth.get('kubernetes-networking').slice(0, 6)],
        'MIXED'
      )
    },
    {
      name: 'Ambiguous link-roundup pages',
      note: 'Pages that blend several topics with filler. This is the material the exclusion path exists for.',
      cluster: makeCluster(byTruth.get('ambiguous').slice(0, 8), 'Weekly Link Roundups')
    }
  ];

  const health = await CTOllama.createClient({}).health();
  if (!health.ok) {
    console.error('Live Ollama with gemma3:12b required:', health);
    process.exit(1);
  }

  const recordings = [];
  const results = [];
  for (const testCase of cases) {
    console.log(`Adjudicating: ${testCase.name}…`);
    const transport = async (url, options, timeoutMs) => {
      const response = await CTOllama.fetchTransport(url, options, timeoutMs);
      if (url.endsWith('/api/chat')) {
        const body = JSON.parse(options.body);
        recordings.push({
          case: testCase.name,
          kind: (options.headers && options.headers['x-prompt-kind']) || 'chat',
          prompt: body.messages[body.messages.length - 1].content,
          reply: response.message ? response.message.content : ''
        });
      }
      return response;
    };
    const client = CTOllama.createClient({ transport });
    // Gate widened on purpose so every case is audited.
    const outcome = await CTAdjudicate.adjudicateClusters([testCase.cluster], client, { cohesionThreshold: 0.99 });
    results.push({
      name: testCase.name,
      note: testCase.note,
      pageCount: testCase.cluster.pages.length,
      cohesion: Number(testCase.cluster.cohesion.toFixed(3)),
      gatedInProduction: CTAdjudicate.needsAdjudication(testCase.cluster, CTAdjudicate.DEFAULTS),
      summary: outcome.summary,
      survivingClusters: outcome.clusters.map(c => ({
        label: c.label,
        pageCount: c.pages.length,
        adjudication: c.adjudication || null,
        titles: c.pages.slice(0, 6).map(p => p.title)
      })),
      excluded: outcome.uncategorized.map(entry => ({ title: entry.page.title, reason: entry.reason }))
    });
    console.log(`  -> ${JSON.stringify(outcome.summary)}`);
  }

  fs.mkdirSync(goldenDir, { recursive: true });
  fs.writeFileSync(path.join(goldenDir, 'audit-demo.json'), JSON.stringify({
    recordedAt: new Date().toISOString(),
    chatModel: 'gemma3:12b',
    explanation: 'The audit gate was deliberately widened (cohesionThreshold 0.99) so every cluster is audited. In production the gate fires on cohesion < 0.70, which on this fixture means it does not fire at all.',
    results,
    calls: recordings
  }, null, 1));
  console.log(`Recorded ${recordings.length} calls across ${results.length} cases to fixtures/golden/audit-demo.json`);
}

main().catch(error => { console.error(error); process.exit(1); });
