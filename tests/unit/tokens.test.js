// Night atlas tokens stay readable in both themes. Parses the shipped
// stylesheet, so a palette edit that drops below WCAG AA fails here.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '../../ui/studio.css'), 'utf8');
function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} defines tokens`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(m => [m[1], m[2]]));
}
const luminance = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const dark = tokens(':root');
const light = { ...dark, ...tokens(':root[data-theme="light"]') };
for (const [name, theme] of [['dark', dark], ['light', light]]) {
  for (const surface of ['--bg', '--panel', '--panel-2']) {
    assert.ok(ratio(theme['--text'], theme[surface]) >= 7, `${name}: body text on ${surface}`);
    assert.ok(ratio(theme['--text-dim'], theme[surface]) >= 4.5, `${name}: secondary text on ${surface}`);
    assert.ok(ratio(theme['--text-faint'], theme[surface]) >= 4.5, `${name}: faint text on ${surface}`);
  }
  assert.ok(ratio(theme['--ink-on-fill'], theme['--ink-fill']) >= 7, `${name}: primary button text`);
  assert.ok(ratio(theme['--ring-ink'], theme['--bg']) >= 4.5, `${name}: ring ink`);
  for (let i = 0; i < 8; i++) assert.ok(ratio(theme[`--trail-${i}`], theme['--bg']) >= 3, `${name}: trail ${i} is visible on the canvas`);
}
console.log('Night atlas token contrast passed');
