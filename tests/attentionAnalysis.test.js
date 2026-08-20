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

function buildMixedDomainPages() {
  const base = Date.now() - 3 * 60 * 60000;
  const history = [
    item('https://amazon.com/dp/standing-desk', 'Standing desk deal', base),
    item('https://amazon.com/dp/office-chair', 'Ergonomic office chair', base + 2 * 60000),
    item('https://reddit.com/r/buildapc/comments/1', 'Best budget GPU thread', base + 20 * 60000),
    item('https://reddit.com/r/buildapc/comments/2', 'PC case airflow discussion', base + 22 * 60000)
  ];
  const visits = {};
  history.forEach((entry, index) => { visits[entry.url] = [visit(`mixed-${index}`, entry.lastVisitTime)]; });
  const events = AttentionAnalysis.buildVisitEventsFromHistoryItems(history, visits).events;
  return AttentionAnalysis.aggregatePages(events).map(page => ({
    ...page,
    embedding: AttentionAnalysis.fallbackPageVector(page)
  }));
}

// Forces the mixed-domain pages into one low-confidence blended cluster so
// adjudication tests have a guaranteed candidate.
function buildForcedMergedTopic() {
  const pages = buildMixedDomainPages();
  const topics = AttentionAnalysis.buildInitialClusters(pages, {
    maxTopicCount: 1,
    topicClusterThreshold: 0.95,
    topicMergeThreshold: -1
  });
  assert.strictEqual(topics.length, 1, 'setup: forced merge should produce one cluster');
  assert.ok(topics[0].confidence < 0.68, 'setup: forced merge should be a low-confidence adjudication candidate');
  return { pages, topics, pagesById: new Map(pages.map(page => [page.id, page])) };
}

// Queues canned /api/chat responses; each entry becomes one chatJson result.
function mockChatResponses(responses) {
  const queue = responses.slice();
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (!queue.length) throw new Error('mock chat queue exhausted');
    return {
      ok: true,
      json: async () => ({ message: { content: JSON.stringify(queue.shift()) } })
    };
  };
  return calls;
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
  assert.strictEqual(loaded.events[1].endsSession, true, 'long gaps should mark a session break');
  assert.strictEqual(
    loaded.events[1].dwellMs,
    60000,
    'a session-ending visit should get the small fixed allowance, not up to 30 phantom minutes'
  );
  assert.strictEqual(loaded.events[2].dwellMs, 60000, 'the final visit should also get the session-end allowance');
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

async function testAnalysisExposesEvidence() {
  const analysis = await AttentionAnalysis.analyzeVisitEvents(buildSampleEvents(), {
    useOllama: false,
    maxPagesForAi: 20
  });
  assert.strictEqual(analysis.ok, true);
  assert.ok(analysis.topics.length >= 2, 'sample history should produce multiple topics');
  assert.ok(analysis.topics.every(topic => topic.topPages.length > 0), 'each topic should expose page evidence');
  assert.ok(analysis.transitions.length > 0, 'analysis should produce observed transitions');
  assert.ok(analysis.uncategorized, 'analysis should always report an uncategorized bucket');
  assert.strictEqual(analysis.uncategorized.pageCount, 0, 'without adjudication nothing is uncategorized');
  assert.strictEqual(analysis.validationQueue, undefined, 'the manual review queue should no longer exist');
}

async function testForcedMergeOfUnrelatedDomainsLowersConfidence() {
  const { topics } = buildForcedMergedTopic();
  assert.ok(topics[0].topDomains.length >= 2, 'the forced merge should actually span multiple domains');
  assert.ok(
    topics[0].confidence < 0.68,
    'a cluster spanning unrelated domains without one dominant domain should read as low confidence'
  );
}

async function testAdjudicationAgreedUncategorized() {
  const { topics, pagesById } = buildForcedMergedTopic();
  const originalFetch = global.fetch;
  mockChatResponses([
    { verdict: 'uncategorized', confidence: 0.3, rationale: 'Unrelated shopping and PC pages.' },
    { verdict: 'uncategorized', confidence: 0.35, rationale: 'No single theme.' }
  ]);
  try {
    const result = await AttentionAnalysis.adjudicateUncertainTopics(topics, pagesById, {});
    assert.strictEqual(result.topics.length, 0, 'an agreed uncategorized verdict should remove the topic');
    assert.strictEqual(result.uncategorizedPages.length, 4, 'all pages should land in the uncategorized bucket');
    assert.strictEqual(result.adjudicationSummary.uncategorized, 1);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testAdjudicationDisagreementIsUncategorized() {
  const { topics, pagesById } = buildForcedMergedTopic();
  const originalFetch = global.fetch;
  mockChatResponses([
    { verdict: 'keep', label: 'Shopping', confidence: 0.8, rationale: 'All shopping.' },
    { verdict: 'uncategorized', confidence: 0.4, rationale: 'Mixed.' }
  ]);
  try {
    const result = await AttentionAnalysis.adjudicateUncertainTopics(topics, pagesById, {});
    assert.strictEqual(
      result.topics.length,
      0,
      'when the two passes disagree the machine must not guess; pages go to uncategorized'
    );
    assert.strictEqual(result.uncategorizedPages.length, 4);
    assert.strictEqual(result.adjudicationSummary.disagreed, 1);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testAdjudicationAgreedSplit() {
  const { topics, pagesById } = buildForcedMergedTopic();
  const originalFetch = global.fetch;
  mockChatResponses([
    {
      verdict: 'split',
      confidence: 0.8,
      rationale: 'Two distinct threads.',
      groups: [
        { label: 'Desk shopping', page_indexes: [0, 1] },
        { label: 'PC building', page_indexes: [2, 3] }
      ]
    },
    { verdict: 'split', confidence: 0.75, rationale: 'Two distinct threads.' }
  ]);
  try {
    const result = await AttentionAnalysis.adjudicateUncertainTopics(topics, pagesById, {});
    assert.strictEqual(result.topics.length, 2, 'an agreed split should produce the grouped topics');
    assert.strictEqual(result.uncategorizedPages.length, 0, 'a clean split leaves nothing uncategorized');
    const totalPages = result.topics.reduce((sum, topic) => sum + topic.pageIds.length, 0);
    assert.strictEqual(totalPages, 4, 'every page should be in exactly one split topic');
    assert.ok(result.topics.every(topic => topic.adjudication === 'split'));
    assert.ok(result.topics.every(topic => topic.llmLabeled));
  } finally {
    global.fetch = originalFetch;
  }
}

async function testAdjudicationAgreedKeepRaisesConfidence() {
  const { topics, pagesById } = buildForcedMergedTopic();
  const before = topics[0].confidence;
  const originalFetch = global.fetch;
  mockChatResponses([
    { verdict: 'keep', label: 'Home office setup', confidence: 0.82, rationale: 'All home-office research.' },
    { verdict: 'keep', label: 'Home office setup', confidence: 0.78, rationale: 'Same task.' }
  ]);
  try {
    const result = await AttentionAnalysis.adjudicateUncertainTopics(topics, pagesById, {});
    assert.strictEqual(result.topics.length, 1);
    assert.strictEqual(result.topics[0].label, 'Home office setup');
    assert.ok(result.topics[0].confidence > before, 'an agreed keep verdict should raise confidence');
    assert.strictEqual(result.topics[0].adjudication, 'kept');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testAdjudicationLlmErrorKeepsTopic() {
  const { topics, pagesById } = buildForcedMergedTopic();
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('ollama offline'); };
  try {
    const result = await AttentionAnalysis.adjudicateUncertainTopics(topics, pagesById, {});
    assert.strictEqual(result.topics.length, 1, 'an infrastructure failure must not dump pages into uncategorized');
    assert.strictEqual(result.uncategorizedPages.length, 0);
    assert.strictEqual(result.adjudicationSummary.errors, 1);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testAdjudicationRespectsComputeCap() {
  const { topics, pagesById } = buildForcedMergedTopic();
  const originalFetch = global.fetch;
  const calls = mockChatResponses([
    { verdict: 'keep', label: 'Kept', confidence: 0.8, rationale: 'ok' },
    { verdict: 'keep', label: 'Kept', confidence: 0.8, rationale: 'ok' }
  ]);
  try {
    await AttentionAnalysis.adjudicateUncertainTopics(topics, pagesById, { maxTopicAdjudications: 1 });
    assert.strictEqual(calls.length, 2, 'each adjudicated topic costs exactly two chat calls');
  } finally {
    global.fetch = originalFetch;
  }
}

function makeTransition(overrides) {
  return {
    id: 'transition-x',
    sourceTopicId: 'topic-1',
    targetTopicId: 'topic-2',
    sourceLabel: 'React work',
    targetLabel: 'Market news',
    similarity: 0.6,
    type: 'adjacent_topic_jump',
    label: 'Related continuation',
    color: '#0d9488',
    confidence: 0.55,
    rationale: 'first pass',
    visitCount: 3,
    representativeVisits: [],
    hourCounts: new Array(24).fill(0),
    llmLabeled: true,
    ...overrides
  };
}

async function testTransitionVerificationAgreementBoostsConfidence() {
  const originalFetch = global.fetch;
  mockChatResponses([
    { transitions: [{ id: 'transition-x', type: 'adjacent_topic_jump', confidence: 0.85 }] }
  ]);
  try {
    const result = await AttentionAnalysis.verifyBorderlineTransitions([makeTransition({})], {});
    assert.strictEqual(result[0].type, 'adjacent_topic_jump');
    assert.ok(result[0].confidence >= 0.85, 'agreement should raise confidence');
    assert.strictEqual(result[0].verified, true);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testTransitionVerificationDisagreementFallsBackToHeuristic() {
  const originalFetch = global.fetch;
  mockChatResponses([
    { transitions: [{ id: 'transition-x', type: 'topic_switch', confidence: 0.9 }] }
  ]);
  try {
    // similarity 0.6 >= adjacentTopicThreshold 0.58, so the heuristic says
    // adjacent_topic_jump; the second pass says topic_switch. Disagreement
    // must fall back to the heuristic, marked uncertain.
    const result = await AttentionAnalysis.verifyBorderlineTransitions([makeTransition({})], {});
    assert.strictEqual(result[0].type, 'adjacent_topic_jump');
    assert.strictEqual(result[0].uncertain, true);
    assert.strictEqual(result[0].llmLabeled, false);
    assert.ok(result[0].confidence <= 0.45, 'disagreement should lower confidence');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testCheckForNewHistoryCountsFreshVisits() {
  const since = Date.now() - 60 * 60000;
  const chromeApi = {
    history: {
      search(query, callback) {
        callback([
          item('https://example.com/new-article', 'New article', since + 5 * 60000),
          item('https://www.google.com/search?q=x', 'Search', since + 6 * 60000),
          item('https://example.com/old', 'Old page', since - 5 * 60000)
        ]);
      }
    },
    runtime: {}
  };
  const result = await AttentionAnalysis.checkForNewHistory(since, { chromeApi });
  assert.strictEqual(result.checked, true);
  assert.strictEqual(result.newItemCount, 1, 'search-engine domains and pre-analysis items should not count');
  const noApi = await AttentionAnalysis.checkForNewHistory(since, { chromeApi: null });
  assert.strictEqual(noApi.checked, false, 'missing chrome API should report unchecked, not throw');
}

async function testCorrectionsMatchTopicsByPageOverlapAcrossReruns() {
  const analysis = await AttentionAnalysis.analyzeVisitEvents(buildSampleEvents(), {
    useOllama: false,
    maxPagesForAi: 20
  });
  const topic = analysis.topics[0];
  AttentionAnalysis.applyCorrections(analysis, [{
    kind: 'topic',
    targetId: 'topic-id-from-a-previous-run',
    label: 'My corrected label',
    pageUrls: topic.pageUrls
  }]);
  assert.strictEqual(
    topic.label,
    'My corrected label',
    'a correction whose old topic id is gone should re-attach via page overlap'
  );
  assert.strictEqual(topic.userCorrected, true);
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
  const byHourTotal = analysis.metrics.switchBurden.switchesByHour.reduce((sum, entry) => sum + entry.count, 0);
  assert.strictEqual(
    byHourTotal,
    analysis.metrics.switchBurden.switchCount,
    'the hour-of-day switch histogram should stay consistent with the switch count after corrections'
  );
}

async function testSwitchesByHourMatchesSwitchCount() {
  const analysis = await AttentionAnalysis.analyzeVisitEvents(buildSampleEvents(), {
    useOllama: false,
    maxPagesForAi: 20
  });
  const byHour = analysis.metrics.switchBurden.switchesByHour;
  assert.strictEqual(byHour.length, 24, 'histogram should cover every hour of the day');
  const total = byHour.reduce((sum, entry) => sum + entry.count, 0);
  assert.strictEqual(total, analysis.metrics.switchBurden.switchCount);
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

async function testSettingsOnlyPersistEditableKeys() {
  const saved = await AttentionAnalysis.TrustStore.saveSettings({
    days: 14,
    chatModel: 'gemma3:12b-32k',
    ollamaBaseUrl: 'http://evil.example.com',
    forceRefresh: true
  });
  assert.strictEqual(saved.days, 14);
  assert.strictEqual(saved.chatModel, 'gemma3:12b-32k');
  assert.strictEqual(saved.ollamaBaseUrl, undefined, 'non-editable keys must not persist');
  assert.strictEqual(saved.forceRefresh, undefined);
  const loaded = await AttentionAnalysis.TrustStore.getSettings();
  assert.strictEqual(loaded.days, 14);
}

async function testChatRequestsExplicitContextWindow() {
  const originalFetch = global.fetch;
  let body = null;
  global.fetch = async (url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ message: { content: '{"transitions":[]}' } }) };
  };
  try {
    await AttentionAnalysis.verifyBorderlineTransitions([makeTransition({})], {});
    // The default chat model must be a real public Ollama tag, and the context
    // window must be requested per call -- the old default ("gemma3:12b-32k")
    // was a hand-built Modelfile that does not exist in the Ollama library, so
    // a fresh clone failed with "pull model manifest: file does not exist".
    assert.ok(!/-32k$/.test(AttentionAnalysis.DEFAULTS.chatModel), 'default chat model must not depend on a custom -32k Modelfile');
    assert.strictEqual(body.model, 'gemma3:12b');
    assert.strictEqual(
      body.options.num_ctx,
      AttentionAnalysis.DEFAULTS.chatContextTokens,
      'chat calls must request a context window large enough for batched labeling prompts'
    );
    assert.strictEqual(body.options.temperature, 0);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testAdjudicationGateSurvivesOptimisticLlmConfidence() {
  const { pagesById } = buildForcedMergedTopic();
  const { topics } = buildForcedMergedTopic();
  // Simulate labelTopicsWithLlm overwriting the wary heuristic score with the
  // ~0.95 that gemma3 reports for nearly everything. The audit must still fire,
  // because the cluster genuinely blends unrelated domains.
  const optimistic = topics.map(topic => ({ ...topic, confidence: 0.95 }));
  assert.ok(optimistic[0].heuristicConfidence < 0.68, 'setup: heuristic score should still record the doubt');
  const originalFetch = global.fetch;
  mockChatResponses([
    { verdict: 'uncategorized', confidence: 0.3, rationale: 'Unrelated.' },
    { verdict: 'uncategorized', confidence: 0.3, rationale: 'Unrelated.' }
  ]);
  try {
    const result = await AttentionAnalysis.adjudicateUncertainTopics(optimistic, pagesById, {});
    assert.strictEqual(
      result.adjudicationSummary.audited,
      1,
      'a blended cluster must be audited even when the LLM claims 0.95 confidence'
    );
    assert.strictEqual(result.uncategorizedPages.length, 4);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testCleanSmallTopicIsNotAudited() {
  const { pagesById } = buildForcedMergedTopic();
  const topic = {
    id: 'topic-clean', pageIds: [...pagesById.keys()].slice(0, 2),
    confidence: 0.95, heuristicConfidence: 0.72, dominantDomainShare: 1, pageCount: 2,
    label: 'Clean topic', keywords: [], topPages: [], pageUrls: []
  };
  const originalFetch = global.fetch;
  const calls = mockChatResponses([]);
  try {
    const result = await AttentionAnalysis.adjudicateUncertainTopics([topic], pagesById, {});
    assert.strictEqual(calls.length, 0, 'a small, single-domain, confident topic must not spend audit budget');
    assert.strictEqual(result.topics.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  await testRepeatedVisitsRemainEvents();
  await testSameDomainDoesNotForceSameTopic();
  await testFencedJsonParsing();
  await testAnalysisExposesEvidence();
  await testForcedMergeOfUnrelatedDomainsLowersConfidence();
  await testAdjudicationAgreedUncategorized();
  await testAdjudicationDisagreementIsUncategorized();
  await testAdjudicationAgreedSplit();
  await testAdjudicationAgreedKeepRaisesConfidence();
  await testAdjudicationLlmErrorKeepsTopic();
  await testAdjudicationRespectsComputeCap();
  await testAdjudicationGateSurvivesOptimisticLlmConfidence();
  await testCleanSmallTopicIsNotAudited();
  await testTransitionVerificationAgreementBoostsConfidence();
  await testTransitionVerificationDisagreementFallsBackToHeuristic();
  await testChatRequestsExplicitContextWindow();
  await testCheckForNewHistoryCountsFreshVisits();
  await testCorrectionsMatchTopicsByPageOverlapAcrossReruns();
  await testCorrectionsRefreshDerivedMetrics();
  await testSwitchesByHourMatchesSwitchCount();
  await testEmbeddingCacheAvoidsRefetch();
  await testOllamaOriginRejectionIsAuditable();
  await testStoredAnalysisIsReusedUntilRerun();
  await testSettingsOnlyPersistEditableKeys();
  console.log('attentionAnalysis tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
