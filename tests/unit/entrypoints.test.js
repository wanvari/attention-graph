// Catch missing scripts/assets at the actual shipped HTML boundary; importing
// modules directly in a unit test can otherwise conceal a broken extension.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
for (const file of ['ui/newtab.html', 'ui/options.html', 'ui/audit.html', 'ui/diagnostics.html', 'ui/map.html', 'ui/explore.html', 'ui/demo.html', 'offscreen/analysis.html']) {
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
  assertEveryLibraryUsed(file, scripts.map(src => path.resolve(root, path.dirname(file), src)));
}
assertEveryLibraryUsed('background.js', [
  ...[...fs.readFileSync(path.join(root, 'background.js'), 'utf8').match(/importScripts\(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map(m => path.join(root, m[1])),
  path.join(root, 'background.js')
]);

// Each page parses every library it loads, and Home loads on every new tab.
// A library must be referenced by some other script in the same context.
function assertEveryLibraryUsed(context, files) {
  const sources = files.map(f => [f, fs.readFileSync(f, 'utf8')]);
  for (const [file, source] of sources) {
    if (!file.includes(`${path.sep}lib${path.sep}`)) continue;
    const name = source.match(/root\.(CT\w+)\s*=/)?.[1];
    assert.ok(name, `${file} declares a CT global`);
    const used = sources.some(([other, text]) => other !== file && new RegExp(`\\b${name}\\b`).test(text));
    assert.ok(used, `${context} loads ${path.relative(root, file)} but nothing there uses ${name}`);
  }
}
console.log('extension entrypoint assets passed');
