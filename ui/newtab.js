// The new-tab home (spec §5.1). Renders in < 100 ms from IndexedDB with no
// Ollama call and no pipeline work; at most 4 IndexedDB reads on load.
// Exposed as CTNewtab so the jsdom test can drive it with fake-indexeddb.
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTNewtab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const RING_DEFS = [
    {
      metric: 'topicEntropy', name: 'Spread',
      value: m => `${(m.topicEntropy || 0).toFixed(1)}`, unit: 'bits',
      fill: m => Math.min((m.topicEntropy || 0) / 4, 1)
    },
    {
      metric: 'continuityShare', name: 'Continuity',
      value: m => `${Math.round((m.continuityShare || 0) * 100)}%`, unit: '',
      fill: m => m.continuityShare || 0
    },
    {
      metric: 'activeMs', name: 'Active',
      value: m => formatHours(m.activeMs || 0), unit: '',
      fill: m => Math.min((m.activeMs || 0) / (8 * 3600 * 1000), 1)
    }
  ];

  const METRIC_ROWS = [
    { metric: 'topicEntropy', name: 'Spread', format: v => `${Number(v).toFixed(1)} bits` },
    { metric: 'activeTopicCount', name: 'Topics touched', format: v => `${Math.round(v)}` },
    { metric: 'switchesPerActiveHour', name: 'Switch rate', format: v => `${Number(v).toFixed(1)}/h` },
    { metric: 'continuityShare', name: 'Continuity', format: v => `${Math.round(v * 100)}%` },
    { metric: 'activeMs', name: 'Active time', format: v => formatHours(v) }
  ];

  function formatHours(ms) {
    const minutes = Math.round(ms / 60000);
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function formatClock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function zInfo(value, baseline) {
    if (!baseline || baseline.mean === null || baseline.n < 14) {
      return { band: 'building', bandText: `building baseline (${baseline ? baseline.n : 0}/14)`, mean: null };
    }
    if (!Number.isFinite(baseline.std) || baseline.std < 1e-6) {
      return { band: 'within', bandText: 'within your range', mean: baseline.mean };
    }
    const z = Math.max(-4, Math.min(4, (value - baseline.mean) / baseline.std));
    const abs = Math.abs(z);
    if (abs < 1) return { band: 'within', bandText: 'within your range', mean: baseline.mean, z };
    if (abs < 2) return { band: 'outside', bandText: 'outside usual', mean: baseline.mean, z };
    return { band: 'unusual', bandText: 'unusual for you', mean: baseline.mean, z };
  }

  // ---- data loading: exactly four store reads --------------------------
  async function loadData(store, todayKey) {
    const dailyMetrics = await store.getAll('daily_metrics');   // 1
    const briefs = await store.getAll('briefs');                // 2
    const baselines = await store.getAll('baselines');          // 3
    const todayCaptures = await store.byIndex('captures', 'byDay', todayKey); // 4
    return { dailyMetrics, briefs, baselines, todayCaptures };
  }

  // ---- rendering -------------------------------------------------------
  function ringSvg(fillShare) {
    const size = 96;
    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    const filled = Math.max(0, Math.min(1, fillShare)) * circumference;
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    const track = document.createElementNS(svgNs, 'circle');
    track.setAttribute('class', 'ring-track');
    const fill = document.createElementNS(svgNs, 'circle');
    fill.setAttribute('class', 'ring-fill');
    for (const circle of [track, fill]) {
      circle.setAttribute('cx', size / 2);
      circle.setAttribute('cy', size / 2);
      circle.setAttribute('r', radius);
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke-width', 8);
      circle.setAttribute('stroke-linecap', 'round');
    }
    fill.setAttribute('stroke-dasharray', `${filled} ${circumference - filled}`);
    fill.setAttribute('stroke-dashoffset', circumference / 4);
    svg.appendChild(track);
    svg.appendChild(fill);
    return svg;
  }

  // Static SVG sparkline: 28 days of one metric plus the baseline mean.
  function sparklineSvg(history, metric, baseline) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const width = 640;
    const height = 46;
    const rows = history.slice(-28).filter(r => !r.lowData);
    const values = rows.map(r => Number(r[metric]) || 0);
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    if (values.length < 2) return svg;
    const min = Math.min(...values, baseline && baseline.mean !== null ? baseline.mean : Infinity);
    const max = Math.max(...values, baseline && baseline.mean !== null ? baseline.mean : -Infinity);
    const span = max - min || 1;
    const x = i => (i / (values.length - 1)) * (width - 8) + 4;
    const y = v => height - 6 - ((v - min) / span) * (height - 12);
    if (baseline && baseline.mean !== null) {
      const mean = document.createElementNS(svgNs, 'line');
      mean.setAttribute('class', 'spark-mean');
      mean.setAttribute('x1', 0);
      mean.setAttribute('x2', width);
      mean.setAttribute('y1', y(baseline.mean));
      mean.setAttribute('y2', y(baseline.mean));
      svg.appendChild(mean);
    }
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('class', 'spark-line');
    path.setAttribute('d', values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''));
    svg.appendChild(path);
    const dot = document.createElementNS(svgNs, 'circle');
    dot.setAttribute('class', 'spark-dot');
    dot.setAttribute('cx', x(values.length - 1));
    dot.setAttribute('cy', y(values[values.length - 1]));
    dot.setAttribute('r', 2.5);
    svg.appendChild(dot);
    return svg;
  }

  function briefTextToNodes(text) {
    // Topic labels arrive as *label*; render them emphasized, never as HTML.
    const fragment = document.createDocumentFragment();
    const parts = String(text).split(/\*([^*]+)\*/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) fragment.appendChild(el('em', null, part));
      else if (part) fragment.appendChild(document.createTextNode(part));
    });
    return fragment;
  }

  function render(container, data, options) {
    const opts = options || {};
    const now = opts.now || Date.now();
    const todayKey = opts.todayKey;
    container.textContent = '';
    const column = el('div', 'newtab-column');
    container.appendChild(column);

    // ---- header
    const header = el('div', 'nt-header');
    header.appendChild(el('div', 'nt-date', new Date(now).toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric'
    })));
    const status = el('div', 'nt-status');
    const dot = el('span', 'nt-status-dot');
    status.appendChild(dot);
    const statusText = el('span', null, 'checking…');
    status.appendChild(statusText);
    header.appendChild(status);
    column.appendChild(header);
    if (opts.statusProvider) {
      Promise.resolve(opts.statusProvider()).then(info => {
        if (!info) { statusText.textContent = ''; return; }
        if (info.paused) {
          dot.className = 'nt-status-dot attention';
          statusText.textContent = 'capture paused';
        } else if (!info.ollama) {
          dot.className = 'nt-status-dot attention';
          statusText.textContent = 'Ollama unreachable';
        } else {
          dot.className = 'nt-status-dot capturing';
          statusText.textContent = 'capturing';
        }
      }).catch(() => { statusText.textContent = ''; });
    } else {
      statusText.textContent = '';
    }

    // ---- empty state
    const history = data.dailyMetrics.slice().sort((a, b) => a.day.localeCompare(b.day));
    if (!history.length) {
      const empty = el('div', 'empty-state');
      empty.appendChild(el('h2', null, 'Cognitive Trails'));
      empty.appendChild(el('p', null, 'A local, passive record of where your browsing attention went. Nothing has been analyzed yet.'));
      const steps = el('ol');
      const items = [
        'Install Ollama and start it (ollama serve).',
        'Pull the local models: ollama pull bge-m3 and ollama pull gemma3:12b.',
        'Browse normally; the first analysis runs on its own when your machine is idle — or open Audit and press "Run now".'
      ];
      for (const item of items) steps.appendChild(el('li', null, item));
      empty.appendChild(steps);
      column.appendChild(empty);
      appendFooter(column, opts);
      return { state: 'empty' };
    }

    const todayRow = history.find(r => r.day === todayKey) || null;
    const latest = todayRow || history[history.length - 1];
    const staleDay = !todayRow;
    const baselineByMetric = new Map((data.baselines || []).map(b => [b.metric, b]));

    // ---- rings
    const ringsCard = el('div', 'nt-card');
    const rings = el('div', 'nt-rings');
    for (const def of RING_DEFS) {
      const ring = el('div', 'nt-ring');
      ring.appendChild(ringSvg(def.fill(latest)));
      ring.appendChild(el('div', 'nt-ring-value', `${def.value(latest)}${def.unit ? ' ' + def.unit : ''}`));
      ring.appendChild(el('div', 'nt-ring-name', def.name));
      const info = zInfo(latest[def.metric], baselineByMetric.get(def.metric));
      ring.appendChild(el('div', 'nt-ring-caption', info.bandText));
      rings.appendChild(ring);
    }
    ringsCard.appendChild(rings);
    if (staleDay) {
      ringsCard.appendChild(el('div', 'nt-brief-stamp', `Showing ${latest.day} — today has not been analyzed yet.`));
    }
    column.appendChild(ringsCard);

    // ---- live today strip when today's run has not happened
    if (staleDay && data.todayCaptures && data.todayCaptures.length) {
      const activeMs = data.todayCaptures.reduce((sum, c) => sum + (c.activeMs || 0), 0);
      const strip = el('div', 'nt-card nt-live-strip');
      strip.textContent = `Today so far (live, unanalyzed): ${data.todayCaptures.length} pages, ${formatHours(activeMs)} active.`;
      column.appendChild(strip);
    }

    // ---- within your range
    const rangeCard = el('div', 'nt-card');
    rangeCard.appendChild(el('h2', null, 'Within your range'));
    let withinCount = 0;
    let comparableCount = 0;
    const rows = [];
    for (const def of METRIC_ROWS) {
      const info = zInfo(latest[def.metric], baselineByMetric.get(def.metric));
      if (info.band !== 'building') {
        comparableCount++;
        if (info.band === 'within') withinCount++;
      }
      rows.push({ def, info });
    }
    rangeCard.appendChild(el('div', 'nt-range-summary',
      comparableCount
        ? `${withinCount}/${comparableCount} metrics within your range`
        : `building baseline (${(data.baselines[0] || { n: 0 }).n || 0}/14 days)`));
    for (const { def, info } of rows) {
      const row = el('div', 'nt-metric-row');
      row.appendChild(el('div', 'nt-metric-name', def.name));
      row.appendChild(el('div', 'nt-metric-value', def.format(latest[def.metric] || 0)));
      row.appendChild(el('div', 'nt-metric-baseline',
        info.mean !== null && info.mean !== undefined ? `usual ${def.format(info.mean)}` : ''));
      row.appendChild(el('span', `nt-band ${info.band}`, info.bandText));
      const sparkRow = el('div', 'nt-sparkline-row');
      sparkRow.hidden = true;
      row.addEventListener('click', () => {
        if (sparkRow.hidden && !sparkRow.childNodes.length) {
          sparkRow.appendChild(sparklineSvg(history, def.metric, baselineByMetric.get(def.metric)));
        }
        sparkRow.hidden = !sparkRow.hidden;
      });
      rangeCard.appendChild(row);
      rangeCard.appendChild(sparkRow);
    }
    column.appendChild(rangeCard);

    // ---- outlook (brief)
    const briefs = (data.briefs || []).slice().sort((a, b) => b.day.localeCompare(a.day));
    const brief = briefs.find(b => b.day === todayKey) || briefs[0] || null;
    const outlook = el('div', 'nt-card');
    outlook.appendChild(el('h2', null, 'Outlook'));
    if (brief && brief.items.length) {
      const list = el('ul', 'nt-brief-list');
      for (const item of brief.items.slice(0, 5)) {
        const li = el('li');
        li.appendChild(briefTextToNodes(item.text));
        list.appendChild(li);
      }
      outlook.appendChild(list);
      outlook.appendChild(el('div', 'nt-brief-stamp',
        `${brief.day === todayKey ? 'Today' : brief.day} — computed at ${formatClock(brief.generatedAt)}`));
    } else {
      outlook.appendChild(el('div', 'nt-brief-stamp', 'No brief yet for this record.'));
    }
    column.appendChild(outlook);

    // ---- today's activities (focused runs)
    const runsCard = el('div', 'nt-card');
    runsCard.appendChild(el('h2', null, staleDay ? `Activities — ${latest.day}` : "Today's activities"));
    const runs = latest.runs || [];
    if (runs.length) {
      for (const run of runs) {
        const row = el('div', 'nt-run-row');
        row.appendChild(el('div', 'nt-run-label', run.label));
        row.appendChild(el('div', 'nt-run-time', `${formatClock(run.startAt)}–${formatClock(run.endAt)}`));
        row.appendChild(el('div', 'nt-run-dwell', `${Math.round(run.dwellMs / 60000)}m`));
        runsCard.appendChild(row);
      }
    } else {
      runsCard.appendChild(el('div', 'nt-brief-stamp', 'No focused runs of 5 minutes or more.'));
    }
    column.appendChild(runsCard);

    appendFooter(column, opts);
    return { state: 'rendered', brief, staleDay };
  }

  function appendFooter(column, opts) {
    const footer = el('div', 'nt-footer');
    for (const [href, label] of [['map.html', 'Map'], ['audit.html', 'Audit'], ['options.html', 'Settings']]) {
      const link = el('a', null, label);
      link.href = href;
      footer.appendChild(link);
    }
    const pause = el('button', null, 'Pause capture');
    pause.addEventListener('click', () => {
      if (opts.onTogglePause) opts.onTogglePause(pause);
    });
    footer.appendChild(pause);
    column.appendChild(footer);
  }

  // ---- entry -----------------------------------------------------------
  async function main(deps) {
    const d = deps || {};
    const store = d.store || CTStore.createStore({});
    await store.open();
    store.resetStats();
    const now = d.now || Date.now();
    const todayKey = CTText.dayKeyFromMs(now);
    const data = await loadData(store, todayKey);
    const readTransactions = store.stats.transactions;
    const container = d.container || document.getElementById('app');
    const result = render(container, data, {
      now,
      todayKey,
      statusProvider: d.statusProvider,
      onTogglePause: d.onTogglePause
    });
    // Mark the brief seen AFTER render so the load path stays at 4 reads.
    if (result.brief && !result.brief.seen) {
      setTimeout(() => {
        store.put('briefs', { ...result.brief, seen: true, seenAt: Date.now() }).catch(() => {});
      }, 1500);
    }
    return { ...result, readTransactions };
  }

  return { main, render, loadData, zInfo };
});

// Auto-boot only inside the extension page.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    CTNewtab.main({
      statusProvider: () => new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'GET_CAPTURE_STATUS' }, response => {
          resolve(chrome.runtime.lastError ? null : response);
        });
      }),
      onTogglePause: button => {
        const pausing = button.textContent === 'Pause capture';
        chrome.runtime.sendMessage({ type: 'SET_CAPTURE_PAUSED', paused: pausing }, () => {
          button.textContent = pausing ? 'Resume capture' : 'Pause capture';
        });
      }
    }).catch(error => console.error('newtab render failed', error));
  });
}
