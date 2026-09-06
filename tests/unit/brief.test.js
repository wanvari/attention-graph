'use strict';
const assert = require('assert');
const CTBrief = require('../../lib/brief.js');

const FORBIDDEN = ['should', 'focus', 'productive', 'distract', 'goal', 'improve', 'better', 'worse', 'good', 'bad'];

const topicsById = new Map([
  ['t1', { topicId: 't1', label: 'Information foraging theory', totalDwellMs: 900 * 60000, lastActiveDay: '2026-03-01' }],
  ['t2', { topicId: 't2', label: 'Ollama quantization', totalDwellMs: 500 * 60000, lastActiveDay: '2026-03-01' }],
  ['t3', { topicId: 't3', label: 'Sourdough baking', totalDwellMs: 100 * 60000, lastActiveDay: '2026-03-01' }],
  ['t4', { topicId: 't4', label: 'Attention entropy', totalDwellMs: 50 * 60000, lastActiveDay: '2026-03-14' }]
]);

function assertNoForbiddenWords(brief) {
  for (const item of brief.items) {
    const lower = item.text.toLowerCase();
    for (const word of FORBIDDEN) {
      assert.ok(!new RegExp(`\\b${word}`).test(lower), `"${item.text}" contains forbidden word "${word}"`);
    }
  }
}

// --- priority order and 5-item cap
{
  const brief = CTBrief.buildBrief({
    day: '2026-03-15',
    metrics: { lowData: false, topicEntropy: 3.4, activeMs: 3 * 3600000 },
    gap: { days: 3, from: '2026-03-11', to: '2026-03-13' },
    pausedMsToday: 2 * 3600000,
    events: [
      { type: 'revived', topicId: 't1', detail: { dormantDays: 23 } },
      { type: 'dormant', topicId: 't2', detail: {} },
      { type: 'dormant', topicId: 't3', detail: {} },
      { type: 'created', topicId: 't4', detail: {} }
    ],
    zScores: { topicEntropy: { z: 2.4, mean: 2.1 } },
    newlyConvergentTopicIds: ['t4'],
    topicsById
  });
  assert.strictEqual(brief.items.length, 5, 'capped at five items');
  assert.strictEqual(brief.items[0].kind, 'data_gap', 'data gaps beat everything');
  const kinds = brief.items.map(i => i.kind);
  const order = ['data_gap', 'revival', 'dormancy', 'convergence', 'deviation', 'new_topics'];
  const ranks = kinds.map(k => order.indexOf(k));
  assert.deepStrictEqual(ranks, ranks.slice().sort((a, b) => a - b), `priority order violated: ${kinds}`);
  assert.ok(!kinds.includes('new_topics'), 'new topics only fill empty slots');
  assertNoForbiddenWords(brief);
  assert.ok(brief.items.every(i => i.evidence && Object.keys(i.evidence).length), 'every item has evidence');
}

// --- gap text and dormancy ordering by lifetime dwell
{
  const brief = CTBrief.buildBrief({
    day: '2026-03-18',
    metrics: { lowData: false },
    gap: { days: 3, from: '2026-03-15', to: '2026-03-17' },
    events: [
      { type: 'dormant', topicId: 't3', detail: {} },
      { type: 'dormant', topicId: 't1', detail: {} },
      { type: 'dormant', topicId: 't2', detail: {} }
    ],
    topicsById
  });
  assert.ok(brief.items[0].text.startsWith('No browsing recorded for 3 days ('));
  const dormancyItems = brief.items.filter(i => i.kind === 'dormancy');
  assert.strictEqual(dormancyItems.length, 2, 'max two dormancy items');
  assert.ok(dormancyItems[0].text.includes('Information foraging theory'), 'highest lifetime dwell first');
  assert.ok(dormancyItems[0].text.includes('went quiet'));
  assertNoForbiddenWords(brief);
}

// --- revival requires >= 14 dormant days; label verbatim in italics
{
  const brief = CTBrief.buildBrief({
    day: '2026-03-25',
    metrics: { lowData: false },
    events: [
      { type: 'revived', topicId: 't1', detail: { dormantDays: 23 } },
      { type: 'revived', topicId: 't2', detail: { dormantDays: 5 } }
    ],
    topicsById
  });
  const revivals = brief.items.filter(i => i.kind === 'revival');
  assert.strictEqual(revivals.length, 1, 'short dormancies are not revival stories');
  assert.strictEqual(revivals[0].text, '*Information foraging theory* returned after 23 dormant days.');
  assert.deepStrictEqual(revivals[0].topicIds, ['t1']);
}

// --- convergence copy: presence, never relatedness
{
  const brief = CTBrief.buildBrief({
    day: '2026-03-08',
    metrics: { lowData: false },
    newlyConvergentTopicIds: ['t4'],
    topicsById
  });
  const item = brief.items.find(i => i.kind === 'convergence');
  assert.strictEqual(item.text, '*Attention entropy* appeared in both browsing and LLM chats this week.');
  assert.deepStrictEqual(item.evidence.sources, ['web', 'llm_chat']);
  assertNoForbiddenWords(brief);
}

// --- deviations only at |z| >= 2, suppressed on low-data days
{
  const zScores = {
    topicEntropy: { z: 2.4, mean: 2.1 },
    activeTopicCount: { z: 1.5, mean: 6 }
  };
  const metrics = { lowData: false, topicEntropy: 3.4, activeTopicCount: 9 };
  const brief = CTBrief.buildBrief({ day: '2026-03-10', metrics, zScores, topicsById });
  const deviations = brief.items.filter(i => i.kind === 'deviation');
  assert.strictEqual(deviations.length, 1, '|z| < 2 stays silent');
  assert.strictEqual(deviations[0].text, 'Spread was unusual for you today (3.4 bits vs your usual 2.1 bits).');

  const lowDataBrief = CTBrief.buildBrief({ day: '2026-03-10', metrics: { ...metrics, lowData: true }, zScores, topicsById });
  assert.strictEqual(lowDataBrief.items.filter(i => i.kind === 'deviation').length, 0,
    'a low-data day cannot support deviation claims');
}

// --- first-run text
{
  const brief = CTBrief.buildBrief({
    day: '2026-03-01',
    firstRun: true,
    metrics: { lowData: false },
    events: [{ type: 'created', topicId: 't1', detail: {} }],
    topicsById
  });
  assert.strictEqual(brief.items[0].kind, 'first_run');
  assert.ok(brief.items[0].text.includes('First analysis complete'));
  assertNoForbiddenWords(brief);
}

// --- new topics wording
{
  const single = CTBrief.buildBrief({
    day: '2026-03-02', metrics: { lowData: false },
    events: [{ type: 'created', topicId: 't2', detail: {} }], topicsById
  });
  assert.strictEqual(single.items[0].text, 'A new trail was grouped: *Ollama quantization*.');
  const multiple = CTBrief.buildBrief({
    day: '2026-03-02', metrics: { lowData: false },
    events: [
      { type: 'created', topicId: 't2', detail: {} },
      { type: 'created', topicId: 't3', detail: {} }
    ],
    topicsById
  });
  assert.ok(multiple.items[0].text.startsWith('2 new trails were grouped:'));
}

// --- forbidden-word sweep over a stress input with every kind present
{
  const brief = CTBrief.buildBrief({
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
    newlyConvergentTopicIds: ['t4'],
    topicsById
  });
  assert.ok(brief.items.length <= 5);
  assertNoForbiddenWords(brief);
}

console.log('brief tests passed');
