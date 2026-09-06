'use strict';
const assert = require('assert');
const CTStore = require('../../lib/store.js');
const CTText = require('../../lib/text.js');
const CTPipeline = require('../../lib/pipeline.js');
const { makeEnv, loadFixtures, scriptedTransport, wellBehavedHandlers } = require('../helpers/pipelineHarness.js');

(async () => {
  // Atomic registry failure cannot falsely complete durable page work.
  {
    const env = await makeEnv();
    const realCommit = env.store.registryCommit.bind(env.store);
    env.store.registryCommit = payload => realCommit(payload, { injectErrorAfterTopics: true });
    const failed = await env.runThroughDay(2);
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.stage, 'registry');
    assert.strictEqual((await env.store.getAll('topics')).length, 0);
    const pending = await env.store.getAll('pages');
    assert.ok(pending.some(p => p.embeddingKey && p.needsClassification));
    assert.ok(!pending.some(p => p.classificationStatus === 'categorized'));
    env.store.registryCommit = realCommit;
    assert.strictEqual((await env.runThroughDay(2)).ok, true);
    assert.ok(!(await env.store.getAll('pages')).some(p => p.needsClassification));
  }

  // A crash after registry commit leaves historical metric repair durable.
  {
    const env = await makeEnv();
    const realDayCommit = env.store.dayCommit.bind(env.store);
    env.store.dayCommit = async () => { throw new Error('power loss before derived metrics'); };
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, false);
    assert.ok((await env.store.getAll('memberships')).length > 0);
    assert.ok((await env.store.getAll('pages')).some(p => p.metricsDirty));
    const ids = (await env.store.getAll('topics')).map(t => t.topicId);
    // Recovery has no current-window visits at all: dirty pages alone must
    // repair the old day and avoid duplicating committed topics.
    env.historyProvider.search = async () => [];
    env.store.dayCommit = realDayCommit;
    assert.strictEqual((await env.runThroughDay(3)).ok, true);
    assert.deepStrictEqual((await env.store.getAll('topics')).map(t => t.topicId), ids);
    assert.ok((await env.store.get('daily_metrics', '2026-03-01')).categorizedShare > 0.8);
    assert.ok(!(await env.store.getAll('pages')).some(p => p.metricsDirty));
  }

  // Legacy embedded rows without outcomes are repaired after their overlap.
  {
    const env = await makeEnv();
    assert.strictEqual((await env.runThroughDay(2)).ok, true);
    const membership = (await env.store.getAll('memberships'))[0];
    await env.store.delete('memberships', [membership.topicId, membership.normalizedUrl]);
    const page = await env.store.get('pages', membership.normalizedUrl);
    delete page.classificationStatus;
    delete page.classificationReason;
    delete page.needsClassification;
    await env.store.put('pages', page);
    env.historyProvider.search = async () => [];
    assert.strictEqual((await env.runThroughDay(3)).ok, true);
    const repaired = await env.store.get('pages', page.normalizedUrl);
    assert.ok(['categorized', 'excluded'].includes(repaired.classificationStatus));
    assert.strictEqual(repaired.needsClassification, false);
  }

  // A revisited member of a retired topic enters normal assignment again.
  {
    const env = await makeEnv();
    assert.strictEqual((await env.runThroughDay(2)).ok, true);
    const topics = await env.store.getAll('topics');
    const retired = topics[0];
    await env.store.put('topics', { ...retired, state: 'retired' });
    const member = (await env.store.getAll('memberships')).find(m => m.topicId === retired.topicId);
    const original = env.fixtures.pages.find(p => CTText.normalizeUrl(p.url) === member.normalizedUrl);
    env.fixtures.visitData.visits.push({ visitId: 'return-after-retirement', url: original.url,
      title: original.title, visitTime: env.dayEnd(3) - 60 * 60 * 1000, transition: 'link' });
    assert.strictEqual((await env.runThroughDay(3)).ok, true);
    const owners = (await env.store.getAll('memberships')).filter(m => m.normalizedUrl === member.normalizedUrl);
    assert.strictEqual(owners.length, 1, 'reclassification removes obsolete ownership atomically');
    assert.notStrictEqual(owners[0].topicId, retired.topicId);
    assert.strictEqual((await env.store.get('topics', retired.topicId)).state, 'retired');
  }

  // Cache corruption is replaced before the first clustering operation.
  {
    const fixtures = loadFixtures();
    const handlers = wellBehavedHandlers(fixtures.pages);
    handlers.embed = body => ({ embeddings: body.input.map(input => {
      const page = fixtures.pages.find(p => input.startsWith(`${p.title}\n${p.domain}\n`));
      assert.ok(page, 'corrupt entry is re-embedded from its real current evidence');
      return Array.from(fixtures.vectorByUrl.get(page.url));
    }) });
    const env = await makeEnv({ transport: scriptedTransport(handlers) });
    const cached = await env.store.getAll('embeddings');
    const target = cached.find(row => env.fixtures.visitData.visits.some(v => {
      const p = env.fixtures.pages.find(p => p.url === v.url);
      return v.visitTime < env.dayEnd(2) && p && CTPipeline.embeddingKeyFor('bge-m3:latest',
        CTPipeline.embeddingInput({ ...p, captureText: p.extractedText })) === row.key;
    }));
    assert.ok(target);
    await env.store.put('embeddings', { ...target, vector: CTStore.vecToBuf(Float32Array.from([NaN, 0])), dim: 2 });
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.counts.pagesEmbedded, 1);
    const fixed = await env.store.getEmbedding(target.key);
    assert.strictEqual(fixed.dim, 1024);
    assert.ok(Array.from(CTStore.bufToVec(fixed.vector)).every(Number.isFinite));
    assert.deepStrictEqual(await env.store.getSetting('embeddingSpace'),
      { version: 1, model: 'bge-m3:latest', dimension: 1024 });
  }

  // Mixed spaces are refused without touching the committed record. The
  // legacy model-string setting migrates only after dimensions are checked.
  {
    const env = await makeEnv();
    assert.strictEqual((await env.runThroughDay(2)).ok, true);
    await env.store.setSetting('embeddingSpace', 'bge-m3:latest');
    assert.strictEqual((await env.runThroughDay(2)).ok, true);
    assert.strictEqual((await env.store.getSetting('embeddingSpace')).dimension, 1024);
    const before = await env.store.getAll('topics');
    const watermark = await env.store.getSetting('watermark');
    env.ollama.cfg.embeddingDimensions = 768;
    const badDimension = await env.runThroughDay(3);
    assert.strictEqual(badDimension.ok, false);
    assert.match(badDimension.error, /incompatible embedding space/);
    assert.deepStrictEqual(await env.store.getAll('topics'), before);
    assert.strictEqual(await env.store.getSetting('watermark'), watermark);
    env.ollama.cfg.embeddingDimensions = 1024;
    env.ollama.cfg.embeddingModel = 'different-model';
    assert.strictEqual((await env.runThroughDay(3)).ok, false);
    assert.deepStrictEqual(await env.store.getAll('topics'), before);
  }

  // Deletion's import boundary overrides both first-run and overlap horizons.
  {
    const env = await makeEnv();
    await env.store.setSetting('historyImportAfter', env.dayEnd(1));
    assert.strictEqual((await env.runThroughDay(2)).ok, true);
    const visits = await env.store.getAll('visits');
    assert.ok(visits.length > 0);
    assert.ok(visits.every(v => v.visitTime >= env.dayEnd(1)));
    assert.ok(!(await env.store.get('daily_metrics', '2026-03-01')));
  }

  // The tail of a capped chat is real new embedding evidence; a stable head
  // cannot make a long conversation permanently stop updating.
  {
    const page = { title: 'Conversation', domain: 'chat.example', source: 'llm_chat' };
    const head = 'Shared initial material '.repeat(400);
    const first = CTPipeline.embeddingInput({ ...page, captureText: head + 'Old final question' });
    const second = CTPipeline.embeddingInput({ ...page, captureText: head + 'A different final question' });
    assert.notStrictEqual(first, second);
    assert.ok(first.length < 1600 && second.length < 1600, 'model input remains bounded');
  }

  // The current production algorithms, with deterministic model responses,
  // preserve identity and complete deliberate outcomes across a full month.
  {
    const env = await makeEnv();
    for (const day of [7, 14, 21, 25, 28]) {
      const result = await env.runThroughDay(day);
      assert.strictEqual(result.ok, true, `day ${day}: ${result.error}`);
    }
    const events = await env.store.getAll('topic_events');
    assert.ok(events.some(e => e.type === 'dormant'));
    assert.ok(events.some(e => e.type === 'revived'));
    const pages = await env.store.getAll('pages');
    assert.ok(pages.every(p => ['categorized', 'excluded'].includes(p.classificationStatus)));
    const memberships = await env.store.getAll('memberships');
    const owners = new Map();
    for (const m of memberships) {
      assert.ok(!owners.has(m.normalizedUrl), 'every page has at most one current topic owner');
      owners.set(m.normalizedUrl, m.topicId);
    }
    for (const topic of await env.store.getAll('topics')) {
      const expected = memberships.filter(m => m.topicId === topic.topicId)
        .reduce((sum, m) => sum + m.dwellMs, 0);
      assert.strictEqual(topic.totalDwellMs, expected, 'registry totals remain authoritative across a month');
    }
  }

  // Completed embedding batches survive the machine becoming active mid-run.
  {
    const fixtures = loadFixtures();
    const handlers = wellBehavedHandlers(fixtures.pages);
    handlers.embed = body => ({ embeddings: body.input.map(input => {
      const page = fixtures.pages.find(p => input.startsWith(`${p.title}\n${p.domain}\n`));
      return Array.from(fixtures.vectorByUrl.get(page.url));
    }) });
    let calls = 0;
    const env = await makeEnv({ transport: scriptedTransport(handlers), clientOptions: { embedBatchSize: 2, beforeCall: () => {
      if (++calls > 1) { const error = new Error('Laptop became active'); error.code = 'deferred'; throw error; }
    } } });
    await env.store.clear('embeddings');
    const interrupted = await env.runThroughDay(1);
    assert.equal(interrupted.deferred, true);
    assert.equal((await env.store.getAll('embeddings')).length, 2, 'completed batch remains durable');
    assert.ok(!(await env.store.getSetting('watermark')));
    assert.equal((await env.store.getAll('topics')).length, 0, 'no partial topic registry');
    env.ollama.cfg.beforeCall = null;
    const resumed = await env.runThroughDay(1);
    assert.ok(resumed.ok, resumed.error);
    assert.equal(resumed.counts.embeddingsCached, 2, 'resume reuses completed model work');
  }

  console.log('reliability protocol tests passed');
})().catch(error => { console.error(error); process.exit(1); });
