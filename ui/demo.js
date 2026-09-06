// The real surfaces, driven by a committed synthetic record. No model calls,
// browser history access, or persistent writes are made by the sample.
(function() {
  'use strict';
  function memoryStore(snapshot) {
    const stats = { transactions: 0 };
    return {
      stats, resetStats() { stats.transactions = 0; }, async open() {},
      async getAll(name) { stats.transactions++; return snapshot[name] || []; },
      async readSnapshot(names) { stats.transactions++; return Object.fromEntries(names.map(name => [name, snapshot[name] || []])); },
      async getSettingsMap() { return { embeddingModel: 'bge-m3:latest', chatModel: 'qwen3:4b', ...Object.fromEntries((snapshot.settings || []).map(r => [r.key, r.value])) }; }
    };
  }
  // Render report text without interpreting HTML from its source.
  function renderReport(text, target) {
    target.textContent = '';
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const heading = line.match(/^(#{1,3}) (.*)/);
      const node = document.createElement(heading ? `h${heading[1].length + 1}` : 'p');
      node.textContent = heading ? heading[2] : line;
      target.appendChild(node);
    }
  }
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const response = await fetch('../fixtures/current/snapshot.json');
      if (!response.ok) throw new Error('Recorded sample is unavailable.');
      const snapshot = await response.json();
      const store = memoryStore(snapshot);
      const days = (snapshot.daily_metrics || []).map(r => r.day).sort();
      const now = CTText.dayKeyToNoonMs(days.at(-1)) + 9 * 3600000;
      document.getElementById('demo-sub').textContent = 'Synthetic history · real local model output · read-only';
      await CTNewtab.main({ store, container: document.getElementById('app'), now, readOnly: true,
        trailId: new URLSearchParams(location.search).get('trail'),
        links: { home: 'demo.html', map: 'map.html?demo=1', audit: 'demo.html?view=audit', settings: 'demo.html?view=setup', demo: 'demo.html' } });
      CTAudit.render(await CTAudit.loadData(store), document, {});
      try {
        const index = await fetch('../validation/index.json').then(r => r.json());
        const report = await fetch(`../validation/${index.latest}`).then(r => r.text());
        renderReport(report, document.getElementById('validation-content'));
      } catch { document.getElementById('validation-content').textContent = 'Validation report is unavailable.'; }
      const views = ['home', 'audit', 'setup', 'validation'];
      for (const tab of document.querySelectorAll('.demo-tab')) {
        tab.addEventListener('click', () => {
          for (const other of document.querySelectorAll('.demo-tab')) other.classList.toggle('active', other === tab);
          for (const view of views) document.getElementById(`view-${view}`).hidden = view !== tab.dataset.view;
        });
      }
      const view = new URLSearchParams(location.search).get('view');
      if (views.includes(view)) document.querySelector(`[data-view="${view}"]`).click();
    } catch (error) { document.getElementById('demo-sub').textContent = `Sample could not be opened: ${error.message}`; }
  });
})();
