// Trust audit dashboard (spec §5.2): run history, registry stats, coverage
// honesty, uncategorized by reason, storage, Run now / Export / Delete.
// Exposed as CTAudit so tests and the demo can drive it with injected data.
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTAudit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function statRow(name, value) {
    const row = el('div', 'stat-row');
    row.appendChild(el('span', null, name));
    row.appendChild(el('span', 'value', String(value)));
    return row;
  }

  function fmtMinutes(ms) {
    const minutes = Math.round((ms || 0) / 60000);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  }

  function fmtPct(share) {
    return `${Math.round((share || 0) * 100)}%`;
  }

  async function loadData(store) {
    return {
      runs: await store.getAll('runs'),
      topics: await store.getAll('topics'),
      events: await store.getAll('topic_events'),
      metrics: await store.getAll('daily_metrics'),
      uncategorized: await store.getAll('uncategorized'),
      pages: await store.getAll('pages'),
      corrections: await store.getAll('corrections'),
      settings: await store.getSettingsMap()
    };
  }

  function render(data, doc, hooks) {
    const d = doc || document;
    const byId = id => d.getElementById(id);

    // ---- coverage & honesty ------------------------------------------
    const coverage = byId('coverage-content');
    coverage.textContent = '';
    const recent = data.metrics.slice().sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14);
    if (recent.length) {
      const activeMs = recent.reduce((sum, m) => sum + m.activeMs, 0);
      const catShare = recent.reduce((sum, m) => sum + m.categorizedShare * m.activeMs, 0) / (activeMs || 1);
      const uncovered = recent.reduce((sum, m) => sum + (m.uncoveredTransitions || 0), 0);
      coverage.appendChild(statRow('Days on record', data.metrics.length));
      coverage.appendChild(statRow('Active time (last 14 days)', fmtMinutes(activeMs)));
      coverage.appendChild(statRow('Categorized share (dwell-weighted)', fmtPct(catShare)));
      const bar = el('div', 'bar');
      const fill = el('span');
      fill.style.width = `${Math.round(catShare * 100)}%`;
      bar.appendChild(fill);
      coverage.appendChild(bar);
      coverage.appendChild(statRow('Transitions touching uncategorized pages', uncovered));
      const contentPages = data.pages.filter(p => p.embeddingVariant === 'content').length;
      const embedded = data.pages.filter(p => p.embeddingVariant).length;
      coverage.appendChild(statRow('Pages embedded from content (vs title only)',
        embedded ? `${fmtPct(contentPages / embedded)} of ${embedded}` : '0'));
      coverage.appendChild(el('div', 'stat-note',
        'Dwell is estimated from history gaps (capped 30 min; session enders get 1 min) and lowered — never raised — by measured active time.'));
    } else {
      coverage.appendChild(el('div', 'stat-note', 'No analyzed days yet.'));
    }

    // ---- registry -----------------------------------------------------
    const registry = byId('registry-content');
    registry.textContent = '';
    const byState = { active: 0, dormant: 0, retired: 0 };
    for (const topic of data.topics) byState[topic.state] = (byState[topic.state] || 0) + 1;
    registry.appendChild(statRow('Active topics', byState.active || 0));
    registry.appendChild(statRow('Dormant topics', byState.dormant || 0));
    registry.appendChild(statRow('Retired topics', byState.retired || 0));
    registry.appendChild(statRow('User-corrected labels', data.topics.filter(t => t.userCorrected).length));
    const nearMisses = data.events.filter(e => e.type === 'created' && e.detail && e.detail.nearMiss);
    registry.appendChild(statRow('Near-miss creations (0.65–0.80)', nearMisses.length));
    const lifecycleCounts = {};
    for (const event of data.events) lifecycleCounts[event.type] = (lifecycleCounts[event.type] || 0) + 1;
    registry.appendChild(el('div', 'stat-note',
      `Lifecycle events: ${Object.entries(lifecycleCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none yet'}.`));

    // ---- uncategorized by reason -------------------------------------
    const uncategorized = byId('uncategorized-content');
    uncategorized.textContent = '';
    const byReason = new Map();
    for (const row of data.uncategorized) {
      const entry = byReason.get(row.reason) || { count: 0, dwellMs: 0 };
      entry.count++;
      entry.dwellMs += row.dwellMs || 0;
      byReason.set(row.reason, entry);
    }
    if (byReason.size) {
      for (const [reason, entry] of [...byReason.entries()].sort((a, b) => b[1].count - a[1].count)) {
        uncategorized.appendChild(statRow(reason.replace(/_/g, ' '), `${entry.count} pages · ${fmtMinutes(entry.dwellMs)}`));
      }
      uncategorized.appendChild(el('div', 'stat-note',
        'These pages are excluded from every topic claim instead of being forced into one.'));
    } else {
      uncategorized.appendChild(el('div', 'stat-note', 'Nothing excluded yet.'));
    }

    // ---- merge proposals ---------------------------------------------
    const proposals = byId('proposals-content');
    proposals.textContent = '';
    const topicById = new Map(data.topics.map(t => [t.topicId, t]));
    const executed = new Set(data.corrections.filter(c => c.kind === 'merge_topics').map(c => c.targetId));
    const pending = data.events.filter(e =>
      e.type === 'merged' && e.detail && e.detail.proposal &&
      !executed.has(`${e.detail.topicA}|${e.detail.topicB}`)
    );
    if (pending.length) {
      for (const event of pending) {
        const a = topicById.get(event.detail.topicA);
        const b = topicById.get(event.detail.topicB);
        if (!a || !b) continue;
        const card = el('div', 'proposal');
        card.appendChild(el('div', null,
          `“${a.label}” and “${b.label}” both matched the same new pages (scores ${event.detail.scoreA.toFixed(2)} / ${event.detail.scoreB.toFixed(2)}). Merge them?`));
        const btn = el('button', 'btn', 'Merge these topics');
        btn.addEventListener('click', () => hooks && hooks.onMergeTopics && hooks.onMergeTopics(event.detail, btn));
        card.appendChild(btn);
        proposals.appendChild(card);
      }
    } else {
      proposals.appendChild(el('div', 'stat-note',
        'None. Topic merges are never automatic — proposals appear here and wait for you.'));
    }

    // ---- run history --------------------------------------------------
    const runsPanel = byId('runs-content');
    runsPanel.textContent = '';
    const runs = data.runs.slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
    if (runs.length) {
      const table = el('table', 'audit-table');
      const head = el('tr');
      for (const h of ['Started', 'Status', 'Stage', 'Duration', 'Visits', 'Embedded', 'Audited', 'Excluded', 'Warnings']) {
        head.appendChild(el('th', null, h));
      }
      table.appendChild(head);
      for (const run of runs) {
        const tr = el('tr');
        tr.appendChild(el('td', null, new Date(run.startedAt).toLocaleString()));
        tr.appendChild(el('td', `status-${run.status}`, run.status));
        tr.appendChild(el('td', null, run.status === 'ok' ? '—' : (run.stage || '—')));
        const durationMs = run.durationMs != null
          ? run.durationMs
          : (run.finishedAt ? run.finishedAt - run.startedAt : null);
        tr.appendChild(el('td', null, durationMs != null ? `${Math.round(durationMs / 1000)}s` : '…'));
        tr.appendChild(el('td', null, run.counts ? run.counts.visitsIngested ?? '' : ''));
        tr.appendChild(el('td', null, run.counts ? `${run.counts.pagesEmbedded ?? 0} (+${run.counts.embeddingsCached ?? 0} cached)` : ''));
        tr.appendChild(el('td', null, run.counts ? run.counts.adjudicated ?? '' : ''));
        tr.appendChild(el('td', null, run.counts ? run.counts.uncategorized ?? '' : ''));
        tr.appendChild(el('td', null, (run.warnings || []).join('; ') || (run.error || '')));
        table.appendChild(tr);
      }
      runsPanel.appendChild(table);
    } else {
      runsPanel.appendChild(el('div', 'stat-note', 'No runs yet. Press "Run now" (needs local Ollama).'));
    }

    // ---- storage & models --------------------------------------------
    const storagePanel = byId('storage-content');
    storagePanel.textContent = '';
    storagePanel.appendChild(statRow('Pages on record', data.pages.length));
    storagePanel.appendChild(statRow('Uncategorized rows', data.uncategorized.length));
    storagePanel.appendChild(statRow('Topics', data.topics.length));
    const models = `${data.settings.embeddingModel || 'bge-m3:latest'} · ${data.settings.chatModel || 'gemma3:12b'}`;
    storagePanel.appendChild(statRow('Models (local Ollama only)', models));
    if (hooks && hooks.storageEstimate) {
      Promise.resolve(hooks.storageEstimate()).then(estimate => {
        if (!estimate) return;
        storagePanel.appendChild(statRow('IndexedDB usage',
          `${Math.round(estimate.usage / 1048576)} MB of ${Math.round(estimate.quota / 1048576)} MB quota`));
        if (estimate.usage / estimate.quota > 0.8) {
          storagePanel.appendChild(el('div', 'stat-note', 'Storage above 80% of quota — the pipeline is warning about this, never silently dropping data.'));
        }
      }).catch(() => {});
    }
    if (hooks && hooks.runningModels) {
      Promise.resolve(hooks.runningModels()).then(list => {
        if (!list) return;
        storagePanel.appendChild(statRow('Resident in Ollama now',
          list.length ? list.map(m => m.name).join(', ') : 'nothing'));
      }).catch(() => {});
    }
  }

  return { loadData, render };
});

// ---- extension-page boot -------------------------------------------------
// The demo page renders these surfaces itself against a recorded store,
// so the live boot path must not also run there.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id &&
    typeof document !== 'undefined' && !globalThis.__CT_DEMO__) {
  document.addEventListener('DOMContentLoaded', async () => {
    const store = CTStore.createStore({});
    await store.open();
    const status = document.getElementById('status');
    const refresh = async () => {
      const data = await CTAudit.loadData(store);
      CTAudit.render(data, document, {
        storageEstimate: () => navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : null,
        runningModels: () => CTOllama.createClient({}).runningModels(),
        onMergeTopics: async (detail, button) => {
          button.disabled = true;
          // A user-confirmed merge: fold topicB into topicA.
          const [a, b] = [await store.get('topics', detail.topicA), await store.get('topics', detail.topicB)];
          if (!a || !b) return;
          const memberships = await store.byIndex('memberships', 'byTopic', detail.topicB);
          const moved = memberships.map(m => ({ ...m, topicId: detail.topicA }));
          await store.registryCommit({
            topics: [
              { ...a, userCorrected: true, totalDwellMs: (a.totalDwellMs || 0) + (b.totalDwellMs || 0) },
              { ...b, state: 'retired' }
            ],
            memberships: moved,
            events: [{
              topicId: detail.topicA, day: CTText.dayKeyFromMs(Date.now()), runId: 'user',
              type: 'merged', detail: { proposal: false, executedBy: 'user', absorbed: detail.topicB }
            }]
          });
          await store.put('corrections', {
            correctionId: `merge:${detail.topicA}|${detail.topicB}`,
            kind: 'merge_topics',
            targetId: `${detail.topicA}|${detail.topicB}`,
            value: detail.topicA,
            pageUrls: [],
            createdAt: Date.now()
          });
          refresh();
        }
      });
      const lastOk = (data.runs || []).filter(r => r.status === 'ok').sort((a, b) => b.startedAt - a.startedAt)[0];
      status.textContent = lastOk
        ? `Last successful run ${new Date(lastOk.startedAt).toLocaleString()}.`
        : 'No successful run yet.';
    };
    await refresh();

    document.getElementById('run-now').addEventListener('click', () => {
      status.textContent = 'Starting a run… (bypasses idle gating, still requires Ollama)';
      chrome.runtime.sendMessage({ type: 'RUN_PIPELINE_MANUAL' }, response => {
        if (chrome.runtime.lastError || !response || response.started === false) {
          status.textContent = `Run not started: ${response ? response.reason : chrome.runtime.lastError.message}. ` +
            (response && response.reason === 'ollama-unavailable'
              ? 'Start Ollama (ollama serve) and pull bge-m3 + gemma3:12b.'
              : '');
          return;
        }
        status.textContent = 'Run in progress — this page refreshes every few seconds.';
        const poll = setInterval(async () => {
          await refresh();
          const runs = await store.getAll('runs');
          const latest = runs.sort((a, b) => b.startedAt - a.startedAt)[0];
          if (latest && latest.status !== 'running') {
            clearInterval(poll);
            status.textContent = latest.status === 'ok'
              ? `Run finished ${new Date().toLocaleTimeString()}.`
              : `Run ${latest.status} at stage ${latest.stage}: ${latest.error || ''}`;
          }
        }, 4000);
      });
    });

    document.getElementById('export-json').addEventListener('click', async () => {
      // Full DB minus extractedText (spec §7.9: exports carry no page text).
      const dump = {};
      for (const name of ['visits', 'pages', 'topics', 'memberships', 'topic_events', 'daily_metrics', 'baselines', 'runs', 'briefs', 'transitions', 'uncategorized', 'corrections', 'settings']) {
        dump[name] = await store.getAll(name);
      }
      dump.captures = (await store.getAll('captures')).map(({ extractedText, ...rest }) => rest);
      dump.topics = dump.topics.map(({ centroid, ...rest }) => rest);
      const blob = new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `cognitive-trails-export-${CTText.dayKeyFromMs(Date.now())}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    document.getElementById('delete-everything').addEventListener('click', async () => {
      if (!confirm('Delete the entire local record? This wipes every topic, metric, capture, and setting.')) return;
      if (!confirm('Really delete everything? There is no undo.')) return;
      status.textContent = 'Stopping capture and analysis, then deleting…';
      // The service worker owns the wipe: it has to stop the pipeline and drop
      // the in-memory capture buffer first, or both write data back moments
      // after the user asked for it to be gone.
      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'DELETE_EVERYTHING' }, reply => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : reply);
        });
      });
      status.textContent = result && result.ok
        ? 'Everything deleted.'
        : `Deletion failed: ${result ? result.error : 'no response'}. Nothing was partially removed.`;
      refresh();
    });
  });
}
