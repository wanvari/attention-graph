/* global CTDiagnostics */
'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const query = document.getElementById('query'), status = document.getElementById('diagnostic-status'), results = document.getElementById('diagnostic-results');
  async function inspect() {
    status.textContent = 'Reading local evidence…'; results.textContent = '';
    try {
      const snapshot = await CTDiagnostics.loadExisting();
      const rows = CTDiagnostics.inspect(snapshot, query.value);
      status.textContent = `${rows.length} matching pages (up to 50). Stored values can be stale; current estimates cannot recover missing historical measurements.`;
      for (const row of rows) {
        const card = document.createElement('section'); card.className = 'panel';
        const title = document.createElement('h2'); title.textContent = row.title;
        const data = document.createElement('pre'); data.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; data.textContent = JSON.stringify(row, null, 2);
        card.append(title, data); results.append(card);
      }
    } catch (error) { status.textContent = error.message; }
  }
  document.getElementById('diagnostic-form').addEventListener('submit', event => { event.preventDefault(); inspect(); });
  query.value = new URLSearchParams(location.search).get('q') || '';
  if (query.value) inspect();
});
