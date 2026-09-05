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

  // A new tab is somewhere you start a search from. Overriding Chrome's new
  // tab took that away, so the page has to give it back: chrome.search.query
  // routes to whichever engine the user already chose, so nothing here knows
  // or hardcodes a provider, and no query ever reaches the extension's record.
  function buildSearch(opts) {
    const form = el('form', 'nt-search');
    form.setAttribute('role', 'search');
    const input = el('input', 'nt-search-input');
    input.type = 'text';
    input.name = 'q';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Search the web';
    input.setAttribute('aria-label', 'Search the web');
    form.appendChild(input);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query || !opts.onSearch) return;
      opts.onSearch(query);
      input.value = '';
    });
    return form;
  }

  // Trailing-window totals straight out of the daily rows already loaded, so
  // this costs no extra read. Its job is to keep the page from going blank on
  // a thin day: the rings still report today and only today, but they no
  // longer stand alone next to ten days of record the page never mentions.
  function windowSummary(history, todayKey, days) {
    const from = CTText.addDays(todayKey, -(days - 1));
    const rows = history.filter(r => r.day >= from && r.day <= todayKey);
    const activeMs = rows.reduce((sum, r) => sum + (r.activeMs || 0), 0);
    const dwellByTopic = new Map();
    for (const row of rows) {
      for (const topic of row.topTopics || []) {
        const entry = dwellByTopic.get(topic.topicId) || { label: topic.label, dwellMs: 0 };
        entry.dwellMs += topic.dwellMs || 0;
        dwellByTopic.set(topic.topicId, entry);
      }
    }
    return {
      days: rows.length,
      activeMs,
      topics: Array.from(dwellByTopic.values()).sort((a, b) => b.dwellMs - a.dwellMs)
    };
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
    const page = el('div', 'nt-page');
    container.appendChild(page);

    // ---- zone 1: the browser surface -----------------------------------
    // Search comes first and owns its own space. The record is a separate
    // zone below it, so the page reads as a new tab that also keeps a record
    // rather than a dashboard that happens to have replaced the new tab.
    const hero = el('section', 'nt-hero');
    page.appendChild(hero);

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
    hero.appendChild(header);

    hero.appendChild(buildSearch(opts));

    const divider = el('div', 'nt-divider');
    divider.appendChild(el('span', null, 'Your record'));
    page.appendChild(divider);

    // ---- zone 2: the record --------------------------------------------
    const column = el('div', 'newtab-column');
    page.appendChild(column);
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

    // Today can legitimately be empty. Without this the whole page reads as
    // zeros and says nothing about the record that does exist.
    const week = windowSummary(history, todayKey, 7);
    if (week.days) {
      const context = el('div', 'nt-window');
      const stat = (value, label) => {
        const item = el('div', 'nt-window-stat');
        item.appendChild(el('span', 'nt-window-value', value));
        item.appendChild(el('span', 'nt-window-label', label));
        return item;
      };
      context.appendChild(stat(`${week.days}`, week.days === 1 ? 'day recorded' : 'days recorded'));
      context.appendChild(stat(formatHours(week.activeMs), 'active'));
      context.appendChild(stat(`${week.topics.length}`, 'topics touched'));
      const heading = el('div', 'nt-window-heading', 'Last 7 days');
      ringsCard.appendChild(heading);
      ringsCard.appendChild(context);
      if (week.topics.length) {
        ringsCard.appendChild(el('div', 'nt-window-topics',
          week.topics.slice(0, 3).map(t => t.label).join(' · ')));
      }
    }
    column.appendChild(ringsCard);

    // ---- live today strip when today's run has not happened
    if (staleDay && data.todayCaptures && data.todayCaptures.length) {
      const activeMs = data.todayCaptures.reduce((sum, c) => sum + (c.activeMs || 0), 0);
      const strip = el('div', 'nt-card nt-live-strip');
      strip.textContent = `Today so far (live, unanalyzed): ${data.todayCaptures.length} pages, ${formatHours(activeMs)} active.`;
      column.appendChild(strip);
    }

    // ---- the record's lower half. One flex child on narrow windows, a
    // two-column grid on wide ones (see .nt-lower in newtab.css).
    const lower = el('div', 'nt-lower');
    column.appendChild(lower);
    const side = el('div', 'nt-side');

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
      // The row is a real control, so it needs real control semantics:
      // reachable by keyboard, announced as a button, and operable with
      // Enter/Space rather than click alone.
      const sparkId = `spark-${def.metric}`;
      sparkRow.id = sparkId;
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-expanded', 'false');
      row.setAttribute('aria-controls', sparkId);
      row.setAttribute('aria-label', `${def.name}: ${def.format(latest[def.metric] || 0)}, ${info.bandText}. Show 28-day history.`);
      const toggle = () => {
        if (sparkRow.hidden && !sparkRow.childNodes.length) {
          sparkRow.appendChild(sparklineSvg(history, def.metric, baselineByMetric.get(def.metric)));
        }
        sparkRow.hidden = !sparkRow.hidden;
        row.setAttribute('aria-expanded', String(!sparkRow.hidden));
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          toggle();
        }
      });
      rangeCard.appendChild(row);
      rangeCard.appendChild(sparkRow);
    }
    lower.appendChild(rangeCard);

    // ---- outlook (brief)
    // A day with nothing lifecycle-worthy to report produces a brief with zero
    // items. Falling back to the newest brief by date then picked that empty
    // one and printed "no brief yet", hiding every earlier brief that did have
    // something to say.
    const briefs = (data.briefs || []).slice().sort((a, b) => b.day.localeCompare(a.day));
    const todayBrief = briefs.find(b => b.day === todayKey);
    const brief = (todayBrief && todayBrief.items && todayBrief.items.length)
      ? todayBrief
      : briefs.find(b => b.items && b.items.length) || todayBrief || null;
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
        `${brief.day === todayKey ? 'Today' : `Most recent — ${brief.day}`} — computed at ${formatClock(brief.generatedAt)}`));
    } else {
      outlook.appendChild(el('div', 'nt-brief-stamp', 'No brief yet for this record.'));
    }
    side.appendChild(outlook);

    // ---- today's activities (focused runs)
    const runsCard = el('div', 'nt-card');
    side.appendChild(runsCard);
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
    lower.appendChild(side);

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
      onTogglePause: d.onTogglePause,
      onSearch: d.onSearch
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
// The demo page renders these surfaces itself against a recorded store,
// so the live boot path must not also run there.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id &&
    typeof document !== 'undefined' && !globalThis.__CT_DEMO__) {
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
      },
      // The user's own default engine, resolved by Chrome. The query is never
      // read, stored, or routed through the extension's record.
      //
      // chrome.search needs the "search" permission, which means it is absent
      // until the extension is reloaded after a manifest change. Silently
      // doing nothing in that case just looks like a broken search box, so
      // fall back to a plain query URL and say why in the console.
      onSearch: query => {
        const fallback = () => {
          window.location.assign(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
        };
        if (!chrome.search || !chrome.search.query) {
          console.warn(
            'chrome.search is unavailable, so this search used Google directly rather than ' +
            'your default engine. Reload the extension at chrome://extensions/ to pick up the ' +
            '"search" permission.'
          );
          fallback();
          return;
        }
        try {
          chrome.search.query({ text: query, disposition: 'CURRENT_TAB' }, () => {
            if (chrome.runtime.lastError) {
              console.warn('chrome.search.query failed:', chrome.runtime.lastError.message);
              fallback();
            }
          });
        } catch (error) {
          console.warn('chrome.search.query threw:', error);
          fallback();
        }
      }
    }).then(() => {
      // Typing should go somewhere useful the moment the tab opens. Cmd/Ctrl+L
      // still reaches the address bar.
      const input = document.querySelector('.nt-search-input');
      if (input) input.focus();
    }).catch(error => console.error('newtab render failed', error));
  });
}
