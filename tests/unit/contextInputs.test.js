'use strict';
const assert = require('node:assert/strict');
const E = require('../../tools/contextExperiment'), P = require('../../lib/pipeline'), Text = require('../../lib/text');
const cases = E.makeCases();
assert.equal(cases.length, 76);
for (const page of cases) {
  assert.equal(E.makeInput(page, 'current'), P.embeddingInput({ ...page, captureText: page.extractedText }).slice(0, 2000));
  if (page.extractedText) assert.equal(E.makeInput(page, 'full8000'), `${page.title}\n${page.domain}\n${page.extractedText.slice(0, 8000)}`);
}
// Characterize an existing limitation; expanding context is a separate policy
// change, not part of the infrastructure optimization.
const base = { title: 'Notes', domain: 'example.test', source: 'web', captureText: 'A'.repeat(1500) + 'B'.repeat(4000) };
const changed = { ...base, captureText: base.captureText.slice(0, 3500) + 'NEW SUBJECT' + base.captureText.slice(3511) };
assert.notEqual(Text.hashString(base.captureText), Text.hashString(changed.captureText));
assert.equal(P.embeddingInput(base), P.embeddingInput(changed), 'ordinary-page changes after 1500 characters are invisible to the current embedding');
assert.equal(P.embeddingKeyFor('bge-m3:latest', P.embeddingInput(base)), P.embeddingKeyFor('bge-m3:latest', P.embeddingInput(changed)));
base.source = changed.source = 'llm_chat';
assert.equal(P.embeddingInput(base), P.embeddingInput(changed), 'changes in a long conversation middle can be invisible to head/tail sampling');
assert.notEqual(E.makeInput({ ...base, extractedText: base.captureText }, 'full8000'), E.makeInput({ ...changed, extractedText: changed.captureText }, 'full8000'));
const pages = [{ id: 'a', expectedTopic: 'one', case: 'clear' }, { id: 'b', expectedTopic: 'one', case: 'clear' }, { id: 'c', expectedTopic: 'two', case: 'clear' }, { id: 'd', expectedTopic: null, case: 'noise' }];
const good = E.score(pages, [[pages[0], pages[1]], [pages[2]]]);
assert.equal(good.incorrectMergePairs, 0); assert.equal(good.missedSameTopicPairs, 0); assert.equal(good.noisePagesGrouped, 0);
const bad = E.score(pages, [[pages[0], pages[2], pages[3]]]);
assert.equal(bad.incorrectMergePairs, 3); assert.equal(bad.missedSameTopicPairs, 1); assert.equal(bad.noisePagesGrouped, 1);
console.log('Context profiles preserve production baseline, expose unsampled middle changes, and score merges/misses/noise independently');
