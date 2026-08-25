'use strict';
const assert = require('assert');
const CTOllamaRules = require('../../lib/ollamaRules.js');

const rules = CTOllamaRules.buildRules('abcdefghijklmnopabcdefghijklmnop');

assert.strictEqual(rules.length, 2, 'one rule per local host spelling');

for (const rule of rules) {
  // The security property: never let a rule apply to arbitrary initiators.
  // Without initiatorDomains, Chrome applies a DNR rule to requests from every
  // page, which would let any site launder its Origin past Ollama's check.
  assert.ok(Array.isArray(rule.condition.initiatorDomains),
    'every rule must be scoped by initiatorDomains');
  assert.deepStrictEqual(rule.condition.initiatorDomains, ['abcdefghijklmnopabcdefghijklmnop']);
  assert.deepStrictEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
  assert.strictEqual(rule.action.type, 'modifyHeaders');
  const header = rule.action.requestHeaders[0];
  assert.strictEqual(header.header, 'Origin');
  assert.strictEqual(header.operation, 'set');
  assert.ok(/^http:\/\/(localhost|127\.0\.0\.1)$/.test(header.value),
    `origin rewrites only ever to a local value (got ${header.value})`);
}

assert.ok(rules.some(r => r.condition.urlFilter === '||localhost:11434/'));
assert.ok(rules.some(r => r.condition.urlFilter === '||127.0.0.1:11434/'));

// The port is pinned: the rule must not apply to other local services.
for (const rule of rules) {
  assert.ok(/:11434\/$/.test(rule.condition.urlFilter),
    'rules are pinned to the Ollama port, not all of localhost');
}

// Refuses to build an unscoped rule.
assert.throws(() => CTOllamaRules.buildRules(''), /extension id required/);
assert.throws(() => CTOllamaRules.buildRules(undefined), /extension id required/);

console.log('ollamaRules tests passed');
