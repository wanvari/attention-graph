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

// ------------------------------------------------- newtab render in jsdom
async function renderNewtab(seed) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><main id="app"></main></body></html>', {
    pretendToBeVisual: true,
    url: 'https://localhost/'
  });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.Node = window.Node;

  // Load the libs into this jsdom global the same way the page does.
  delete require.cache[require.resolve('../lib/text.js')];
  delete require.cache[require.resolve('../lib/store.js')];
  delete require.cache[require.resolve('../ui/newtab.js')];
  const CTText = require('../lib/text.js');
  const CTStore = require('../lib/store.js');
  const CTNewtab = require('../ui/newtab.js');
  global.CTText = CTText;
  global.CTStore = CTStore;

  const store = CTStore.createStore({ indexedDB: new IDBFactory(), IDBKeyRange });
  await store.open();
  if (seed) await seed(store, CTText);

  const errors = [];
  window.addEventListener('error', event => errors.push(event.error));
  const searched = [];
  const result = await CTNewtab.main({
    store,
    container: window.document.getElementById('app'),
    now: new Date(2026, 2, 28, 21, 0, 0).getTime(),
    onSearch: query => searched.push(query)
  });
  return { result, window, errors, store, searched };
}

(async () => {
  // --- empty DB renders the onboarding state with no errors
  {
    const { result, window, errors } = await renderNewtab(null);
    assert.strictEqual(errors.length, 0, 'no errors thrown on empty-DB render');
    assert.strictEqual(result.state, 'empty');
    const text = window.document.body.textContent;
    assert.ok(/Cognitive Trails/.test(text), 'empty state names the extension');
    assert.ok(/ollama pull/i.test(text), 'empty state gives the setup steps');
    assert.ok(window.document.querySelector('.nt-footer'), 'footer links render in the empty state');
  }

  // --- populated DB renders rings, range card, brief, runs; <= 4 reads
  {
    const seed = async (store, CTText) => {
      const days = [];
      for (let i = 27; i >= 0; i--) {
        const day = CTText.addDays('2026-03-28', -i);
        days.push({
          day,
          computedAt: Date.now(),
          activeMs: (150 + i) * 60000,
          visitCount: 40,
          categorizedShare: 0.92,
          topicEntropy: 2.1 + (i % 5) * 0.08,
          activeTopicCount: 5 + (i % 3),
          switchesPerActiveHour: 3 + (i % 4) * 0.4,
          continuityShare: 0.6 + (i % 3) * 0.03,
          uncoveredTransitions: 2,
          convergenceCount: i === 0 ? 1 : 0,
          dormantCount: 0,
          revivedCount: 0,
          topTopics: [{ topicId: 't1', label: 'Async Rust Programming', dwellMs: 60 * 60000, share: 0.4 }],
          runs: i === 0
            ? [{ topicId: 't1', label: 'Async Rust Programming', startAt: new Date(2026, 2, 28, 9, 30).getTime(), endAt: new Date(2026, 2, 28, 10, 40).getTime(), dwellMs: 70 * 60000, visitCount: 6 }]
            : [],
          lowData: false
        });
      }
      await store.bulkPut('daily_metrics', days);
      await store.bulkPut('baselines', [
        { metric: 'topicEntropy', windowDays: 28, n: 27, mean: 2.25, std: 0.12, lastDay: '2026-03-28' },
        { metric: 'activeTopicCount', windowDays: 28, n: 27, mean: 6, std: 0.9, lastDay: '2026-03-28' },
        { metric: 'switchesPerActiveHour', windowDays: 28, n: 27, mean: 3.6, std: 0.5, lastDay: '2026-03-28' },
        { metric: 'continuityShare', windowDays: 28, n: 27, mean: 0.63, std: 0.02, lastDay: '2026-03-28' },
        { metric: 'activeMs', windowDays: 28, n: 27, mean: 160 * 60000, std: 12 * 60000, lastDay: '2026-03-28' }
      ]);
      await store.put('briefs', {
        day: '2026-03-28',
        generatedAt: new Date(2026, 2, 28, 3, 12).getTime(),
        runId: 'run-x',
        items: [
          { kind: 'revival', text: '*Sourdough Bread Baking Techniques* returned after 18 dormant days.', topicIds: ['t2'], evidence: { topicId: 't2' } },
          { kind: 'convergence', text: '*Attention and Task Switching Research* appeared in both browsing and LLM chats this week.', topicIds: ['t3'], evidence: { topicId: 't3' } }
        ],
        seen: false
      });
    };
    const { result, window, errors, store } = await renderNewtab(seed);
    assert.strictEqual(errors.length, 0, 'no errors on populated render');
    assert.strictEqual(result.state, 'rendered');
    assert.ok(result.readTransactions <= 4,
      `newtab load must use at most 4 IndexedDB transactions (used ${result.readTransactions})`);

    const doc = window.document;
    assert.strictEqual(doc.querySelectorAll('.nt-ring').length, 3, 'three rings render');
    const text = doc.body.textContent;
    assert.ok(/Spread/.test(text) && /Continuity/.test(text) && /Active/.test(text), 'ring names render');
    assert.ok(/within your range|outside usual|unusual for you/.test(text), 'z-band captions render');
    assert.ok(/metrics within your range/.test(text), 'the range summary renders');
    assert.ok(/returned after 18 dormant days/.test(text), "today's brief renders");
    assert.ok(/Async Rust Programming/.test(text), 'focused runs render');
    // Topic labels arrive as *label* and must render as emphasis, not literal asterisks.
    assert.ok(!/\*Sourdough/.test(text), 'asterisks are converted to emphasis, not shown');
    assert.ok(doc.querySelector('.nt-brief-list em'), 'topic labels render as <em>');

    // Sparkline expands on click without throwing.
    const firstRow = doc.querySelector('.nt-metric-row');
    firstRow.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.ok(doc.querySelector('.nt-sparkline-row svg'), 'clicking a metric row expands a sparkline');

    // An interactive row must be operable without a mouse.
    for (const metricRow of doc.querySelectorAll('.nt-metric-row')) {
      assert.strictEqual(metricRow.getAttribute('role'), 'button', 'metric rows announce themselves as buttons');
      assert.strictEqual(metricRow.getAttribute('tabindex'), '0', 'and are reachable by keyboard');
      assert.ok(metricRow.hasAttribute('aria-expanded'), 'and report their expanded state');
      assert.ok(metricRow.getAttribute('aria-controls'), 'and name the region they toggle');
      assert.ok(metricRow.getAttribute('aria-label'), 'and carry a readable label');
    }
    const keyboardRow = doc.querySelectorAll('.nt-metric-row')[1];
    const target = doc.getElementById(keyboardRow.getAttribute('aria-controls'));
    assert.strictEqual(target.hidden, true, 'starts collapsed');
    const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    keyboardRow.dispatchEvent(enter);
    assert.strictEqual(target.hidden, false, 'Enter expands the sparkline');
    assert.strictEqual(keyboardRow.getAttribute('aria-expanded'), 'true');
    const space = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true });
    keyboardRow.dispatchEvent(space);
    assert.strictEqual(target.hidden, true, 'Space collapses it again');
    assert.strictEqual(keyboardRow.getAttribute('aria-expanded'), 'false');
  }

  // --- a day with no run today falls back to the most recent day
  {
    const seed = async (store) => {
      await store.put('daily_metrics', {
        day: '2026-03-27', computedAt: Date.now(), activeMs: 90 * 60000, visitCount: 20,
        categorizedShare: 0.9, topicEntropy: 1.8, activeTopicCount: 4,
        switchesPerActiveHour: 2, continuityShare: 0.7, uncoveredTransitions: 0,
        convergenceCount: 0, dormantCount: 0, revivedCount: 0, topTopics: [], runs: [], lowData: false
      });
      await store.bulkPut('captures', [
        { captureId: 'c1', normalizedUrl: 'https://a.example/x', startedAt: new Date(2026, 2, 28, 10, 0).getTime(), dayKey: '2026-03-28', activeMs: 12 * 60000, extractedText: '', textLength: 0 }
      ]);
    };
    const { result, window } = await renderNewtab(seed);
    assert.strictEqual(result.staleDay, true, "yesterday's record is shown when today has no run");
    const text = window.document.textContent || window.document.body.textContent;
    assert.ok(/has not been analyzed yet/.test(text), 'the stale stamp is explicit');
    assert.ok(/Today so far \(live, unanalyzed\)/.test(text), "today's live counts show without any analysis");
  }

  // --- the search box actually submits
  // It shipped calling chrome.search behind a guard that silently did nothing
  // when the permission was missing, which is indistinguishable from a dead
  // input. This covers the DOM half; the boot half now falls back and warns.
  {
    const { window, searched, errors } = await renderNewtab(null);
    assert.strictEqual(errors.length, 0, 'rendering the search box threw');
    const input = window.document.querySelector('.nt-search-input');
    const form = window.document.querySelector('.nt-search');
    assert.ok(input, 'no search input rendered');
    assert.ok(form, 'the search input is not inside a form, so Enter cannot submit it');
    assert.strictEqual(form.tagName, 'FORM');
    assert.strictEqual(input.type, 'text');

    input.value = '  sourdough hydration  ';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    assert.deepStrictEqual(searched, ['sourdough hydration'],
      'submitting the search form did not call onSearch with the trimmed query');
    assert.strictEqual(input.value, '', 'the input was not cleared after submitting');

    input.value = '   ';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    assert.deepStrictEqual(searched, ['sourdough hydration'], 'an empty query was submitted');
  }

  console.log('ui tests passed');
})().catch(error => { console.error(error); process.exit(1); });
