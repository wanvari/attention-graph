#!/usr/bin/env node
// Isolated same-model context experiment. Never opens IndexedDB or browser history.
'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), os = require('node:os');
const assert = require('node:assert/strict');
const P = require('../lib/pipeline'), O = require('../lib/ollama'), C = require('../lib/cluster');
const L = require('../lib/label'), A = require('../lib/adjudicate'), R = require('../lib/relevance'), Text = require('../lib/text');
const root = path.resolve(__dirname, '..'), fixtureDir = path.join(root, 'fixtures/context');
const profiles = ['current', 'expanded4000', 'full8000'];
function makeInput(page, profile) {
  if (profile === 'current') return P.embeddingInput({ ...page, captureText: page.extractedText }).slice(0, 2000);
  if (!profiles.includes(profile)) throw Error('Unknown context profile');
  const text = String(page.extractedText || '').slice(0, 8000), cap = profile === 'expanded4000' ? 4000 : 8000;
  if (!text) return P.embeddingInput(page).slice(0, 2000);
  const sample = page.source === 'llm_chat' && text.length > cap ? text.slice(0, cap * 0.6) + '\n' + text.slice(-cap * 0.4) : text.slice(0, cap);
  return `${page.title}\n${page.domain}\n${sample}`;
}
function makeCases() {
  const original = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/pages.json')));
  const topics = ['sourdough-baking', 'rust-async', 'index-fund-fees', 'ollama-quantization', 'marathon-training', 'kubernetes-networking', 'houseplant-care', 'grid-batteries'];
  const neutral = 'This page collects working notes, source material and examples for later reading. Sections are organized in order, with an introduction, supporting detail and a closing checklist. ';
  const fill = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const rows = [];
  for (const [i, topic] of topics.entries()) {
    const group = original.filter(p => p.groundTruthTopic === topic);
    group.slice(0, 5).forEach((p, j) => rows.push({ ...p, id: `ordinary-${i}-${j}`, case: 'ordinary', expectedTopic: topic }));
    const body = group[5].extractedText;
    for (const kind of ['late', 'middle-chat', 'long']) {
      const text = kind === 'late' ? fill(neutral, 2500) + fill(body, 5500)
        : kind === 'middle-chat' ? fill(neutral, 1100) + fill(body, 5200) + fill(neutral, 1700) : fill(body, 8000);
      rows.push({ id: `${kind}-${i}`, case: kind, expectedTopic: topic, url: `https://notes${i % 3}.example.test/${kind}/${i}`,
        title: kind === 'long' ? group[5].title : 'Working notes and source material', source: kind === 'middle-chat' ? 'llm_chat' : 'web', extractedText: text });
    }
    if (i < 4) {
      const other = original.find(p => p.groundTruthTopic === topics[(i + 1) % topics.length]).extractedText;
      rows.push({ id: `mixed-chat-${i}`, case: 'mixed-chat', expectedTopic: null, url: `https://conversation.example.test/${i}`, title: 'Questions on two unrelated subjects', source: 'llm_chat', extractedText: fill(body, 4000) + fill(other, 4000) });
    }
  }
  original.filter(p => ['ambiguous', 'junk'].includes(p.groundTruthTopic)).slice(0, 4).forEach((p, i) => rows.push({ ...p, id: `noise-${i}`, case: 'mixed-source', expectedTopic: null }));
  for (let i = 0; i < 4; i++) rows.push({ id: `status-${i}`, case: 'brief-status', expectedTopic: null, url: `https://status.service${i}.example.test/`, title: 'Service Status', source: 'web', extractedText: 'All systems operational. Incident history.', activeMs: 35000, dwellMs: 35000, visitCount: 211 });
  return rows.map(p => ({ ...p, normalizedUrl: Text.normalizeUrl(p.url), domain: Text.extractDomain(p.url), source: p.source || 'web',
    dwellMs: p.dwellMs ?? 180000, activeMs: p.activeMs ?? 180000, visitCount: p.visitCount ?? 3, text: p.extractedText.slice(0, 200) }));
}
function score(pages, clusters) {
  const owner = new Map(); clusters.forEach((g, i) => (g.pages || g).forEach(p => owner.set(p.id, i)));
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < pages.length; i++) for (let j = i + 1; j < pages.length; j++) {
    const a = pages[i], b = pages[j], actual = owner.has(a.id) && owner.get(a.id) === owner.get(b.id), expected = !!a.expectedTopic && a.expectedTopic === b.expectedTopic;
    if (actual && expected) tp++; if (actual && !expected) fp++; if (!actual && expected) fn++;
  }
  const byCase = {};
  for (const p of pages) {
    const row = byCase[p.case] ||= { pages: 0, grouped: 0, supportedCorrectly: 0 }; row.pages++; if (owner.has(p.id)) row.grouped++;
    if (p.expectedTopic && owner.has(p.id)) {
      const peers = (clusters[owner.get(p.id)].pages || clusters[owner.get(p.id)]);
      if (peers.length > 1 && peers.every(q => q.expectedTopic === p.expectedTopic)) row.supportedCorrectly++;
    }
  }
  return { correctPairs: tp, incorrectMergePairs: fp, missedSameTopicPairs: fn, pairPrecision: tp + fp ? tp / (tp + fp) : null,
    pairRecall: tp + fn ? tp / (tp + fn) : null, clearPages: pages.filter(p => p.expectedTopic).length,
    clearPagesGrouped: pages.filter(p => p.expectedTopic && owner.has(p.id)).length, noisePages: pages.filter(p => !p.expectedTopic).length,
    noisePagesGrouped: pages.filter(p => !p.expectedTopic && owner.has(p.id)).length, byCase };
}
async function run({ live = false, replay = false, resume = false } = {}) {
  if (!live && !replay) throw Error('Use --live for local models, or --replay for the committed exact recording.');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const archive = path.join(fixtureDir, 'recording.json.gz');
  const recording = replay || resume ? JSON.parse(zlib.gunzipSync(fs.readFileSync(archive))) : { recordedAt: new Date().toISOString(), calls: [] };
  const pages = makeCases();
  if (replay) assert.equal(recording.complete, true, 'Cannot replay a partial experiment as validation');
  if (replay || resume) assert.deepEqual(pages, recording.pages, 'Experiment corpus changed; old responses must not be substituted');
  else recording.pages = pages;
  if (resume) recording.calls = recording.calls.filter(c => recording.results?.some(r => r.profile === c.profile));
  let cursor = 0, expectedInput = null;
  let currentProfile = '', peakResidentBytes = 0, modelOverlap = false;
  const report = { generatedAt: new Date().toISOString(), scope: 'Synthetic same-model context ablation; stages embedding, clustering, labeling and adjudication only. No registry/history/capture loop, no user data. Challenge text repeats fixture prose; not independent human validation. Operational exclusions and all production thresholds/budgets retained. Generative label quality is not human-scored.',
    host: { cpu: os.cpus()[0].model, memoryBytes: os.totalmem(), node: process.version }, profiles: [], models: { embedding: O.DEFAULTS.embeddingModel, chat: O.DEFAULTS.chatModel } };
  const raw = async (url, opts, timeout) => {
    const request = opts.body ? JSON.parse(opts.body) : null;
    const kind = opts.headers?.['x-prompt-kind'];
    if (replay) {
      if (!kind || kind.startsWith('unload')) return {};
      const saved = recording.calls[cursor++];
      assert.ok(saved, `Unexpected ${kind} request`); assert.equal(saved.profile, currentProfile); assert.equal(saved.kind, kind);
      assert.deepEqual(request, saved.request, 'Changed request must fail exact replay');
      return saved.response;
    }
    const started = performance.now(), result = await O.fetchTransport(url, opts, timeout);
    if (kind && !kind.startsWith('unload')) {
      const ps = await O.fetchTransport(`${O.BASE_URL}/api/ps`, { method: 'GET' }, 4000);
      const ownModels = (ps.models || []).filter(m => [O.DEFAULTS.embeddingModel, O.DEFAULTS.chatModel].includes(m.name || m.model));
      peakResidentBytes = Math.max(peakResidentBytes, ownModels.reduce((n, m) => n + (m.size_vram || 0), 0));
      modelOverlap ||= ownModels.length > 1;
      recording.calls.push({ profile: currentProfile, kind, request, response: result, elapsedMs: performance.now() - started });
      fs.writeFileSync(archive, zlib.gzipSync(JSON.stringify(recording)));
    }
    return result;
  };
  const transport = async (url, opts, timeout) => {
    if (opts.headers?.['x-prompt-kind'] === 'embed') {
      // Test adapter bypasses ONLY the client's 2000-character cut. The app
      // client, models, prompts, thresholds and production cache stay unchanged.
      const body = JSON.parse(opts.body);
      body.input = expectedInput; body.truncate = false;
      if (currentProfile === 'full8000') body.options = { num_ctx: 8192, num_batch: 4096 };
      opts = { ...opts, body: JSON.stringify(body) };
    }
    return raw(url, opts, timeout);
  };
  const client = O.createClient({ transport, ...(replay ? { sleep: async () => {} } : {}) });
  if (live) {
    const health = await client.health(); if (!health.ok) throw Error(`Required local models unavailable: ${JSON.stringify(health)}`);
    const tags = await O.fetchTransport(`${O.BASE_URL}/api/tags`, { method: 'GET' }, 4000);
    report.modelDigests = (tags.models || []).filter(m => [report.models.embedding, report.models.chat].includes(m.name)).map(m => ({ name: m.name, digest: m.digest }));
    if (recording.modelDigests) assert.deepEqual(report.modelDigests, recording.modelDigests, 'Model digests changed since the recorded run');
    recording.modelDigests = report.modelDigests;
    report.ollama = await O.fetchTransport(`${O.BASE_URL}/api/version`, { method: 'GET' }, 4000);
    report.embeddingDetails = await O.fetchTransport(`${O.BASE_URL}/api/show`, { method: 'POST', body: JSON.stringify({ model: report.models.embedding }) }, 4000);
    // Do not retain tokenizer inventories or local model file paths.
    report.embeddingDetails = { details: report.embeddingDetails.details, contextTokens: report.embeddingDetails.model_info?.['bert.context_length'], dimensions: report.embeddingDetails.model_info?.['bert.embedding_length'] };
  }
  try {
    for (const profile of profiles) {
      const completed = resume && recording.results?.find(r => r.profile === profile);
      if (completed) { report.profiles.push(completed); continue; }
      currentProfile = profile; peakResidentBytes = 0; modelOverlap = false;
      await client.unloadEmbedModel(); await client.unloadChatModel();
      const before = recording.calls.length, start = performance.now();
      const eligible = pages.filter(p => !R.classify(p) && R.hasGroupingEvidence(p));
      assert.ok(eligible.length <= P.DEFAULTS.maxNewPagesPerRun);
      const vectors = [], inputLengths = [];
      for (let i = 0; i < eligible.length; i += O.DEFAULTS.embedBatchSize) {
        expectedInput = eligible.slice(i, i + O.DEFAULTS.embedBatchSize).map(p => makeInput(p, profile));
        inputLengths.push(...expectedInput.map(t => t.length));
        vectors.push(...await client.embed(expectedInput));
        if (live) console.log(`${profile}: embedded ${Math.min(i + O.DEFAULTS.embedBatchSize, eligible.length)}/${eligible.length}`);
      }
      const embeddedMs = performance.now() - start;
      const represented = eligible.map((p, i) => ({ ...p, embedding: C.normalize(Float32Array.from(vectors[i])) }));
      const rawClusters = C.agglomerate(represented).clusters;
      const clustered = C.clusterNewPages(represented, { maxNewTopicsPerRun: 12 });
      await client.unloadEmbedModel();
      const labeled = await L.labelClusters(clustered.clusters, client);
      const final = await A.adjudicateClusters(labeled.clusters, client);
      await client.unloadChatModel();
      const result = { profile, requestedContextTokens: profile === 'full8000' ? 8192 : null, requestedBatchTokens: profile === 'full8000' ? 4096 : null, eligiblePages: eligible.length, excludedBeforeEmbedding: pages.length - eligible.length,
        inputChars: { min: Math.min(...inputLengths), max: Math.max(...inputLengths), total: inputLengths.reduce((a, b) => a + b, 0) },
        peakResidentBytes, modelOverlap, embeddingWallMs: Math.round(embeddedMs), elapsedMs: Math.round(performance.now() - start), rawClustering: score(pages, rawClusters),
        afterLabelAndAudit: score(pages, final.clusters), beyondTopicBudget: clustered.beyondBudget.length, adjudication: final.summary,
        groups: final.clusters.map(g => ({ label: g.label, pages: g.pages.map(p => p.id), adjudication: g.adjudication || null })),
        calls: replay ? undefined : recording.calls.length - before };
      report.profiles.push(result);
      if (live) { recording.results = report.profiles; fs.writeFileSync(archive, zlib.gzipSync(JSON.stringify(recording))); console.log(JSON.stringify(result)); }
    }
    if (replay) {
      assert.equal(cursor, recording.calls.length, 'Every recorded request must be replayed');
      for (let i = 0; i < report.profiles.length; i++) for (const key of ['rawClustering', 'afterLabelAndAudit', 'groups', 'beyondTopicBudget', 'inputChars']) assert.deepEqual(report.profiles[i][key], recording.results[i][key]);
      console.log(`Exact context experiment replay passed: ${cursor} requests, ${pages.length} pages, ${profiles.length} profiles.`);
    } else { recording.complete = true; fs.writeFileSync(archive, zlib.gzipSync(JSON.stringify(recording))); fs.writeFileSync(path.join(root, 'validation/context-2026-09-11.json'), JSON.stringify(report, null, 2) + '\n'); }
    return report;
  } finally { await client.unloadEmbedModel(); await client.unloadChatModel(); }
}
module.exports = { makeInput, makeCases, score, profiles, run };
if (require.main === module) run({ live: process.argv.includes('--live'), replay: process.argv.includes('--replay'), resume: process.argv.includes('--resume') }).catch(e => { console.error(e); process.exitCode = 1; });
