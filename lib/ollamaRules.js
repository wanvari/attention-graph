// Origin-rewrite rules for local Ollama, scoped to this extension.
//
// Ollama rejects requests whose Origin is not local, which is its defence
// against a webpage in your browser driving it. The extension needs the
// rewrite because its own origin is `chrome-extension://…`.
//
// A static rule with no `initiatorDomains` applies to requests from EVERY
// initiator, so it would hand that same bypass to every page you visit: a
// page could POST to /api/delete or /api/pull with `no-cors`, never read the
// response, and Ollama would still execute it. The rewrite must therefore be
// registered dynamically, once the extension knows its own id, and scoped to
// it. See tests/unit/ollamaRules.test.js and the e2e DNR match test.
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTOllamaRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const RULE_IDS = [1, 2];

  function buildRules(extensionId) {
    if (!extensionId) throw new Error('extension id required to scope the Ollama origin rules');
    return [
      { id: RULE_IDS[0], host: 'localhost', origin: 'http://localhost' },
      { id: RULE_IDS[1], host: '127.0.0.1', origin: 'http://127.0.0.1' }
    ].map(({ id, host, origin }) => ({
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Origin', operation: 'set', value: origin }]
      },
      condition: {
        urlFilter: `||${host}:11434/`,
        resourceTypes: ['xmlhttprequest'],
        // The whole point: only this extension's own contexts.
        initiatorDomains: [extensionId]
      }
    }));
  }

  return { RULE_IDS, buildRules };
});
