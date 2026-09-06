// UI tests (spec §7.6):
//  - no red/green hue anywhere in ui/*.css (Whoop's valence is what D4 forbids)
//  - newtab renders an empty DB without throwing (jsdom + fake-indexeddb)
//  - newtab performs at most 4 IndexedDB transactions on load
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const root = path.join(__dirname, '..');
const uiDir = path.join(root, 'ui');

// ---------------------------------------------------- color / hue checking
function hslFromRgb(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
  }
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { hue, saturation: saturation * 100, lightness: lightness * 100 };
}

function parseHex(hex) {
  let value = hex.replace('#', '');
  if (value.length === 3) value = value.split('').map(c => c + c).join('');
  if (value.length === 8) value = value.slice(0, 6);
  if (value.length !== 6) return null;
  const int = parseInt(value, 16);
  if (Number.isNaN(int)) return null;
  return hslFromRgb((int >> 16) & 255, (int >> 8) & 255, int & 255);
}

// Red band [340,20] and green band [90,150] at saturation > 20% are forbidden.
function isValenceHue(hsl) {
  if (!hsl || hsl.saturation <= 20) return false;
  const inRed = hsl.hue >= 340 || hsl.hue <= 20;
  const inGreen = hsl.hue >= 90 && hsl.hue <= 150;
  return inRed || inGreen;
}

const cssFiles = fs.readdirSync(uiDir).filter(name => name.endsWith('.css'));
assert.ok(cssFiles.length >= 3, 'ui stylesheets exist');
const hueViolations = [];

for (const name of cssFiles) {
  const source = fs.readFileSync(path.join(uiDir, name), 'utf8');
  for (const match of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const hsl = parseHex(match[0]);
    if (isValenceHue(hsl)) {
      hueViolations.push(`${name}: ${match[0]} (hue ${hsl.hue}, sat ${hsl.saturation.toFixed(0)}%)`);
    }
  }
  for (const match of source.matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/g)) {
    const hsl = hslFromRgb(Number(match[1]), Number(match[2]), Number(match[3]));
    if (isValenceHue(hsl)) {
      hueViolations.push(`${name}: ${match[0]}) (hue ${hsl.hue}, sat ${hsl.saturation.toFixed(0)}%)`);
    }
  }
  for (const match of source.matchAll(/hsla?\(\s*(\d+)[,\s]+(\d+)%/g)) {
    const hsl = { hue: Number(match[1]), saturation: Number(match[2]), lightness: 50 };
    if (isValenceHue(hsl)) hueViolations.push(`${name}: ${match[0]}) (hue ${hsl.hue})`);
  }
  for (const word of ['red', 'green', 'crimson', 'firebrick', 'tomato', 'lime', 'forestgreen', 'seagreen']) {
    const pattern = new RegExp(`:\\s*${word}\\b|\\b${word};`, 'i');
    if (pattern.test(source)) hueViolations.push(`${name}: named color "${word}"`);
  }
}

assert.deepStrictEqual(hueViolations, [],
  `valence hues in ui stylesheets (D4 forbids red/green judgement colors):\n${hueViolations.join('\n')}`);

// The map's topic-node palettes live in JS, not CSS; sweep those too.
{
  const mapData = fs.readFileSync(path.join(uiDir, 'mapData.js'), 'utf8');
  const jsViolations = [];
  for (const match of mapData.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const hsl = parseHex(match[0]);
    if (isValenceHue(hsl)) jsViolations.push(`mapData.js: ${match[0]} (hue ${hsl.hue})`);
  }
  assert.deepStrictEqual(jsViolations, [], `valence hues in map palettes:\n${jsViolations.join('\n')}`);
}

// ------------------------------------------------------ contrast (WCAG AA)
function relativeLuminance(hex) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4]
    .map(i => parseInt(value.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a, b) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

{
  // The band badges are small text, so AA is 4.5:1. Painting the light
  // `--bg` colour on the low-intensity swatches gave 2.3:1 in light mode.
  const shared = fs.readFileSync(path.join(uiDir, 'shared.css'), 'utf8');
  const tokens = {};
  for (const match of shared.matchAll(/(--band-\w+(?:-\w+)?)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    // Later definitions are the dark-mode block; keep both under a scheme key.
    const key = match[1];
    if (!tokens[key]) tokens[key] = [];
    tokens[key].push(match[2]);
  }
  const failures = [];
  for (const band of ['within', 'outside', 'unusual']) {
    const backgrounds = tokens[`--band-${band}-bg`] || [];
    const foregrounds = tokens[`--band-${band}-fg`] || [];
    assert.ok(backgrounds.length >= 1 && foregrounds.length >= 1,
      `band "${band}" defines an explicit background and text colour`);
    // index 0 = light mode, index 1 = dark mode (if present)
    for (let scheme = 0; scheme < Math.min(backgrounds.length, foregrounds.length); scheme++) {
      const ratio = contrastRatio(foregrounds[scheme], backgrounds[scheme]);
      if (ratio < 4.5) {
        failures.push(`${band} (${scheme === 0 ? 'light' : 'dark'}): ${foregrounds[scheme]} on ${backgrounds[scheme]} = ${ratio.toFixed(2)}:1`);
      }
      // And the badge must still be free of valence hues.
      assert.ok(!isValenceHue(parseHex(backgrounds[scheme])),
        `band "${band}" background stays out of the red/green bands`);
    }
  }
  assert.deepStrictEqual(failures, [],
    `band badges must meet WCAG AA (4.5:1) in both themes:\n${failures.join('\n')}`);
}

// ------------------------------------------------- real record journeys
const CTText = require('../lib/text.js');
const CTStore = require('../lib/store.js');
const CTNewtab = require('../ui/newtab.js');
const at = (day, hour = 12, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const now = at(5, 20);
const a = 'https://docs.example.test/rust';
const b = 'https://notes.example.test/async';
const c = 'https://recipes.example.test/sourdough';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const click = (window, node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const textButton = (document, text) => [...document.querySelectorAll('button')].find(node => node.textContent === text);
async function seed(store) {
  await store.put('topics', { topicId: 'rust', label: 'Async Rust', state: 'active' });
  await store.bulkPut('memberships', [{ topicId: 'rust', normalizedUrl: a }, { topicId: 'rust', normalizedUrl: b }]);
  await store.bulkPut('visits', [
    { visitId: 'v1', normalizedUrl: a, url: a, title: 'Rust guide', visitTime: at(1), dayKey: '2026-09-01', dwellMs: 60000 },
    { visitId: 'v2', normalizedUrl: b, url: b, title: 'Async patterns', visitTime: at(1, 12, 10), dayKey: '2026-09-01', dwellMs: 120000 },
    { visitId: 'v3', normalizedUrl: a, url: a, title: 'Rust guide', visitTime: at(3), dayKey: '2026-09-03', dwellMs: 60000 }
  ]);
  await store.put('captures', { captureId: 'fresh', normalizedUrl: c, url: c, title: 'Sourdough hydration', startedAt: at(5), updatedAt: at(5, 12, 2), activeMs: 40000 });
}
async function mount(populate, extra = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', { pretendToBeVisual: true, url: 'https://localhost/ui/newtab.html' });
  const store = CTStore.createStore({ indexedDB: new IDBFactory(), IDBKeyRange });
  await store.open();
  if (populate) await populate(store);
  const searched = [];
  const result = await CTNewtab.main({ store, container: dom.window.document.getElementById('app'), now, onSearch: q => searched.push(q), ...extra });
  return { window: dom.window, document: dom.window.document, store, result, searched,
    async close() { result.dispose(); dom.window.close(); await store.close(); } };
}
function search(window, document, query) {
  document.querySelector('.nt-search-input').value = query;
  document.querySelector('.nt-search').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

(async () => {
  // A fresh installation offers useful model-independent next steps.
  {
    const m = await mount(null);
    assert.equal(m.result.state, 'empty');
    assert.ok(m.document.body.textContent.includes('Search works before they are installed.'));
    assert.ok(m.document.querySelector('a[href="demo.html"]'));
    assert.ok(m.document.querySelector('a[href="options.html"]'));
    assert.ok(m.document.querySelector('.nt-footer'));
    assert.equal(m.result.readTransactions, 1);
    assert.equal(m.document.querySelectorAll('.nt-ring').length, 0);
    await m.close();
  }
  // Find a trail, inspect dated evidence, and reopen its actual page URL.
  {
    const m = await mount(seed);
    assert.equal(m.result.state, 'rendered');
    assert.equal(m.result.readTransactions, 1);
    assert.ok(m.document.body.textContent.includes('returned on 1 later day'));
    assert.ok(m.document.body.textContent.includes('3 visits grouped of 4 recorded'));
    assert.ok(m.document.body.textContent.includes('Interaction timing available for 1 of 4'));
    assert.ok(m.document.querySelector('.nt-freshness').textContent.includes('Latest recorded visit'));
    assert.equal(m.document.querySelectorAll('.nt-ring, .nt-band').length, 0);
    click(m.window, m.document.querySelector('.nt-trail-title'));
    assert.equal(m.document.querySelector('.nt-detail-heading h2').textContent, 'Async Rust');
    assert.equal(m.document.querySelectorAll('.nt-episode').length, 2);
    const sessions = m.document.querySelectorAll('.nt-episode');
    assert.equal(sessions[1].querySelectorAll('.nt-visit').length, 2);
    assert.deepEqual([...sessions[1].querySelectorAll('.nt-page-link')].map(n => n.href), [a, b]);
    assert.equal(m.document.querySelector('.nt-page-link').rel, 'noopener noreferrer');
    assert.equal(m.document.querySelector('.nt-page-link').target, '_blank');
    assert.ok(m.document.querySelector('.nt-method').textContent.includes('not a measure of attention or thinking'));
    await m.close();
  }
  // Offline model status does not hide freshly captured or ungrouped pages.
  {
    const m = await mount(seed, { statusProvider: () => ({ paused: false, ollama: false }) });
    await tick();
    assert.ok(m.document.body.textContent.includes('Local grouping is offline'));
    search(m.window, m.document, 'Sourdough');
    assert.equal(m.document.querySelectorAll('.nt-content .nt-visit').length, 1);
    assert.equal(m.document.querySelector('.nt-content .nt-page-link').href, c);
    assert.ok(m.document.querySelector('.nt-content').textContent.includes('Recent capture'));
    assert.deepEqual(m.searched, [], 'record search never submits a web query');
    search(m.window, m.document, 'notes.example.test');
    assert.equal(m.document.querySelector('.nt-content .nt-page-link').href, b);
    search(m.window, m.document, 'Async Rust');
    assert.equal(m.document.querySelectorAll('.nt-content .nt-visit').length, 3);
    search(m.window, m.document, 'does not exist');
    assert.ok(m.document.querySelector('.nt-content').textContent.includes('No pages matched'));
    await m.close();
  }
  // Date bounds are inclusive, and inverted bounds cannot silently apply.
  {
    const m = await mount(seed);
    click(m.window, textButton(m.document, 'Filter by date'));
    const from = m.document.querySelector('input[name="from"]');
    const through = m.document.querySelector('input[name="through"]');
    from.value = '2026-09-03'; through.value = '2026-09-03';
    through.dispatchEvent(new m.window.Event('change', { bubbles: true }));
    assert.equal(m.document.querySelectorAll('.nt-content .nt-visit').length, 1);
    assert.equal(m.document.querySelector('.nt-content .nt-page-link').href, a);
    from.value = '2026-09-04'; from.dispatchEvent(new m.window.Event('change', { bubbles: true }));
    assert.ok(m.document.querySelector('[role="status"]').textContent.includes('end date on or after'));
    await m.close();
  }
  // Optional edits survive a reload while the inferred registry stays intact.
  {
    const m = await mount(seed);
    click(m.window, m.document.querySelector('.nt-pin'));
    await tick();
    assert.equal((await m.store.get('corrections', 'trail:rust')).value.pinned, true);
    click(m.window, m.document.querySelector('.nt-trail-title'));
    const form = m.document.querySelector('.nt-edit-form');
    form.querySelector('input').value = 'My Rust project';
    form.querySelector('textarea').value = '<script>alert("x")</script>\nReturn to the async example';
    form.dispatchEvent(new m.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(m.document.querySelector('.nt-detail-heading h2').textContent, 'My Rust project');
    assert.equal(m.document.querySelector('.nt-personal-note script'), null);
    assert.ok(m.document.querySelector('.nt-personal-note').textContent.includes('<script>'));
    assert.equal((await m.store.get('topics', 'rust')).label, 'Async Rust');
    m.result.dispose();
    const reloaded = await CTNewtab.main({ store: m.store, container: m.document.getElementById('app'), now });
    assert.equal(m.document.querySelector('.nt-trail-title').textContent, 'My Rust project');
    assert.equal(m.document.querySelector('.nt-pin').getAttribute('aria-pressed'), 'true');
    reloaded.dispose();
    await m.close();
  }
  // A storage failure must not show a successful save or replace the note.
  {
    const m = await mount(seed, { onSaveMetadata: async () => { throw new Error('disk failure'); } });
    click(m.window, m.document.querySelector('.nt-pin')); await tick();
    assert.equal(m.document.querySelector('.nt-pin').getAttribute('aria-pressed'), 'false');
    assert.ok(m.document.querySelector('[role="status"]').textContent.includes('Could not save'));
    assert.equal(m.document.querySelector('.nt-pin').disabled, false);
    await m.close();
  }
  // Native controls and explicit labels support keyboard use; web search is
  // a separate, intentional action and preserves the chosen query.
  {
    const m = await mount(seed);
    m.document.body.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    assert.equal(m.document.activeElement, m.document.querySelector('.nt-search-input'));
    search(m.window, m.document, '  Rust guide  ');
    assert.deepEqual(m.searched, []);
    click(m.window, textButton(m.document, 'Search the web ↗'));
    assert.deepEqual(m.searched, ['Rust guide']);
    m.document.querySelector('.nt-search-input').dispatchEvent(new m.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(m.document.querySelector('.nt-search-input').value, '');
    assert.ok(m.document.querySelector('.nt-trail-title'));
    assert.ok(m.document.querySelector('.nt-search-input').getAttribute('aria-label'));
    assert.equal(m.document.querySelector('.nt-trail-title').tagName, 'BUTTON');
    assert.equal(m.document.querySelector('.nt-method summary').tagName, 'SUMMARY');
    await m.close();
  }
  // Paused state initializes from the service worker, and its first click
  // resumes capture rather than accidentally pausing it again.
  {
    const calls = [];
    const m = await mount(seed, { statusProvider: () => ({ paused: true, ollama: false }), onTogglePause: async (_button, paused) => { calls.push(paused); return { paused }; } });
    await tick();
    click(m.window, textButton(m.document, 'Resume capture')); await tick();
    assert.deepEqual(calls, [false]);
    assert.ok(textButton(m.document, 'Pause capture'));
    await m.close();
  }
  // Sample mode is self-contained, with explicit read-only controls and
  // supplied navigation instead of links to an unseeded live extension page.
  {
    const m = await mount(seed, { readOnly: true, links: { home: '#home', map: '#map', audit: '#audit', settings: '#setup' } });
    assert.equal(m.document.querySelector('.nt-pin').disabled, true);
    assert.equal(m.document.querySelector('.nt-nav a').getAttribute('href'), '#map');
    click(m.window, m.document.querySelector('.nt-trail-title'));
    assert.equal(m.document.querySelector('.nt-edit-form'), null);
    assert.ok(m.document.querySelector('.nt-edit').textContent.includes('sample record'));
    await m.close();
  }
  console.log('ui tests passed');
})().catch(error => { console.error(error); process.exit(1); });
