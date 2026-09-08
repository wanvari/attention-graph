// Render tests for the topic map (ui/map.js + ui/mapData.js).
//
// The map shipped broken for the whole of v4 because nothing ever executed
// it: `tests/ui.test.js` only read `mapData.js` as text to sweep it for
// valence hues. `renderSummary` was still reading the v3 snapshot shape
// (`analysis.metrics.switchBurden`) that the v4 registry adapter never
// produces, so every load threw and the loader's catch painted "Registry
// unavailable". These tests drive the real class against a seeded store so
// a shape drift like that fails here instead of in the browser.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const root = path.join(__dirname, '..');

// The header/workspace skeleton map.js reaches into by id. Lifted from
// ui/map.html so the two cannot drift apart silently.
const SKELETON = `
  <div class="container">
    <header>
      <h1>Cognitive Trails</h1>
      <div id="status-line"></div>
      <div id="health-pill"></div>
      <select id="window-days"><option value="7">7</option><option value="30" selected>30</option><option value="90">90</option></select>
      <select id="flow-limit"><option value="25" selected>25</option><option value="all">All</option></select>
      <select id="topic-limit"><option value="18" selected>18</option><option value="all">All</option></select>
      <div id="staleness-banner" hidden></div>
      <div id="summary-strip"></div>
      <div id="legend"></div>
    </header>
    <div class="workspace">
      <div id="graph-container"><svg id="graph"></svg></div>
      <aside id="evidence-panel"></aside>
    </div>
    <div id="loading"></div>
    <div id="tooltip"></div>
  </div>
`;

function freshDom() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${SKELETON}</body></html>`, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'https://localhost/map.html'
  });
  const { window } = dom;
  // jsdom has no layout, so every element measures 0x0 and the visualizer
  // would size the canvas to its 1000x650 fallback via `|| 1000`. Give the
  // graph container a real box so the force layout runs on real numbers.
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 1200, height: 700, top: 0, left: 0, right: 1200, bottom: 700, x: 0, y: 0 };
  };
  // jsdom implements SVG elements but not the SVGAnimatedLength properties
  // d3-zoom's defaultExtent reads (`svg.width.baseVal.value`). Nothing in the
  // product depends on the shim; it only stands in for layout jsdom lacks.
  for (const name of ['width', 'height']) {
    Object.defineProperty(window.SVGSVGElement.prototype, name, {
      configurable: true,
      get() { return { baseVal: { value: Number(this.getAttribute(name)) || 0 } }; }
    });
  }
  if (!window.SVGElement.prototype.getBBox) {
    window.SVGElement.prototype.getBBox = function () {
      return { x: 0, y: 0, width: 40, height: 12 };
    };
  }
  return dom;
}

function loadMap(window) {
  global.window = window;
  global.document = window.document;
  global.Node = window.Node;
  global.navigator = window.navigator;
  global.getComputedStyle = window.getComputedStyle.bind(window);

  // d3 is a browser UMD bundle; evaluate it inside the jsdom realm so its
  // selection code sees that realm's document.
  window.eval(fs.readFileSync(path.join(root, 'vendor', 'd3.min.js'), 'utf8'));
  global.d3 = window.d3;

  for (const mod of ['../lib/text.js', '../lib/privacy.js', '../lib/store.js', '../ui/mapData.js', '../ui/map.js']) {
    delete require.cache[require.resolve(mod)];
  }
  global.CTText = require('../lib/text.js');
  global.CTPrivacy = require('../lib/privacy.js');
  global.CTStore = require('../lib/store.js');
  global.CTMapData = require('../ui/mapData.js');
  return require('../ui/map.js');
}

// A minimal but complete registry: two topics, real visits on two days, one
// membership per page, and one transition row of each type.
async function seedRegistry(store, CTText, today) {
  const dayA = today;
  const dayB = CTText.addDays(today, -1);
  const dim = 8;
  const centroid = seed => Array.from({ length: dim }, (_, i) => Math.sin(seed + i));

  await store.bulkPut('topics', [
    {
      topicId: 'topic-rust', label: 'Async Rust Programming', state: 'active',
      confidence: 0.81, heuristicConfidence: 0.77, adjudication: 'agreed',
      keywords: ['rust', 'async'], rationale: 'Pages shared Rust async runtime vocabulary.',
      lastActiveDay: dayA, createdAt: Date.now(), labelSource: 'llm',
      centroid: CTStore.vecToBuf(centroid(1))
    },
    {
      topicId: 'topic-bread', label: 'Sourdough Baking', state: 'active',
      confidence: 0.74, heuristicConfidence: 0.7, adjudication: 'agreed',
      keywords: ['sourdough', 'starter'], rationale: 'Pages shared bread-baking vocabulary.',
      lastActiveDay: dayB, createdAt: Date.now(), labelSource: 'llm',
      centroid: CTStore.vecToBuf(centroid(9))
    }
  ]);

  const pages = [
    ['https://docs.rs/tokio', 'Tokio docs', 'docs.rs', 'topic-rust', dayA],
    ['https://rust-lang.org/async', 'Async book', 'rust-lang.org', 'topic-rust', dayA],
    ['https://kingarthur.com/sourdough', 'Sourdough guide', 'kingarthur.com', 'topic-bread', dayB]
  ];
  await store.bulkPut('pages', pages.map(([url, title, domain]) => ({
    normalizedUrl: CTText.normalizeUrl(url), url, title, domain,
    source: 'web', visitCount: 2, dwellMs: 9e5, activeMs: 6e5, hadTitle: true
  })));
  await store.bulkPut('memberships', pages.map(([url, , , topicId]) => ({
    normalizedUrl: CTText.normalizeUrl(url), topicId, assignedRunId: 'run-1',
    similarity: 0.84, dwellMs: 9e5, visitCount: 2
  })));
  await store.bulkPut('visits', pages.flatMap(([url, title, domain, , day], i) =>
    [0, 1].map(n => ({
      visitId: `v-${i}-${n}`, url, normalizedUrl: CTText.normalizeUrl(url), title, domain,
      visitTime: CTText.dayKeyToNoonMs(day) + n * 6e5, transition: 'link',
      sessionId: 0, dwellMs: 45e4, endsSession: false, dayKey: day, source: 'web'
    }))
  ));

  await store.bulkPut('transitions', [
    {
      day: dayA, sourceTopicId: 'topic-rust', targetTopicId: 'topic-bread',
      type: 'topic_switch', similarity: 0.21, confidence: 0.6, visitCount: 4,
      verified: true, uncertain: false, llmLabeled: true, hourCounts: new Array(24).fill(0)
    },
    {
      day: dayA, sourceTopicId: 'topic-rust', targetTopicId: 'topic-rust',
      type: 'same_topic_flow', similarity: 1, confidence: 0.88, visitCount: 7,
      verified: false, uncertain: false, llmLabeled: false, hourCounts: new Array(24).fill(0)
    }
  ]);

  await store.bulkPut('daily_metrics', [dayA, dayB].map(day => ({
    day, computedAt: Date.now(), runId: 'run-1', activeMs: 5.4e6, visitCount: 3,
    categorizedShare: 0.9, topicEntropy: 1.2, activeTopicCount: 2,
    switchesPerActiveHour: 2.1, continuityShare: 0.64, uncoveredTransitions: 2,
    convergenceCount: 0, convergentTopicIds: [], dormantCount: 0, revivedCount: 0,
    topTopics: [], runs: [], lowData: false
  })));
  await store.put('runs', {
    runId: 'run-1', status: 'ok', startedAt: Date.now() - 6e5, finishedAt: Date.now(),
    durationMs: 6e5, counts: {}, warnings: []
  });
  await store.put('uncategorized', {
    day: dayA, normalizedUrl: 'https://example.com/unknown', reason: 'thin evidence',
    dwellMs: 12e4, runId: 'run-1'
  });
}

async function renderMap() {
  const dom = freshDom();
  const { window } = dom;
  const CTMap = loadMap(window);
  const CTText = global.CTText;

  const store = global.CTStore.createStore({ indexedDB: new IDBFactory(), IDBKeyRange });
  await store.open();
  const today = CTText.dayKeyFromMs(Date.now());
  await seedRegistry(store, CTText, today);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args[0]);
  const viz = new CTMap.TopicMapVisualizer({ store });
  // loadAnalysis is fired from the constructor; let its promise chain settle.
  await new Promise(resolve => setTimeout(resolve, 50));
  console.error = originalError;
  return { viz, window, store, errors, today };
}

(async () => {
  // ---- the regression that shipped ------------------------------------
  {
    const { viz, window, errors } = await renderMap();
    assert.deepStrictEqual(
      errors.map(e => (e && e.stack) || String(e)), [],
      'the map threw while rendering a populated registry'
    );
    assert.ok(viz.analysis, 'no analysis was ever assigned');
    assert.strictEqual(viz.analysis.ok, true, 'analysis reported not-ok on a seeded registry');

    const health = window.document.getElementById('health-pill').textContent;
    assert.ok(!/unavailable/i.test(health), `health pill still reads "${health}"`);
    assert.ok(
      !/Could not read the registry/.test(window.document.body.textContent),
      'the failure panel rendered despite a healthy registry'
    );
  }

  // ---- every field renderSummary reads must exist on the v4 shape ------
  {
    const { viz, window } = await renderMap();
    const a = viz.analysis;
    assert.ok(a.metrics, 'analysis.metrics is missing — renderSummary reads it');
    assert.ok(a.metrics.switching, 'analysis.metrics.switching is missing');
    assert.strictEqual(typeof a.metrics.switching.switchCount, 'number');
    assert.strictEqual(typeof a.metrics.switching.switchesPerActiveHour, 'number');
    assert.ok(Array.isArray(a.metrics.transitionMix.items), 'transitionMix.items is not an array');
    assert.ok(Array.isArray(a.metrics.topicTimeShare), 'topicTimeShare is not an array');
    assert.strictEqual(typeof a.source, 'string', 'analysis.source is missing — the evidence panel prints it');

    const strip = window.document.getElementById('summary-strip').textContent;
    assert.ok(/topics shown/.test(strip), 'summary strip did not render');
    assert.ok(/between-topic visits/.test(strip), 'switch count missing from the summary strip');
    assert.ok(/changes per est. hour/.test(strip), 'switch rate missing from the summary strip');
    assert.ok(!/undefined/.test(strip), `summary strip printed "undefined": ${strip}`);
  }

  // ---- the switch figures must match the edges actually drawn ----------
  {
    const { viz } = await renderMap();
    const switching = viz.analysis.metrics.switching;
    const drawnSwitches = viz.analysis.transitions
      .filter(t => t.type === 'topic_switch')
      .reduce((sum, t) => sum + t.visitCount, 0);
    assert.strictEqual(
      switching.switchCount, drawnSwitches,
      'the summary claims a different switch count than the map draws'
    );
    const mixTotal = viz.analysis.metrics.transitionMix.items.reduce((s, i) => s + i.count, 0);
    const edgeTotal = viz.analysis.transitions.reduce((s, t) => s + t.visitCount, 0);
    assert.strictEqual(mixTotal, edgeTotal, 'transition mix does not sum to the drawn edges');
  }

  // ---- graph + evidence panel actually populate ------------------------
  {
    const { viz, window } = await renderMap();
    const topicNodes = viz.graphData.nodes.filter(n => n.type === 'topic');
    assert.strictEqual(topicNodes.length, 2, 'expected both seeded topics as nodes');
    assert.ok(window.document.querySelectorAll('#graph circle').length > 0, 'no nodes were drawn');

    const evidence = window.document.getElementById('evidence-panel').textContent;
    assert.ok(/Async Rust Programming/.test(evidence), 'top topic missing from the evidence panel');
    assert.ok(!/undefined/.test(evidence), `evidence panel printed "undefined": ${evidence}`);

    const legend = window.document.getElementById('legend').textContent;
    assert.ok(/Highest estimated time/.test(legend), 'legend did not render');
  }

  // Repeated edges show actual examples; correcting one page removes stale
  // connections and transfers exactly its time to the ungrouped denominator.
  {
    const { viz, store, window } = await renderMap();
    const edge = viz.analysis.transitions[0];
    assert.ok(edge && edge.visitCount >= 2);
    viz.selectTransition(edge);
    assert.ok(window.document.getElementById('evidence-panel').textContent.includes(edge.examples[0].from.title));
    const before = viz.analysis.coverage.estimatedActiveMs;
    const url = 'https://docs.rs/tokio';
    await require('../lib/integrity').repair(store, { correction: { correctionId: `page:${url}`, kind: 'page_membership', targetId: url, value: { topicId: null }, updatedAt: Date.now() } });
    const after = await global.CTMapData.build(store, { windowDays: 30 });
    assert.equal(after.coverage.estimatedActiveMs, before);
    assert.equal(after.transitions.length, 0);
    assert.ok(after.uncategorized.pages.some(p => p.id === url));
  }

  // ---- empty registry takes the honest path, not the failure path ------
  {
    const dom = freshDom();
    const CTMap = loadMap(dom.window);
    const store = global.CTStore.createStore({ indexedDB: new IDBFactory(), IDBKeyRange });
    await store.open();
    const viz = new CTMap.TopicMapVisualizer({ store });
    await new Promise(resolve => setTimeout(resolve, 50));
    const body = dom.window.document.body.textContent;
    assert.ok(/Nothing mapped yet/.test(body), 'empty registry should say nothing is mapped yet');
    assert.ok(
      !/Could not read the registry/.test(body),
      'an empty registry was reported as a read failure'
    );
  }

  console.log('map.test.js: all assertions passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
