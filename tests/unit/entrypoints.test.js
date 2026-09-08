// Catch missing scripts/assets at the actual shipped HTML boundary; importing
// modules directly in a unit test can otherwise conceal a broken extension.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
for (const file of ['ui/newtab.html', 'ui/options.html', 'ui/audit.html', 'ui/diagnostics.html', 'ui/map.html', 'ui/demo.html', 'offscreen/analysis.html']) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  for (const ref of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])) {
    if (/^(?:https?:|#)/.test(ref)) continue;
    assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), ref.split('?')[0])), `${file} references missing ${ref}`);
  }
  if (file.includes('newtab') || file.includes('demo')) assert.ok(scripts.indexOf('../lib/trails.js') >= 0 && scripts.indexOf('../lib/trails.js') < scripts.indexOf('newtab.js'), 'trails model loads before its renderer');
  if (file.includes('newtab') || file.includes('demo')) {
    assert.ok(scripts.indexOf('../lib/dashboard.js') >= 0 && scripts.indexOf('../lib/dashboard.js') < scripts.indexOf('dashboard.js'));
    assert.ok(scripts.indexOf('dashboard.js') < scripts.indexOf('newtab.js'));
  }
  if (file.includes('map')) assert.ok(scripts.indexOf('../lib/dashboard.js') < scripts.indexOf('mapData.js'));
  if (file.includes('analysis')) assert.ok(scripts.indexOf('../lib/relevance.js') >= 0 && scripts.indexOf('../lib/relevance.js') < scripts.indexOf('../lib/pipeline.js'), 'pipeline receives its relevance dependency');
}
console.log('extension entrypoint assets passed');
