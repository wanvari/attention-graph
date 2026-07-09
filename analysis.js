class TrustAuditDashboard {
  constructor() {
    this.analysis = null;
    this.bindControls();
    const params = new URLSearchParams(window.location.search);
    this.load(params.get('refresh') === '1' || params.get('forceRefresh') === '1');
  }

  bindControls() {
    document.getElementById('refresh-btn').addEventListener('click', () => this.load(true));
  }

  async load(forceRefresh) {
    this.setLoading(true, forceRefresh ? 'Re-running local analysis...' : 'Loading stored analysis...');
    this.setStatus(forceRefresh ? 'Re-running the full local analysis...' : 'Loading stored analysis...');
    this.setHealth('checking', forceRefresh ? 'Analyzing locally' : 'Loading');
    try {
      let analysis;
      if (typeof chrome === 'undefined' || !chrome.history) {
        this.setStatus('Demo mode: Chrome history API is unavailable in this context.');
        analysis = await AttentionAnalysis.createDemoAnalysis();
      } else {
        analysis = await AttentionAnalysis.runAnalysis({
          forceRefresh,
          onProgress: message => this.showProgress(message)
        });
      }
      if (!analysis.ok) {
        this.renderUnavailable(analysis);
        return;
      }
      this.analysis = analysis;
      this.setHealth('ok', analysis.fromCache ? 'Stored analysis' : 'Fresh local analysis');
      this.render(analysis);
      this.setLoading(false);
      const when = analysis.generatedAt ? ` Analyzed ${new Date(analysis.generatedAt).toLocaleString()}.` : '';
      this.setStatus(`${analysis.coverage.visitsExpanded} visits expanded into ${analysis.topics.length} topics.${when}`);
    } catch (error) {
      console.error(error);
      this.renderUnavailable({ message: error.message || String(error), warnings: ['Audit failed before rendering.'] });
    }
  }

  render(analysis) {
    this.renderCoverage(analysis);
    this.renderTopicShare(analysis);
    this.renderSwitchBurden(analysis);
    this.renderFocusedRuns(analysis);
    this.renderRecentPath(analysis);
    this.renderValidationQueue(analysis);
  }

  renderUnavailable(result) {
    this.setLoading(false);
    this.setHealth('bad', 'Ollama unavailable');
    this.setStatus(result.message || 'Local audit is unavailable.');
    const message = `
      <div class="setup-box">
        <div>${escapeHtml(result.message || 'Could not run the local trust audit.')}</div>
        <div>Expected local endpoint: <code>http://localhost:11434</code></div>
        <div>Required models: <code>bge-m3:latest</code> and <code>gemma3:12b-32k</code></div>
      </div>
    `;
    for (const id of ['coverage-content', 'topic-share-content', 'switch-content', 'run-content', 'path-content', 'validation-content']) {
      document.getElementById(id).innerHTML = message;
    }
  }

  renderCoverage(analysis) {
    const c = analysis.coverage;
    const mapped = analysis.categorizedCoverage || {};
    const models = analysis.models || {};
    document.getElementById('coverage-content').innerHTML = `
      <div class="audit-metrics">
        ${metric('Visits read', c.visitsExpanded, 'Individual Chrome visit records expanded from the History API. Repeated visits are separate records.')}
        ${metric('Visits mapped', `${mapped.visitsCategorized || 0} (${formatPercent(mapped.visitCoverage || 0)})`, 'Mapped visits are visits whose page was included in the topic analysis set.')}
        ${metric('Mapped active time', `${mapped.estimatedActiveMinutes || 0}m (${formatPercent(mapped.activeTimeCoverage || 0)})`, 'Estimated active time represented by categorized pages.')}
        ${metric('History sessions', c.sessionCount, 'A new session starts after a gap longer than 30 minutes.')}
        ${metric('Source', analysis.source + (analysis.fromCache ? ' cache' : ''), 'local-ollama means embeddings and labels came from local Ollama. local-test means demo/test fallback data.')}
        ${metric('Models', `${models.embedding || 'n/a'} / ${models.chat || 'n/a'}`, 'Embedding model and chat model used for semantic grouping and labels.')}
      </div>
      <div class="audit-note-grid">
        <p class="audit-note"><strong>Range:</strong> ${formatDate(c.startTime)} to ${formatDate(c.endTime)}</p>
        <p class="audit-note"><strong>Dwell method:</strong> ${escapeHtml(c.dwellMethod)}.</p>
      </div>
      ${analysis.fromCache ? '<p class="audit-note">Loaded from the stored analysis. Use Re-run analysis to compute a fresh one.</p>' : ''}
    `;
  }

  renderTopicShare(analysis) {
    const rows = analysis.metrics.topicTimeShare.slice(0, 12).map(item => {
      const pct = Math.round((item.share || 0) * 100);
      const domains = (item.topDomains || []).slice(0, 3).map(domain => domain.domain).join(', ');
      return `
        <div class="bar-row" title="${escapeAttribute(`${item.label}: ${pct}% of estimated active time, ${item.visitCount} visits, ${Math.round(item.confidence * 100)}% label confidence.`)}">
          <div class="bar-row-label">
            <strong><span class="topic-swatch" style="background:${escapeAttribute(item.color || '#64748b')}"></span>${escapeHtml(item.label)}</strong>
            <span>${pct}% active time · ${item.estimatedDwellMinutes}m · ${item.visitCount} visits</span>
          </div>
          <div class="bar-track"><div style="width:${Math.max(3, pct)}%; background:${escapeAttribute(item.color || '#4285f4')}"></div></div>
          <div class="bar-meta">${escapeHtml(item.bandLabel || 'Topic')} · ${Math.round(item.confidence * 100)}% label confidence${domains ? ` · ${escapeHtml(domains)}` : ''}</div>
        </div>
      `;
    }).join('');
    document.getElementById('topic-share-content').innerHTML = rows || '<p>No topics available.</p>';
  }

  renderSwitchBurden(analysis) {
    const burden = analysis.metrics.switchBurden;
    const mix = analysis.metrics.transitionMix?.items || [];
    const mixRows = mix.map(item => `
      <div class="flow-mix-card" title="${escapeAttribute(item.description)}">
        <span class="flow-mix-dot" style="background:${escapeAttribute(item.color)}"></span>
        <strong>${escapeHtml(item.label)}</strong>
        <b>${item.count}</b>
        <small>${formatPercent(item.share)} of observed transitions</small>
      </div>
    `).join('');
    const contextExamples = burden.representativeTransitions.map(t => `
      <li>
        <strong>${escapeHtml(t.sourceLabel)} -> ${escapeHtml(t.targetLabel)}</strong>
        <span>${t.visitCount} consecutive visits · ${Math.round(t.confidence * 100)}% confidence · ${escapeHtml(t.rationale)}</span>
      </li>
    `).join('');
    const adjacentExamples = (burden.adjacentExamples || []).map(t => `
      <li>
        <strong>${escapeHtml(t.sourceLabel)} -> ${escapeHtml(t.targetLabel)}</strong>
        <span>${t.visitCount} consecutive visits · ${Math.round(t.confidence * 100)}% confidence · ${escapeHtml(t.rationale)}</span>
      </li>
    `).join('');
    document.getElementById('switch-content').innerHTML = `
      <div class="audit-metrics">
        ${metric('Same-topic continuations', burden.sameTopicCount || 0, 'Consecutive visits that stayed inside the same topic cluster.')}
        ${metric('Related continuations', burden.adjacentJumpCount || 0, 'Consecutive visits that moved to a related topic.')}
        ${metric('Context switches', burden.switchCount, 'Consecutive visits that moved to a less-related topic or different task.')}
        ${metric('Switches / active hr', burden.switchesPerActiveHour, 'Context switches divided by estimated active browsing hours.')}
      </div>
      <div class="flow-mix">${mixRows}</div>
      <h3>Largest context-switch routes</h3>
      <ul class="evidence-list">${contextExamples || '<li><strong>No context switches found.</strong><span>Consecutive mapped visits stayed within the same or related topics.</span></li>'}</ul>
      ${adjacentExamples ? `<h3>Related continuation routes</h3><ul class="evidence-list">${adjacentExamples}</ul>` : ''}
    `;
  }

  renderFocusedRuns(analysis) {
    const runs = analysis.metrics.focusedRuns;
    const longest = runs.longestRun;
    const topRuns = runs.topRuns || (longest ? [longest] : []);
    document.getElementById('run-content').innerHTML = `
      <div class="audit-metrics">
        ${metric('Focus runs', runs.runCount, 'A focus run is consecutive mapped visits in the same topic before a topic change or session break.')}
        ${metric('Median run', `${runs.medianEstimatedDwellMinutes}m est.`, 'The middle focus-run duration after sorting all focus runs by estimated dwell time.')}
        ${metric('Longest run', longest ? `${longest.estimatedDwellMinutes}m est.` : 'n/a', 'The single longest same-topic run in the selected history window.')}
        ${metric('Longest topic', longest ? longest.label : 'n/a', 'The topic attached to the longest focus run.')}
      </div>
      <h3>Longest focus runs</h3>
      <div class="run-list">
        ${topRuns.map((run, index) => focusRunCard(run, index + 1)).join('') || '<p>No focus runs available.</p>'}
      </div>
    `;
  }

  renderRecentPath(analysis) {
    const recentRuns = (analysis.metrics.focusedRuns.recentRuns || []).slice().reverse();
    document.getElementById('path-content').innerHTML = recentRuns.length ? `
      <div class="path-list">
        ${recentRuns.map((run, index) => `
          <article class="path-run" title="${escapeAttribute(`${run.label}: ${run.estimatedDwellMinutes} minutes estimated across ${run.visitCount} visits.`)}">
            <div class="path-index">${index + 1}</div>
            <div>
              <h3>${escapeHtml(run.label)}</h3>
              <p>${formatTime(run.startTime)} - ${formatTime(run.endTime)} · ${run.estimatedDwellMinutes}m est. · ${run.visitCount} visits</p>
              <span>${run.pages.slice(0, 2).map(page => escapeHtml(page.title)).join(' / ')}</span>
            </div>
          </article>
        `).join('')}
      </div>
    ` : '<p>No recent mapped topic path available.</p>';
  }

  renderValidationQueue(analysis) {
    const items = analysis.validationQueue;
    if (!items.length) {
      document.getElementById('validation-content').innerHTML = '<p>No low-confidence topics or transitions were flagged.</p>';
      return;
    }
    document.getElementById('validation-content').innerHTML = `
      <div class="validation-list">
        ${items.map(item => this.validationItem(item)).join('')}
      </div>
    `;
    document.querySelectorAll('.validation-form').forEach(form => {
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const kind = data.get('kind').toString();
        const targetId = data.get('targetId').toString();
        const value = data.get('value').toString().trim();
        if (!value) return;
        await AttentionAnalysis.TrustStore.saveCorrection({
          kind,
          targetId,
          label: kind === 'topic' ? value : undefined,
          type: kind === 'transition' ? value : undefined
        });
        const corrections = await AttentionAnalysis.TrustStore.getCorrections();
        AttentionAnalysis.applyCorrections(this.analysis, corrections);
        this.analysis.validationQueue = this.analysis.validationQueue.filter(entry =>
          !(entry.kind === kind && entry.targetId === targetId)
        );
        this.render(this.analysis);
      });
    });
  }

  validationItem(item) {
    const control = item.kind === 'topic'
      ? `<input name="value" value="${escapeAttribute(item.title)}" />`
      : `<select name="value">
          ${Object.keys(AttentionAnalysis.TRANSITION_TYPES).map(type => `<option value="${type}">${AttentionAnalysis.TRANSITION_TYPES[type].label}</option>`).join('')}
        </select>`;
    return `
      <article class="validation-card">
        <div>
          <div class="panel-kicker">${escapeHtml(item.kind)}</div>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.reason)} · ${Math.round(item.confidence * 100)}% confidence</p>
          ${validationEvidence(item)}
        </div>
        <form class="validation-form">
          <input type="hidden" name="kind" value="${escapeAttribute(item.kind)}" />
          <input type="hidden" name="targetId" value="${escapeAttribute(item.targetId)}" />
          ${control}
          <button type="submit">Save correction</button>
        </form>
      </article>
    `;
  }

  setLoading(visible, message) {
    const loading = document.getElementById('loading');
    loading.style.display = visible ? 'block' : 'none';
    if (message) loading.textContent = message;
  }

  showProgress(message) {
    this.setLoading(true, message);
    this.setStatus(message);
    if (/ollama/i.test(message)) this.setHealth('checking', 'Checking Ollama');
    else if (/embedding|labeling|auditing|analyzing/i.test(message)) this.setHealth('checking', 'Analyzing locally');
    else if (/history|visits/i.test(message)) this.setHealth('checking', 'Reading history');
  }

  setStatus(message) {
    document.getElementById('status').textContent = message;
    document.title = `Cognitive Trails Audit - ${String(message || '').slice(0, 70)}`;
  }

  setHealth(state, label) {
    const pill = document.getElementById('health-pill');
    pill.textContent = label;
    pill.className = `health-pill ${state}`;
  }
}

function validationEvidence(item) {
  const evidence = item.evidence || [];
  if (!evidence.length) return '';
  if (item.kind === 'topic') {
    return `
      <ul class="evidence-list compact validation-evidence">
        ${evidence.slice(0, 3).map(page => `
          <li>
            <strong>${escapeHtml(page.title)}</strong>
            <span>${escapeHtml(page.domain)} · ${page.visitCount || 0} visits</span>
          </li>
        `).join('')}
      </ul>
    `;
  }
  return `
    <ul class="evidence-list compact validation-evidence">
      ${evidence.slice(0, 3).map(item => `
        <li>
          <strong>${escapeHtml(item.from?.title || 'Previous visit')}</strong>
          <span>to ${escapeHtml(item.to?.title || 'Next visit')} · ${item.estimatedGapMinutes || 0}m gap</span>
        </li>
      `).join('')}
    </ul>
  `;
}

function metric(label, value, help) {
  return `
    <div title="${escapeAttribute(help || label)}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
    </div>
  `;
}

function focusRunCard(run, rank) {
  const pages = (run.pages || []).slice(0, 3).map(page => `
    <li>
      <strong>${escapeHtml(page.title)}</strong>
      <span>${escapeHtml(page.domain)}</span>
    </li>
  `).join('');
  return `
    <article class="run-card" title="${escapeAttribute(`${run.label}: ${run.estimatedDwellMinutes} minutes estimated across ${run.visitCount} visits.`)}">
      <div class="run-rank">${rank}</div>
      <div class="run-card-body">
        <h3>${escapeHtml(run.label)}</h3>
        <p>${formatDate(run.startTime)} - ${formatDate(run.endTime)} · ${run.estimatedDwellMinutes}m est. · ${run.visitCount} visits</p>
        <ul class="evidence-list compact">${pages}</ul>
      </div>
    </article>
  `;
}

function formatDate(ms) {
  if (!ms) return 'n/a';
  return new Date(ms).toLocaleString();
}

function formatTime(ms) {
  if (!ms) return 'n/a';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatPercent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

document.addEventListener('DOMContentLoaded', () => {
  new TrustAuditDashboard();
});
