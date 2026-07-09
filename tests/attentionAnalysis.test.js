const assert = require('assert');
const AttentionAnalysis = require('../attentionAnalysis.js');

function item(url, title, lastVisitTime) {
  return { url, title, lastVisitTime };
}

function visit(id, visitTime) {
  return { visitId: id, visitTime, transition: 'link' };
}

function buildSampleEvents() {
  const base = Date.now() - 6 * 60 * 60 * 1000;
  const history = [
    item('https://github.com/facebook/react/issues/1', 'React useEffect issue', base),
    item('https://react.dev/reference/react/useEffect', 'React useEffect documentation', base + 2 * 60000),
    item('https://stackoverflow.com/questions/react-useeffect-loop', 'React useEffect loop question', base + 5 * 60000),
    item('https://nytimes.com/markets/inflation-update', 'Inflation and market update', base + 9 * 60000),
    item('https://amazon.com/dp/standing-desk', 'Standing desk product page', base + 12 * 60000)
  ];
  const visits = {};
  history.forEach((entry, index) => {
    visits[entry.url] = [visit(`v-${index}`, entry.lastVisitTime)];
  });
  return AttentionAnalysis.buildVisitEventsFromHistoryItems(history, visits).events;
}

async function testRepeatedVisitsRemainEvents() {
  const base = Date.now() - 2 * 60 * 60 * 1000;
  const history = [
    item('https://example.com/article', 'Example Article', base + 70 * 60000)
  ];
  const visits = {
    'https://example.com/article': [
      visit('first', base),
      visit('second', base + 5 * 60000),
      visit('third', base + 70 * 60000)
    ]
  };
  const loaded = AttentionAnalysis.buildVisitEventsFromHistoryItems(history, visits);
  assert.strictEqual(loaded.events.length, 3, 'repeat visits should be preserved as separate visit events');
  assert.strictEqual(loaded.events[0].dwellMs, 5 * 60000, 'dwell should use time until next visit');
  assert.strictEqual(loaded.events[1].dwellMs, 30 * 60000, 'dwell should be capped at 30 minutes across a session break');
  assert.strictEqual(loaded.events[1].endsSession, true, 'long gaps should mark a session break');
}

async function testSameDomainDoesNotForceSameTopic() {
  const base = Date.now() - 60 * 60000;
  const history = [
    item('https://github.com/rails/rails/issues/1', 'Ruby ActiveRecord connection pooling', base),
    item('https://github.com/tensorflow/tensorflow/issues/2', 'TensorFlow GPU memory allocator', base + 2 * 60000)
  ];
  const visits = {};
  history.forEach((entry, index) => {
    visits[entry.url] = [visit(`same-domain-${index}`, entry.lastVisitTime)];
  });
  const events = AttentionAnalysis.buildVisitEventsFromHistoryItems(history, visits).events;
  const pages = AttentionAnalysis.aggregatePages(events).map(page => ({
    ...page,
    embedding: AttentionAnalysis.fallbackPageVector(page)
  }));
  const clusters = AttentionAnalysis.buildInitialClusters(pages, {
    maxTopicCount: 12,
    adjacentTopicThreshold: 0.46
  });
  assert.strictEqual(clusters.length, 2, 'unrelated pages on the same domain should not be automatically merged');
}

async function testFencedJsonParsing() {
  const parsed = AttentionAnalysis.parseOllamaJson('```json\n{"topic":"test","confidence":0.82}\n```');
  assert.deepStrictEqual(parsed, { topic: 'test', confidence: 0.82 });
}

async function testAnalysisCreatesEvidenceAndValidationQueue() {
  const analysis = await AttentionAnalysis.analyzeVisitEvents(buildSampleEvents(), {
    useOllama: false,
    maxPagesForAi: 20
  });
  assert.strictEqual(analysis.ok, true);
  assert.ok(analysis.topics.length >= 2, 'sample history should produce multiple topics');
  assert.ok(analysis.topics.every(topic => topic.topPages.length > 0), 'each topic should expose page evidence');
  assert.ok(analysis.transitions.length > 0, 'analysis should produce observed transitions');
  assert.ok(analysis.validationQueue.some(item => item.kind === 'topic'), 'fallback/non-LLM topics should appear in validation queue');
}

async function testLowConfidenceTransitionsAppearInQueue() {
  const analysis = await AttentionAnalysis.analyzeVisitEvents(buildSampleEvents(), {
    useOllama: false,
    maxPagesForAi: 20
  });
  assert.ok(
    analysis.validationQueue.some(item => item.kind === 'transition'),
    'borderline or low-confidence transitions should be reviewable'
  );
}

async function testOllamaOriginRejectionIsAuditable() {
  const originalFetch = global.fetch;
  const originalLocation = global.location;
  global.location = { origin: 'chrome-extension://test-extension-id' };
  global.fetch = async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    json: async () => ({})
  });
  try {
    const health = await AttentionAnalysis.checkOllamaHealth();
    assert.strictEqual(health.ok, false);
    assert.strictEqual(health.reachable, true, '403 means Ollama is reachable but rejected the origin');
    assert.strictEqual(health.originRejected, true);
    assert.strictEqual(health.origin, 'chrome-extension://test-extension-id');
  } finally {
    global.fetch = originalFetch;
    global.location = originalLocation;
  }
}

async function testForcedMergeOfUnrelatedDomainsLowersConfidence() {
  const base = Date.now() - 3 * 60 * 60000;
  const history = [
    item('https://amazon.com/dp/standing-desk', 'Standing desk deal', base),
    item('https://amazon.com/dp/office-chair', 'Ergonomic office chair', base + 2 * 60000),
    item('https://reddit.com/r/buildapc/comments/1', 'Best budget GPU thread', base + 20 * 60000),
    item('https://reddit.com/r/buildapc/comments/2', 'PC case airflow discussion', base + 22 * 60000)
  ];
  const visits = {};
  history.forEach((entry, index) => { visits[entry.url] = [visit(`forced-${index}`, entry.lastVisitTime)]; });
  const events = AttentionAnalysis.buildVisitEventsFromHistoryItems(history, visits).events;
  const pages = AttentionAnalysis.aggregatePages(events).map(page => ({
    ...page,
    embedding: AttentionAnalysis.fallbackPageVector(page)
  }));
  const clusters = AttentionAnalysis.buildInitialClusters(pages, {
    maxTopicCount: 1,
    topicClusterThreshold: 0.95,
    topicMergeThreshold: -1
  });
  assert.strictEqual(clusters.length, 1, 'squeezing to maxTopicCount=1 should merge every cluster');
  assert.ok(clusters[0].topDomains.length >= 2, 'the forced merge should actually span multiple domains');
  assert.ok(
    clusters[0].confidence < 0.68,
    'a cluster spanning unrelated domains without one dominant domain should read as low confidence, not a confident blended label'
  );
}

async function testCorrectionsRefreshDerivedMetrics() {
  const analysis = await AttentionAnalysis.analyzeVisitEvents(buildSampleEvents(), {
    useOllama: false,
    maxPagesForAi: 20
  });
  const crossTopicTransition = analysis.transitions.find(t => t.sourceTopicId !== t.targetTopicId);
  assert.ok(crossTopicTransition, 'sample history should include a cross-topic transition to correct');
  const correctedType = crossTopicTransition.type === 'topic_switch' ? 'adjacent_topic_jump' : 'topic_switch';
  const before = analysis.metrics.transitionMix.items.find(item => item.type === correctedType).count;
  AttentionAnalysis.applyCorrections(analysis, [
    { kind: 'transition', targetId: crossTopicTransition.id, type: correctedType }
  ]);
  const after = analysis.metrics.transitionMix.items.find(item => item.type === correctedType).count;
  assert.strictEqual(
    after,
    before + crossTopicTransition.visitCount,
    'transitionMix counts should reflect a corrected transition type, not the stale pre-correction aggregate'
  );
}

async function testEmbeddingCacheAvoidsRefetch() {
  const originalFetch = global.fetch;
  let embedCalls = 0;
  global.fetch = async (url, options) => {
    embedCalls++;
    const body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ embeddings: body.input.map(() => [1, 0, 0]) })
    };
  };
  try {
    const first = await AttentionAnalysis.embedTextsCached(['alpha topic', 'beta topic']);
    assert.strictEqual(embedCalls, 1, 'first run should call the embed endpoint');
    assert.strictEqual(first.cachedCount, 0);
    assert.strictEqual(first.embeddings.length, 2);
    const second = await AttentionAnalysis.embedTextsCached(['alpha topic', 'beta topic', 'gamma topic']);
    assert.strictEqual(second.cachedCount, 2, 'previously embedded texts should come from the cache');
    assert.strictEqual(second.embeddedCount, 1, 'only new texts should be embedded');
    assert.strictEqual(embedCalls, 2, 'second run should only embed the new text');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testStoredAnalysisIsReusedUntilRerun() {
  const analysis = await AttentionAnalysis.analyzeVisitEvents(buildSampleEvents(), {
    useOllama: false,
    maxPagesForAi: 20
  });
  await AttentionAnalysis.saveLatestAnalysis(analysis);
  const stored = await AttentionAnalysis.getStoredAnalysis();
  assert.ok(stored, 'a saved analysis should be retrievable without re-running');
  assert.strictEqual(stored.fromCache, true, 'stored analysis should be marked as cached');
  assert.strictEqual(stored.topics.length, analysis.topics.length, 'stored analysis should keep its topics');
}

async function run() {
  await testRepeatedVisitsRemainEvents();
  await testSameDomainDoesNotForceSameTopic();
  await testFencedJsonParsing();
  await testAnalysisCreatesEvidenceAndValidationQueue();
  await testLowConfidenceTransitionsAppearInQueue();
  await testOllamaOriginRejectionIsAuditable();
  await testForcedMergeOfUnrelatedDomainsLowersConfidence();
  await testCorrectionsRefreshDerivedMetrics();
  await testEmbeddingCacheAvoidsRefetch();
  await testStoredAnalysisIsReusedUntilRerun();
  console.log('attentionAnalysis tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
