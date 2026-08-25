// Protocol tests (spec §7.2): the full pipeline over the committed fixtures
// with a scripted LLM transport. No Ollama, no Chrome.
'use strict';
const assert = require('assert');
const { makeEnv, scriptedTransport, wellBehavedHandlers, loadFixtures } = require('../helpers/pipelineHarness.js');

(async () => {
  // --- deterministic happy path: 2 days -> exact-ish registry state --------
  {
    const env = await makeEnv();
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, true);
    assert.ok(result.counts.visitsIngested > 20);
    assert.strictEqual(result.counts.pagesEmbedded, 0, 'all embeddings come from the committed cache');
    assert.ok(result.counts.embeddingsCached > 20);

    const topics = await env.store.getAll('topics');
    assert.strictEqual(topics.length, 8, 'day 1-2 fixture forms eight topics');
    const labels = topics.map(t => t.label).sort();
    for (const expected of ['Topic sourdough-baking', 'Topic rust-async', 'Topic attention-research']) {
      assert.ok(labels.includes(expected), `missing ${expected} in ${labels}`);
    }
    assert.ok(topics.every(t => t.state === 'active'));
    assert.ok(topics.every(t => t.topicId.startsWith('t-')), 'deterministic ids');

    const memberships = await env.store.getAll('memberships');
    assert.ok(memberships.length >= 25);
    const events = await env.store.getAll('topic_events');
    assert.strictEqual(events.filter(e => e.type === 'created').length, 8);
    assert.strictEqual(events.filter(e => e.type === 'dormant').length, 0, 'no lifecycle events on early runs');

    const metrics1 = await env.store.get('daily_metrics', '2026-03-01');
    const metrics2 = await env.store.get('daily_metrics', '2026-03-02');
    assert.ok(metrics1 && metrics2, 'both touched days get metrics');
    assert.ok(metrics2.categorizedShare > 0.8, 'nearly all fixture dwell is categorized');
    assert.ok(metrics2.topicEntropy > 1, 'multiple active topics -> entropy > 1 bit');
    assert.strictEqual(metrics2.lowData, false);

    const watermark = await env.store.getSetting('watermark');
    assert.strictEqual(watermark, env.clock.now, 'watermark moved to run start');

    const brief = await env.store.get('briefs', '2026-03-02');
    assert.ok(brief && brief.items.length >= 1);

    // A rerun with no new visits must be cheap and change nothing.
    const chatCallsBefore = env.ollama.stats.chatCalls;
    const rerun = await env.runThroughDay(2);
    assert.strictEqual(rerun.ok, true);
    assert.strictEqual((await env.store.getAll('topics')).length, 8, 'rerun does not duplicate topics');
    assert.strictEqual(rerun.counts.topicsCreated, 0);
  }

  // --- overlapping re-runs must not inflate the registry -----------------
  // Every run re-ingests a 2 h overlap window on purpose (§4.1). Membership
  // and topic dwell are therefore recomputed from each page's authoritative
  // visit totals, never accumulated; otherwise the same browsing is counted
  // again on every overlapping run and every topic-time claim inflates.
  {
    const env = await makeEnv();
    const anchor = new Date(env.fixtures.visitData.anchorDay1);
    const at = (day, hour, minute) =>
      new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + (day - 1), hour, minute).getTime();
    const totals = async () => {
      const memberships = await env.store.getAll('memberships');
      const topics = await env.store.getAll('topics');
      return {
        dwellMs: memberships.reduce((sum, m) => sum + m.dwellMs, 0),
        visitCount: memberships.reduce((sum, m) => sum + m.visitCount, 0),
        topicDwellMs: topics.reduce((sum, t) => sum + (t.totalDwellMs || 0), 0)
      };
    };

    // 19:30 on fixture day 2, just after the 19:00 session.
    env.clock.now = at(2, 19, 30);
    assert.strictEqual((await env.pipeline.run({ trigger: 'manual' })).ok, true);
    const first = await totals();
    assert.ok(first.dwellMs > 0 && first.visitCount > 0, 'the first run records dwell');

    // Two more runs whose `since` (watermark - 2 h) re-covers that session.
    for (const [hour, minute] of [[19, 45], [20, 0]]) {
      env.clock.now = at(2, hour, minute);
      assert.strictEqual((await env.pipeline.run({ trigger: 'manual' })).ok, true);
      const again = await totals();
      assert.strictEqual(again.dwellMs, first.dwellMs,
        `membership dwell must not change on an overlapping re-run (${again.dwellMs} vs ${first.dwellMs})`);
      assert.strictEqual(again.visitCount, first.visitCount, 'membership visit counts must not inflate');
      assert.strictEqual(again.topicDwellMs, first.topicDwellMs, 'topic dwell must not inflate');
    }

    // And the registry total must agree with the idempotent visits store.
    const visits = await env.store.getAll('visits');
    const memberedUrls = new Set((await env.store.getAll('memberships')).map(m => m.normalizedUrl));
    const visitDwell = visits
      .filter(v => memberedUrls.has(v.normalizedUrl))
      .reduce((sum, v) => sum + (v.dwellMs || 0), 0);
    assert.strictEqual(first.dwellMs, visitDwell,
      'membership dwell must equal the dwell of the visits it covers');
  }

  // --- Ollama down at embed: run fails at the stage, watermark unmoved ----
  {
    const fixtures = loadFixtures();
    const handlers = wellBehavedHandlers(fixtures.pages);
    handlers.embed = () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); };
    // A changed model name misses the committed cache, forcing embed calls.
    const env = await makeEnv({ transport: scriptedTransport(handlers), settings: { } });
    env.ollama.cfg.embeddingModel = 'bge-m3:other';
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, 'embed');
    assert.strictEqual(await env.store.getSetting('watermark'), undefined, 'watermark unmoved on failure');
    assert.strictEqual((await env.store.getAll('topics')).length, 0, 'no partial topic writes');
    const runs = await env.store.getAll('runs');
    assert.strictEqual(runs[0].status, 'failed');
    assert.strictEqual(runs[0].stage, 'embed');
  }

  // --- Ollama down at label (transport error, not parse): run fails -------
  {
    const fixtures = loadFixtures();
    const handlers = wellBehavedHandlers(fixtures.pages);
    handlers.label_topics = () => new Error('connect ECONNREFUSED');
    const env = await makeEnv({ transport: scriptedTransport(handlers) });
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, 'label');
    assert.strictEqual(await env.store.getSetting('watermark'), undefined);
    assert.strictEqual((await env.store.getAll('topics')).length, 0);
    // Idempotent stages did commit; a later run redoes the rest cheaply.
    assert.ok((await env.store.getAll('visits')).length > 0, 'ingest commit persists');
  }

  // --- registry commit failure: failed at registry, nothing written -------
  {
    const env = await makeEnv();
    const originalCommit = env.store.registryCommit.bind(env.store);
    env.store.registryCommit = async () => { throw new Error('injected registry failure'); };
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, 'registry');
    assert.strictEqual((await env.store.getAll('topics')).length, 0);
    assert.strictEqual((await env.store.getAll('memberships')).length, 0);
    assert.strictEqual(await env.store.getSetting('watermark'), undefined);
    // Recovery: restore and rerun succeeds from cached work.
    env.store.registryCommit = originalCommit;
    const retry = await env.runThroughDay(2);
    assert.strictEqual(retry.ok, true);
    assert.strictEqual((await env.store.getAll('topics')).length, 8);
  }

  // --- timeout mid-adjudication: topic kept, errors counted, run ok -------
  {
    const fixtures = loadFixtures();
    const handlers = wellBehavedHandlers(fixtures.pages);
    let adjCalls = 0;
    handlers.adjudicate_pass1 = () => { adjCalls++; return new Error('timeout after 180000 ms'); };
    handlers.adjudicate_pass2 = () => ({ verdict: 'keep', confidence: 0.8 });
    // The fixture's day 1-2 topics are cohesive, so nothing would normally be
    // audited; force the gate open to exercise the error path.
    const env = await makeEnv({
      transport: scriptedTransport(handlers),
      settings: { cohesionThreshold: 0.99 }
    });
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, true, 'adjudication failures never fail the run');
    assert.ok(result.counts.errors >= 1);
    assert.strictEqual((await env.store.getAll('topics')).length, 8, 'audited topics kept on error');
    const uncategorized = await env.store.getAll('uncategorized');
    assert.ok(!uncategorized.some(u => u.reason === 'disagreement'), 'errors are not disagreement');
  }

  // --- malformed JSON in one label batch: other batches applied -----------
  {
    const fixtures = loadFixtures();
    const handlers = wellBehavedHandlers(fixtures.pages);
    const good = handlers.label_topics;
    let batchIndex = 0;
    handlers.label_topics = body => {
      batchIndex++;
      if (batchIndex === 1) return 'this is not JSON at all {{{';
      return good(body);
    };
    // Batch size 4 so the 8 clusters need 2 calls.
    const env = await makeEnv({ transport: scriptedTransport(handlers), settings: { labelBatchSize: 4 } });
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, true, 'a malformed batch does not fail the run');
    const topics = await env.store.getAll('topics');
    const keywordLabeled = topics.filter(t => t.labelSource === 'keywords');
    const llmLabeled = topics.filter(t => t.labelSource === 'llm');
    assert.ok(keywordLabeled.length >= 1, 'first batch fell back to keyword labels');
    assert.ok(llmLabeled.length >= 1, 'second batch got its LLM labels');
  }

  // --- model returns ids not in payload: ignored, keyword labels stand ----
  {
    const fixtures = loadFixtures();
    const handlers = wellBehavedHandlers(fixtures.pages);
    handlers.label_topics = () => ({
      topics: [{ id: 'c999', label: 'Phantom topic', confidence: 0.9, rationale: 'x' }]
    });
    const env = await makeEnv({ transport: scriptedTransport(handlers) });
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, true);
    const topics = await env.store.getAll('topics');
    assert.ok(!topics.some(t => t.label === 'Phantom topic'), 'unknown ids are ignored');
    assert.ok(topics.every(t => t.labelSource === 'keywords'), 'clusters keep keyword labels');
  }

  console.log('protocol tests passed');
})().catch(error => { console.error(error); process.exit(1); });
