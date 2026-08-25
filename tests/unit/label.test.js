'use strict';
const assert = require('assert');
const CTLabel = require('../../lib/label.js');

function makeClient(handler) {
  const calls = [];
  return {
    calls,
    async chatJson(prompt, kind) {
      calls.push({ prompt, kind });
      const result = handler(prompt, kind, calls.length);
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

const parseError = () => {
  const error = new Error('Ollama response was not parseable JSON');
  error.code = 'parse';
  return error;
};

function makeCluster(i) {
  return {
    pages: [
      { normalizedUrl: `https://a${i}.example/1`, url: `https://a${i}.example/1`, title: `Page ${i}A`, domain: `a${i}.example`, text: 'body text' },
      { normalizedUrl: `https://a${i}.example/2`, url: `https://a${i}.example/2`, title: `Page ${i}B`, domain: `a${i}.example`, text: 'body text' }
    ],
    keywords: ['alpha', 'beta'],
    dwellMs: 10 * 60000
  };
}

(async () => {
  // --- labels are applied by payload id, batched
  {
    const clusters = [makeCluster(0), makeCluster(1), makeCluster(2)];
    const client = makeClient((prompt, kind) => {
      assert.strictEqual(kind, 'label_topics');
      const blocks = prompt.split('\n\n');
      const payload = JSON.parse(blocks[blocks.length - 1]);
      return { topics: payload.map(c => ({ id: c.id, label: `Label ${c.id}`, confidence: 0.9, rationale: 'because' })) };
    });
    const result = await CTLabel.labelClusters(clusters, client, { labelBatchSize: 2 });
    assert.strictEqual(result.calls, 2, '3 clusters at batch size 2 = 2 calls');
    assert.deepStrictEqual(result.clusters.map(c => c.label), ['Label c0', 'Label c1', 'Label c2']);
    assert.ok(result.clusters.every(c => c.labelSource === 'llm'));
    assert.strictEqual(result.clusters[0].labelConfidence, 0.9);
    // The input clusters are not mutated.
    assert.strictEqual(clusters[0].label, undefined);
  }

  // --- the MIXED escape hatch is offered, so the model need not invent a theme
  {
    const client = makeClient(prompt => {
      assert.ok(/MIXED/.test(prompt), 'the prompt offers MIXED');
      assert.ok(/no honest theme/i.test(prompt));
      return { topics: [{ id: 'c0', label: 'MIXED', confidence: 0.4, rationale: 'no theme' }] };
    });
    const result = await CTLabel.labelClusters([makeCluster(0)], client, {});
    assert.strictEqual(result.clusters[0].label, 'MIXED');
  }

  // --- unparseable output costs only that batch its labels
  {
    const clusters = [makeCluster(0), makeCluster(1)];
    const client = makeClient((prompt, kind, callNumber) => {
      if (callNumber === 1) return parseError();
      const blocks = prompt.split('\n\n');
      const payload = JSON.parse(blocks[blocks.length - 1]);
      return { topics: payload.map(c => ({ id: c.id, label: 'Recovered', confidence: 0.8 })) };
    });
    const result = await CTLabel.labelClusters(clusters, client, { labelBatchSize: 1 });
    assert.strictEqual(result.clusters[0].labelSource, 'keywords', 'the failed batch falls back');
    assert.strictEqual(result.clusters[1].label, 'Recovered', 'later batches still apply');
  }

  // --- a transport failure fails the run instead of silently degrading
  {
    const client = makeClient(() => new Error('ECONNREFUSED'));
    await assert.rejects(() => CTLabel.labelClusters([makeCluster(0)], client, {}),
      'an Ollama outage must not be mistaken for a bad batch');
  }

  // --- ids that were never sent are ignored
  {
    const client = makeClient(() => ({ topics: [{ id: 'c999', label: 'Phantom', confidence: 0.99 }] }));
    const result = await CTLabel.labelClusters([makeCluster(0)], client, {});
    assert.notStrictEqual(result.clusters[0].label, 'Phantom');
    assert.strictEqual(result.clusters[0].labelSource, 'keywords');
  }

  // --- transition type normalization
  {
    assert.strictEqual(CTLabel.normalizeTransitionType('adjacent_topic_jump'), 'adjacent_topic_jump');
    assert.strictEqual(CTLabel.normalizeTransitionType('Adjacent Topic Jump'), 'adjacent_topic_jump');
    assert.strictEqual(CTLabel.normalizeTransitionType('topic-switch'), 'topic_switch');
    assert.strictEqual(CTLabel.normalizeTransitionType('nonsense'), null);
    assert.strictEqual(CTLabel.normalizeTransitionType(undefined), null);
  }

  // --- transition verification: agreement raises confidence and marks verified
  {
    const topicsById = new Map([
      ['t1', { topicId: 't1', label: 'React work' }],
      ['t2', { topicId: 't2', label: 'Market news' }]
    ]);
    const row = {
      sourceTopicId: 't1', targetTopicId: 't2', type: 'adjacent_topic_jump',
      similarity: 0.6, confidence: 0.55, visitCount: 3, llmLabeled: true, examples: []
    };
    const client = makeClient(() => ({
      transitions: [{ id: 't1->t2', type: 'adjacent_topic_jump', confidence: 0.85 }]
    }));
    const result = await CTLabel.verifyBorderlineTransitions([row], topicsById, client, {});
    assert.strictEqual(result.rows[0].type, 'adjacent_topic_jump');
    assert.ok(result.rows[0].confidence >= 0.85, 'agreement raises confidence');
    assert.strictEqual(result.rows[0].verified, true);
  }

  // --- disagreement falls back to the similarity heuristic, marked uncertain
  {
    const topicsById = new Map([
      ['t1', { topicId: 't1', label: 'React work' }],
      ['t2', { topicId: 't2', label: 'Market news' }]
    ]);
    // similarity 0.6 >= 0.58, so the heuristic says adjacent; the second pass
    // says switch. The user never arbitrates: the heuristic stands, flagged.
    const row = {
      sourceTopicId: 't1', targetTopicId: 't2', type: 'adjacent_topic_jump',
      similarity: 0.6, confidence: 0.55, visitCount: 3, llmLabeled: true, examples: []
    };
    const client = makeClient(() => ({
      transitions: [{ id: 't1->t2', type: 'topic_switch', confidence: 0.9 }]
    }));
    const result = await CTLabel.verifyBorderlineTransitions([row], topicsById, client, {});
    assert.strictEqual(result.rows[0].type, 'adjacent_topic_jump', 'falls back to the heuristic');
    assert.strictEqual(result.rows[0].uncertain, true);
    assert.strictEqual(result.rows[0].llmLabeled, false);
    assert.ok(result.rows[0].confidence <= 0.45, 'disagreement lowers confidence');
  }

  // --- a failed verification call leaves the first-pass labels alone
  {
    const topicsById = new Map([['t1', {}], ['t2', {}]]);
    const row = {
      sourceTopicId: 't1', targetTopicId: 't2', type: 'adjacent_topic_jump',
      similarity: 0.6, confidence: 0.55, visitCount: 3, llmLabeled: true, examples: []
    };
    const client = makeClient(() => new Error('timeout'));
    const result = await CTLabel.verifyBorderlineTransitions([row], topicsById, client, {});
    assert.strictEqual(result.rows[0].type, 'adjacent_topic_jump');
    assert.ok(!result.rows[0].uncertain, 'verification is best-effort, not evidence');
  }

  // --- confident, non-borderline transitions are not re-checked
  {
    const topicsById = new Map([['t1', {}], ['t2', {}]]);
    const row = {
      sourceTopicId: 't1', targetTopicId: 't2', type: 'topic_switch',
      similarity: 0.20, confidence: 0.8, visitCount: 3, llmLabeled: true, examples: []
    };
    const client = makeClient(() => { throw new Error('should not be called'); });
    const result = await CTLabel.verifyBorderlineTransitions([row], topicsById, client, {});
    assert.strictEqual(client.calls.length, 0, 'no verification budget spent on a clear-cut transition');
    assert.strictEqual(result.calls, 0);
  }

  // --- same-topic flows are never sent for labeling
  {
    const topicsById = new Map([['t1', { label: 'One topic' }]]);
    const rows = [{ sourceTopicId: 't1', targetTopicId: 't1', type: 'same_topic_flow', visitCount: 9, confidence: 0.88 }];
    const client = makeClient(() => { throw new Error('should not be called'); });
    const result = await CTLabel.labelTransitions(rows, topicsById, client);
    assert.strictEqual(result.calls, 0, 'a same-topic flow needs no model call');
    assert.strictEqual(result.rows[0].type, 'same_topic_flow');
  }

  console.log('label tests passed');
})().catch(error => { console.error(error); process.exit(1); });
