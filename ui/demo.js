// Read-only demo (spec §8 Phase 6). Loads the recorded golden snapshot into
// an in-memory store and renders the real surfaces against it, plus the
// adjudication/exclusion evidence and the committed validation report.
// No Ollama, no Chrome APIs, no pipeline work.
(function() {
  'use strict';

  // An in-memory store exposing the slice of the CTStore API the surfaces use.
  function memoryStore(snapshot) {
    const tables = new Map();
    for (const [name, rows] of Object.entries(snapshot)) tables.set(name, rows.slice());
    let transactions = 0;
    const stats = { get transactions() { return transactions; } };
    const get = (name, key) => {
      const rows = tables.get(name) || [];
      const keyed = Array.isArray(key) ? key.join('|') : key;
      return rows.find(row => {
        const rowKey = name === 'daily_metrics' || name === 'briefs' ? row.day
          : name === 'topics' ? row.topicId
            : name === 'baselines' ? row.metric
              : row.id;
        return String(rowKey) === String(keyed);
      }) || null;
    };
    return {
      stats,
      resetStats() { transactions = 0; },
      async open() { return this; },
      async getAll(name) { transactions++; return (tables.get(name) || []).slice(); },
      async byIndex(name, index, query) {
        transactions++;
        const rows = tables.get(name) || [];
        if (index === 'byDay') return rows.filter(row => row.dayKey === query || row.day === query);
        return rows.slice();
      },
      async get(name, key) { transactions++; return get(name, key); },
      async put() { /* demo is read-only */ },
      async getSettingsMap() {
        return { embeddingModel: 'bge-m3:latest', chatModel: 'gemma3:12b' };
      },
      range(lower, upper) { return { lower, upper }; }
    };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtMinutes(ms) {
    const minutes = Math.round((ms || 0) / 60000);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  }

  // ---- adjudication & exclusion evidence -----------------------------
  function renderEvidence(snapshot, golden) {
    const exclusion = document.getElementById('exclusion-content');
    exclusion.textContent = '';
    const byReason = new Map();
    for (const row of snapshot.uncategorized || []) {
      const entry = byReason.get(row.reason) || { count: 0, dwellMs: 0, urls: [] };
      entry.count++;
      entry.dwellMs += row.dwellMs || 0;
      if (entry.urls.length < 6) entry.urls.push(row.normalizedUrl);
      byReason.set(row.reason, entry);
    }
    const EXPLAIN = {
      no_content: 'The page had no real title and no captured text, so there was nothing honest to embed.',
      thin_evidence: 'A single page with under two minutes of estimated attention — too little evidence to assert a topic.',
      beyond_budget: 'Beyond this run’s per-run topic cap; retried on the next run rather than forced into a topic.',
      agreed_uncategorized: 'Both adjudication passes agreed the pages were too mixed to support any honest label.',
      disagreement: 'The two adjudication passes disagreed, so the record makes no claim about these pages.',
      split_leftover: 'The passes agreed on a split but disputed where these particular pages belonged.'
    };
    if (byReason.size) {
      for (const [reason, entry] of [...byReason.entries()].sort((a, b) => b[1].count - a[1].count)) {
        const row = el('div', 'stat-row');
        row.appendChild(el('span', null, reason.replace(/_/g, ' ')));
        row.appendChild(el('span', 'value', `${entry.count} pages · ${fmtMinutes(entry.dwellMs)}`));
        exclusion.appendChild(row);
        exclusion.appendChild(el('div', 'stat-note', EXPLAIN[reason] || ''));
      }
    }
    const adjudicated = (snapshot.runs || []).reduce((sum, run) => sum + ((run.counts && run.counts.adjudicated) || 0), 0);
    const disagreed = (snapshot.runs || []).reduce((sum, run) => sum + ((run.counts && run.counts.disagreed) || 0), 0);
    exclusion.appendChild(el('div', 'stat-note',
      `Across this recorded run the audit gate fired on ${adjudicated} cluster(s); ${disagreed} ended in pass disagreement. ` +
      'The gate is deliberately quiet: it triggers on low internal cohesion, not on a topic simply spanning several domains.'));

    // Topics with their evidence pages.
    const topicsPanel = document.getElementById('topics-content');
    topicsPanel.textContent = '';
    const pageByUrl = new Map((snapshot.pages || []).map(p => [p.normalizedUrl, p]));
    const membershipsByTopic = new Map();
    for (const membership of snapshot.memberships || []) {
      const list = membershipsByTopic.get(membership.topicId) || [];
      list.push(membership);
      membershipsByTopic.set(membership.topicId, list);
    }
    const topics = (snapshot.topics || []).slice().sort((a, b) => (b.totalDwellMs || 0) - (a.totalDwellMs || 0));
    for (const topic of topics) {
      const memberships = membershipsByTopic.get(topic.topicId) || [];
      const block = el('div', 'evidence-topic');
      const head = el('div', 'evidence-topic-head');
      const left = el('div');
      left.appendChild(el('span', 'evidence-topic-label', topic.label));
      left.appendChild(document.createTextNode(' '));
      left.appendChild(el('span', 'topic-state', topic.state));
      head.appendChild(left);
      head.appendChild(el('span', 'evidence-topic-meta',
        `${memberships.length} pages · ${fmtMinutes(topic.totalDwellMs)} · label from ${topic.labelSource}`));
      block.appendChild(head);
      const list = el('ul', 'evidence-pages');
      list.hidden = true;
      for (const membership of memberships.slice(0, 12)) {
        const page = pageByUrl.get(membership.normalizedUrl);
        list.appendChild(el('li', null, page ? `${page.title} — ${page.domain}` : membership.normalizedUrl));
      }
      if (memberships.length > 12) list.appendChild(el('li', null, `…and ${memberships.length - 12} more`));
      head.addEventListener('click', () => { list.hidden = !list.hidden; });
      block.appendChild(list);
      topicsPanel.appendChild(block);
    }

    // The adjudication protocol, recorded with the gate deliberately widened.
    const protocolPanel = document.getElementById('protocol-content');
    if (protocolPanel) {
      protocolPanel.textContent = '';
      if (!window.__auditDemo) {
        protocolPanel.appendChild(el('div', 'stat-note',
          'No adjudication recording found. Generate one with `node tools/recordAuditDemo.js` (needs local Ollama).'));
      } else {
        const demo = window.__auditDemo;
        protocolPanel.appendChild(el('div', 'stat-note', demo.explanation));
        for (const result of demo.results) {
          const block = el('div', 'evidence-topic');
          const head = el('div', 'evidence-topic-head');
          head.appendChild(el('span', 'evidence-topic-label', result.name));
          head.appendChild(el('span', 'evidence-topic-meta',
            `${result.pageCount} pages · cohesion ${result.cohesion} · ` +
            `${result.gatedInProduction ? 'audited in production' : 'not audited in production'}`));
          block.appendChild(head);
          block.appendChild(el('div', 'stat-note', result.note));

          const verdict = result.summary.kept ? 'both passes agreed: keep'
            : result.summary.split ? 'both passes agreed to split, and their groupings matched closely enough'
              : result.summary.uncategorized ? 'both passes agreed: uncategorized'
                : result.summary.disagreed ? 'the passes disagreed, so the pages are excluded and no claim is made'
                  : result.summary.errors ? 'the model call failed, so the cluster was kept unchanged'
                    : 'no verdict';
          const outcome = el('div', 'stat-row');
          outcome.appendChild(el('span', null, 'Outcome'));
          outcome.appendChild(el('span', 'value', verdict));
          block.appendChild(outcome);
          if (result.verdicts) {
            const detail = el('div', 'stat-row');
            detail.appendChild(el('span', null,
              `Verdicts: ${result.verdicts.pass1} / ${result.verdicts.pass2} (second pass sees the pages reversed)`));
            detail.appendChild(el('span', 'value',
              result.groupingAgreement === null
                ? 'no comparable groupings'
                : `grouping agreement ${result.groupingAgreement} vs threshold ${result.agreementThreshold}`));
            block.appendChild(detail);
          }

          if (result.survivingClusters.length) {
            const list = el('ul', 'evidence-pages');
            for (const cluster of result.survivingClusters) {
              list.appendChild(el('li', null,
                `kept as "${cluster.label}" (${cluster.pageCount} pages${cluster.adjudication ? ', ' + cluster.adjudication : ''})`));
            }
            block.appendChild(list);
          }
          if (result.excluded.length) {
            const list = el('ul', 'evidence-pages');
            const reasons = new Map();
            for (const entry of result.excluded) reasons.set(entry.reason, (reasons.get(entry.reason) || 0) + 1);
            for (const [reason, count] of reasons) {
              list.appendChild(el('li', null, `${count} page(s) excluded — ${reason.replace(/_/g, ' ')}`));
            }
            block.appendChild(list);
          }
          protocolPanel.appendChild(block);
        }

        for (const [index, call] of demo.calls.entries()) {
          const block = el('div', 'call-block');
          const head = el('div', 'call-head');
          head.appendChild(el('span', null, `${call.case} — ${call.kind}`));
          head.appendChild(el('span', null, 'show prompt & reply'));
          const body = el('div', 'call-body');
          body.hidden = true;
          body.textContent = `PROMPT\n------\n${call.prompt}\n\nREPLY\n-----\n${call.reply}`;
          head.addEventListener('click', () => { body.hidden = !body.hidden; });
          block.appendChild(head);
          block.appendChild(body);
          protocolPanel.appendChild(block);
        }
      }
    }

    // Recorded model calls.
    const callsPanel = document.getElementById('calls-content');
    callsPanel.textContent = '';
    if (!golden || !golden.calls.length) {
      callsPanel.appendChild(el('div', 'stat-note', 'No recorded calls found.'));
      return;
    }
    callsPanel.appendChild(el('div', 'stat-note',
      `${golden.calls.length} chat calls to ${golden.chatModel} across ${golden.runDays.length} runs. ` +
      'Embeddings came from the committed fixture cache. Click a call to read the exact prompt and reply.'));
    for (const [index, call] of golden.calls.entries()) {
      const block = el('div', 'call-block');
      const head = el('div', 'call-head');
      head.appendChild(el('span', null, `${index + 1}. ${call.kind}`));
      head.appendChild(el('span', null, 'show prompt & reply'));
      const body = el('div', 'call-body');
      body.hidden = true;
      const reply = call.response && call.response.message ? call.response.message.content : '';
      body.textContent = `PROMPT\n------\n${call.prompt}\n\nREPLY\n-----\n${reply}`;
      head.addEventListener('click', () => { body.hidden = !body.hidden; });
      block.appendChild(head);
      block.appendChild(body);
      callsPanel.appendChild(block);
    }
  }

  // ---- minimal, safe markdown rendering for the validation report ------
  function renderMarkdown(source, container) {
    container.textContent = '';
    const lines = source.split('\n');
    let table = null;
    let code = null;
    for (const line of lines) {
      if (line.startsWith('```')) {
        if (code) { container.appendChild(code); code = null; }
        else code = el('pre');
        continue;
      }
      if (code) { code.textContent += line + '\n'; continue; }
      if (line.startsWith('|')) {
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (cells.every(c => /^-+$/.test(c.replace(/:/g, '')))) continue;
        if (!table) { table = el('table'); container.appendChild(table); }
        const row = el('tr');
        const isHead = table.childNodes.length === 0;
        for (const cell of cells) row.appendChild(el(isHead ? 'th' : 'td', null, cell.replace(/\*\*/g, '')));
        table.appendChild(row);
        continue;
      }
      table = null;
      if (!line.trim()) continue;
      if (line.startsWith('### ')) container.appendChild(el('h3', null, line.slice(4)));
      else if (line.startsWith('## ')) container.appendChild(el('h2', null, line.slice(3)));
      else if (line.startsWith('# ')) container.appendChild(el('h1', null, line.slice(2)));
      else if (line.startsWith('- ')) {
        const last = container.lastChild;
        const list = last && last.tagName === 'UL' ? last : container.appendChild(el('ul'));
        list.appendChild(el('li', null, line.slice(2).replace(/\*\*/g, '').replace(/`/g, '')));
      } else {
        container.appendChild(el('p', null, line.replace(/\*\*/g, '').replace(/`/g, '')));
      }
    }
    if (code) container.appendChild(code);
  }

  // ---- boot -----------------------------------------------------------
  async function main() {
    const [snapshot, golden, auditDemo] = await Promise.all([
      fetch('../fixtures/golden/snapshot.json').then(r => r.json()),
      fetch('../fixtures/golden/calls.json').then(r => r.json()).catch(() => null),
      fetch('../fixtures/golden/audit-demo.json').then(r => r.json()).catch(() => null)
    ]);
    window.__auditDemo = auditDemo;

    const store = memoryStore(snapshot);
    const days = (snapshot.daily_metrics || []).map(m => m.day).sort();
    const lastDay = days[days.length - 1];
    const now = lastDay ? CTText.dayKeyToNoonMs(lastDay) + 9 * 3600 * 1000 : Date.now();

    document.getElementById('demo-sub').textContent =
      `${snapshot.topics.length} topics · ${snapshot.memberships.length} page memberships · ` +
      `${days.length} days of metrics · recorded ${golden ? new Date(golden.recordedAt).toLocaleDateString() : 'locally'}`;

    // Home: the real newtab renderer against the recorded record.
    await CTNewtab.main({
      store,
      container: document.getElementById('app'),
      now,
      statusProvider: () => ({ paused: false, ollama: true })
    });

    // Audit: the real audit renderer.
    const auditData = await CTAudit.loadData(store);
    CTAudit.render(auditData, document, {});

    renderEvidence(snapshot, golden);

    // Validation report (most recent committed one).
    const validationPanel = document.getElementById('validation-content');
    try {
      const index = await fetch('../validation/index.json').then(r => r.json());
      const report = await fetch(`../validation/${index.latest}`).then(r => r.text());
      renderMarkdown(report, validationPanel);
    } catch {
      validationPanel.textContent =
        'No committed validation report found. Run `node tools/validate.js` with local Ollama to generate one.';
    }

    // Tabs.
    const views = { home: 'view-home', audit: 'view-audit', evidence: 'view-evidence', validation: 'view-validation' };
    for (const tab of document.querySelectorAll('.demo-tab')) {
      tab.addEventListener('click', () => {
        for (const other of document.querySelectorAll('.demo-tab')) other.classList.remove('active');
        tab.classList.add('active');
        for (const [name, id] of Object.entries(views)) {
          document.getElementById(id).hidden = name !== tab.dataset.view;
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    main().catch(error => {
      document.getElementById('demo-sub').textContent = `Demo failed to load: ${error.message}`;
      console.error(error);
    });
  });
})();
