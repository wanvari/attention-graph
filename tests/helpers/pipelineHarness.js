// Runs the full pipeline in Node over the committed fixtures: fake-indexeddb
// store, fixture history provider, seeded captures, and the committed real
// bge-m3 embedding cache (so no live Ollama is needed for embeddings).
// Chat calls go through an injectable transport (scripted / golden / live).
'use strict';
// The committed schedule is authored in this calendar, including its DST day.
// Fixture replay must not change when the developer travels across time zones.
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const CTText = require('../../lib/text.js');
const CTStore = require('../../lib/store.js');
const CTOllama = require('../../lib/ollama.js');
const CTPipeline = require('../../lib/pipeline.js');

const fixturesDir = path.join(__dirname, '..', '..', 'fixtures');

function loadFixtures() {
  const pages = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'pages.json'), 'utf8'));
  const visitData = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'visits.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'index.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(fixturesDir, 'embeddings.bin'));
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const vectorByUrl = new Map();
  index.urls.forEach((url, row) => {
    vectorByUrl.set(url, flat.subarray(row * index.dim, (row + 1) * index.dim));
  });
  return { pages, visitData, index, vectorByUrl };
}

// Scripted transport. handlers: { [promptKind]: (body, promptText) => resultObject | throws }
// Chat results are wrapped into Ollama's response shape automatically.
function scriptedTransport(handlers) {
  const calls = [];
  const transport = async (url, options) => {
    const kind = (options.headers && options.headers['x-prompt-kind']) || 'unknown';
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ url, kind });
    if (url.endsWith('/api/tags')) {
      return { models: [{ name: 'bge-m3:latest' }, { name: 'gemma3:12b' }] };
    }
    if (kind === 'unload') return { embeddings: [[0]] };
    if (kind === 'embed') {
      if (handlers.embed) return handlers.embed(body);
      throw new Error('unexpected embed call: fixture cache should cover all pages');
    }
    const handler = handlers[kind] || handlers.default;
    if (!handler) throw new Error(`no scripted handler for prompt kind ${kind}`);
    const prompt = body.messages ? body.messages[body.messages.length - 1].content : '';
    const result = handler(body, prompt);
    if (result instanceof Error) throw result;
    return { message: { content: typeof result === 'string' ? result : JSON.stringify(result) } };
  };
  transport.calls = calls;
  return transport;
}

// Deterministic "well-behaved model" handlers: labels clusters by the
// ground-truth topic of their dominant page, keeps everything on adjudication.
function wellBehavedHandlers(pages) {
  const truthByUrl = new Map(pages.map(p => [CTText.normalizeUrl(p.url), p.groundTruthTopic]));
  const labelForCluster = clusterPayload => {
    const counts = new Map();
    for (const page of clusterPayload.pages) {
      // url in payload is stripped of protocol; recover truth by suffix match
      const match = [...truthByUrl.entries()].find(([u]) => u.includes(page.url.split('?')[0].slice(0, 40)));
      const truth = match ? match[1] : 'unknown';
      counts.set(truth, (counts.get(truth) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? `Topic ${best[0]}` : 'MIXED';
  };
  // The payload is always the last '\n\n'-separated block of the prompt.
  const payloadOf = body => {
    const prompt = body.messages[body.messages.length - 1].content;
    const blocks = prompt.split('\n\n');
    return JSON.parse(blocks[blocks.length - 1]);
  };
  return {
    label_topics: body => {
      const payload = payloadOf(body);
      return {
        topics: payload.map(cluster => ({
          id: cluster.id,
          label: labelForCluster(cluster),
          confidence: 0.85,
          rationale: 'Pages share one theme in the fixture ground truth.'
        }))
      };
    },
    adjudicate_pass1: () => ({ verdict: 'keep', label: undefined, confidence: 0.8, rationale: 'Pages cohere.' }),
    adjudicate_pass2: () => ({ verdict: 'keep', label: undefined, confidence: 0.8, rationale: 'Pages cohere.' }),
    label_transitions: body => {
      const payload = payloadOf(body);
      return { transitions: payload.map(t => ({ id: t.id, type: 'topic_switch', confidence: 0.8, rationale: 'Different threads.' })) };
    },
    verify_transitions: body => {
      const payload = payloadOf(body);
      return { transitions: payload.map(t => ({ id: t.id, type: 'topic_switch', confidence: 0.85 })) };
    }
  };
}

// Records every live chat call for later replay (tools/recordGolden.js).
function recordingTransport(recordings) {
  const CTText2 = require('../../lib/text.js');
  return async (url, options, timeoutMs) => {
    const CTOllamaLive = require('../../lib/ollama.js');
    const response = await CTOllamaLive.fetchTransport(url, options, timeoutMs);
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(options.body);
      const prompt = body.messages[body.messages.length - 1].content;
      recordings.push({
        kind: (options.headers && options.headers['x-prompt-kind']) || 'chat',
        promptHash: CTText2.hashString(prompt),
        prompt: prompt.slice(0, 2000),
        response
      });
    }
    return response;
  };
}

// Replays fixtures/golden/ recordings; errors when a prompt is not in the
// index (a changed prompt means the golden must be re-recorded).
function goldenTransport(golden) {
  const CTText2 = require('../../lib/text.js');
  const byHash = new Map(golden.calls.map(call => [call.promptHash, call]));
  // Transition labelling treats a failed call as best-effort and swallows it,
  // which is correct in production but would let a drifted prompt slip past
  // the replay unnoticed. Misses are recorded so the test can assert none.
  const misses = [];
  const transport = async (url, options) => {
    if (url.endsWith('/api/tags')) {
      return { models: [{ name: 'bge-m3:latest' }, { name: 'gemma3:12b' }] };
    }
    const kind = (options.headers && options.headers['x-prompt-kind']) || 'unknown';
    if (kind === 'unload' || kind === 'embed') return { embeddings: [[0]] };
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(options.body);
      const prompt = body.messages[body.messages.length - 1].content;
      const hash = CTText2.hashString(prompt);
      const call = byHash.get(hash);
      if (!call) {
        misses.push({ kind, hash });
        const error = new Error(`prompt hash ${hash} (${kind}) not in golden index — re-record with tools/recordGolden.js`);
        error.code = 'golden-miss';
        throw error;
      }
      return call.response;
    }
    throw new Error(`golden transport: unexpected URL ${url}`);
  };
  transport.misses = misses;
  return transport;
}

async function makeEnv(options) {
  const opts = options || {};
  const fixtures = loadFixtures();
  const factory = new IDBFactory();
  const store = CTStore.createStore({ indexedDB: factory, IDBKeyRange });
  await store.open();

  const anchor = fixtures.visitData.anchorDay1;
  // Local-calendar day math: day 8 of the fixture is a 23-hour DST day, so
  // naive `anchor + n*24h` would land on the wrong calendar day.
  const dayEnd = n => {
    const base = new Date(anchor);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + (n - 1), 23, 30, 0, 0).getTime();
  };

  // Mutable clock the pipeline reads.
  const clock = { now: dayEnd(1) };

  // Seed captures: one per page per day it was visited, at the first visit
  // time of that day, carrying the fixture text.
  const pageByUrl = new Map(fixtures.pages.map(p => [p.url, p]));
  const captureRows = [];
  const seen = new Set();
  for (const visit of fixtures.visitData.visits) {
    const page = pageByUrl.get(visit.url);
    if (!page) continue;
    const dayKey = CTText.dayKeyFromMs(visit.visitTime);
    const dedupe = `${visit.url}|${dayKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    captureRows.push({
      captureId: `cap-${captureRows.length}`,
      url: visit.url,
      normalizedUrl: CTText.normalizeUrl(visit.url),
      title: page.title,
      domain: page.domain,
      source: page.source,
      startedAt: visit.visitTime,
      // A tab left open across the whole visit (the 30-minute dwell cap) with
      // 3 minutes of measured attention inside it. The span has to cover the
      // visit: lib/history.js only lets a capture lower dwell across the span
      // it actually observed, so a capture that watched 60 seconds says
      // nothing about the remaining minutes and must not shrink them.
      endedAt: visit.visitTime + 30 * 60 * 1000,
      activeMs: 3 * 60 * 1000,
      maxScrollDepth: 0.6,
      textHash: CTText.hashString(page.extractedText),
      extractedText: page.extractedText,
      textLength: page.extractedText.length,
      lang: 'en',
      isSpaNavigation: false,
      dayKey
    });
  }
  await store.bulkPut('captures', captureRows);

  // Seed the embedding cache with the committed real vectors under the
  // exact keys the pipeline will compute.
  const embedRows = [];
  for (const page of fixtures.pages) {
    const input = CTPipeline.embeddingInput({
      title: page.title, domain: page.domain, url: page.url, source: page.source,
      captureText: page.extractedText || ''
    });
    const key = CTPipeline.embeddingKeyFor('bge-m3:latest', input);
    const vector = fixtures.vectorByUrl.get(page.url);
    if (!vector) continue;
    embedRows.push({
      key, model: 'bge-m3:latest',
      vector: CTStore.vecToBuf(vector), dim: vector.length,
      createdAt: anchor, lastUsedAt: anchor
    });
  }
  await store.bulkPut('embeddings', embedRows);
  if (opts.pauseIntervals !== false) {
    await store.setSetting('pauseIntervals', fixtures.visitData.pauseIntervals);
  }

  const historyProvider = {
    async search(query) {
      const startTime = Number(query.startTime) || 0;
      const byUrl = new Map();
      for (const visit of fixtures.visitData.visits) {
        if (visit.visitTime < startTime || visit.visitTime > clock.now) continue;
        const existing = byUrl.get(visit.url);
        if (!existing || visit.visitTime > existing.lastVisitTime) {
          byUrl.set(visit.url, { url: visit.url, title: visit.title, lastVisitTime: visit.visitTime });
        }
      }
      return Array.from(byUrl.values()).slice(0, query.maxResults || 5000);
    },
    async getVisits(url) {
      return fixtures.visitData.visits
        .filter(v => v.url === url && v.visitTime <= clock.now)
        .map(v => ({ visitId: v.visitId, visitTime: v.visitTime, transition: v.transition }));
    }
  };

  const transport = opts.transport || scriptedTransport(wellBehavedHandlers(fixtures.pages));
  const ollama = CTOllama.createClient({ transport, embeddingModel: 'bge-m3:latest',
    embeddingDimensions: 1024, chatModel: 'gemma3:12b', chatContextTokens: 16384, dutyCycle: 1, ...(opts.clientOptions || {}) });

  let topicSeq = 0;
  const pipeline = CTPipeline.createPipeline({
    store,
    historyProvider,
    ollama,
    now: () => clock.now,
    newTopicId: opts.deterministicIds === false ? undefined : () => `t-${String(++topicSeq).padStart(3, '0')}`,
    settings: { days: 28, maxNewPagesPerRun: 300, maxNewTopicsPerRun: 20, labelBatchSize: 14, pagesPerCluster: 8, textCharsPerPage: 200,
      classifyTransitionsWithModel: true, ...(opts.settings || {}) }
  });

  return {
    fixtures, store, clock, historyProvider, ollama, pipeline, transport,
    dayEnd,
    async runThroughDay(n, runOptions) {
      clock.now = dayEnd(n);
      return pipeline.run({ trigger: 'manual', ...(runOptions || {}) });
    }
  };
}

module.exports = { loadFixtures, makeEnv, scriptedTransport, wellBehavedHandlers, recordingTransport, goldenTransport };
