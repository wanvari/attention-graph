// Copy and framing tests (spec §7.5). Every user-facing string in the brief
// generator and the UI is swept for normative words, and for displayed
// confidence percentages. This is a build gate: D4 (no normative scores) and
// D5/D6 (no goal inference, no synthesis) live or die in the copy.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Words that would turn a record into a judgement.
const FORBIDDEN = ['should', 'focus', 'productive', 'distract', 'goal', 'improve', 'better', 'worse', 'good', 'bad'];

// Occurrences that are not user-facing copy: identifiers, CSS, code comments
// explaining WHY a word is banned, and the test's own word list.
const ALLOWED_CONTEXTS = [
  /focused[ _-]?runs?/i,        // "focused run" is a defined measurement term
  /buildFocusedRuns/,
  /focusedRunMinDwellMs/,
  /\bfocus\b(?=[^\n]*(?:outline|ring|:focus|onfocus|hasFocus|focusable))/i
];

function userFacingStrings(source) {
  // Quoted string literals and template-literal text, minus obvious code.
  const strings = [];
  const patterns = [
    /'((?:[^'\\\n]|\\.)*)'/g,
    /"((?:[^"\\\n]|\\.)*)"/g,
    /`((?:[^`\\]|\\.)*)`/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) strings.push(match[1]);
  }
  return strings;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function htmlText(source) {
  // Visible text plus the attributes users read.
  const withoutScripts = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const titles = [...withoutScripts.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/gi)].map(m => m[1]);
  const text = withoutScripts.replace(/<[^>]+>/g, ' ');
  return [text, ...titles].join('\n');
}

function collectFiles() {
  const files = [];
  files.push(path.join(root, 'lib', 'brief.js'));
  for (const dir of ['ui']) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (name.endsWith('.js') || name.endsWith('.html')) files.push(path.join(root, dir, name));
    }
  }
  return files;
}

const violations = [];
const confidenceViolations = [];

for (const file of collectFiles()) {
  const raw = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  const candidates = file.endsWith('.html')
    ? htmlText(raw).split('\n')
    : userFacingStrings(stripComments(raw));

  for (const candidate of candidates) {
    const text = String(candidate);
    if (!/[a-z]/i.test(text)) continue;
    for (const word of FORBIDDEN) {
      const pattern = new RegExp(`\\b${word}`, 'i');
      if (!pattern.test(text)) continue;
      if (ALLOWED_CONTEXTS.some(allowed => allowed.test(text))) continue;
      violations.push(`${rel}: "${text.trim().slice(0, 100)}" contains "${word}"`);
    }
  }

  // The specific failure §7.5 names: a percent sign or decimal rendered as
  // text next to the word "confidence". A bar's CSS width is not a displayed
  // number, so `style="width:NN%"` is excluded.
  const lines = stripComments(raw).split('\n');
  for (const line of lines) {
    if (!/confidence/i.test(line)) continue;
    const withoutStyleWidths = line
      .replace(/style\s*=\s*"[^"]*"/gi, ' ')
      .replace(/width\s*:[^;"'`]*/gi, ' ');
    if (/%/.test(withoutStyleWidths) || /confidence[^\n]{0,40}toFixed/i.test(withoutStyleWidths)) {
      confidenceViolations.push(`${rel}: "${line.trim().slice(0, 110)}"`);
    }
  }
}

assert.deepStrictEqual(violations, [], `normative words in user-facing copy:\n${violations.join('\n')}`);
assert.deepStrictEqual(confidenceViolations, [],
  `displayed confidence percentages:\n${confidenceViolations.join('\n')}`);

// The brief's own generated strings, over a stress input covering every kind.
const CTBrief = require('../lib/brief.js');
const topicsById = new Map([
  ['t1', { topicId: 't1', label: 'Information foraging theory', totalDwellMs: 900 * 60000, lastActiveDay: '2026-03-01' }],
  ['t2', { topicId: 't2', label: 'Ollama quantization', totalDwellMs: 500 * 60000, lastActiveDay: '2026-03-01' }],
  ['t3', { topicId: 't3', label: 'Attention entropy', totalDwellMs: 50 * 60000, lastActiveDay: '2026-03-14' }]
]);
const stress = CTBrief.buildBrief({
  day: '2026-03-15',
  metrics: { lowData: false, topicEntropy: 3.4, activeMs: 3 * 3600000, switchesPerActiveHour: 9, continuityShare: 0.4, activeTopicCount: 12 },
  gap: { days: 4, from: '2026-03-10', to: '2026-03-13' },
  pausedMsToday: 3600000,
  firstRun: true,
  events: [
    { type: 'revived', topicId: 't1', detail: { dormantDays: 30 } },
    { type: 'dormant', topicId: 't2', detail: {} },
    { type: 'created', topicId: 't3', detail: {} }
  ],
  zScores: {
    topicEntropy: { z: 3, mean: 2 }, activeMs: { z: -2.5, mean: 2 * 3600000 },
    switchesPerActiveHour: { z: 2.2, mean: 4 }, continuityShare: { z: -2.1, mean: 0.7 },
    activeTopicCount: { z: 2.9, mean: 5 }
  },
  newlyConvergentTopicIds: ['t3'],
  topicsById
});
for (const item of stress.items) {
  for (const word of FORBIDDEN) {
    assert.ok(!new RegExp(`\\b${word}`, 'i').test(item.text),
      `generated brief item "${item.text}" contains "${word}"`);
  }
  assert.ok(item.evidence && Object.keys(item.evidence).length, `item "${item.text}" carries no evidence`);
}

console.log(`copy tests passed (${collectFiles().length} files swept)`);
