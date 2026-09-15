// Home and Your trails. Both render one projected snapshot and never schedule
// inference; personal metadata and sessions are saved through worker messages.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports
    ? factory(require('../lib/text.js'), require('../lib/trails.js'), require('./dashboard.js'), require('./studio.js'), require('./explore.js'))
    : factory(root.CTText, root.CTTrails, root.CTDailyView, root.CTStudio, root.CTExplore);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTNewtab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText, CTTrails, CTDailyView, CTStudio, CTExplore) {
  'use strict';
  const number = value => Number(value || 0).toLocaleString();
  const count = (value, noun) => `${number(value)} ${noun}${value === 1 ? '' : 's'}`;
  const duration = CTDailyView.duration;
  const clock = at => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const date = (at, full) => new Date(at).toLocaleDateString(undefined, { month: full ? 'long' : 'short', day: 'numeric', year: full ? 'numeric' : undefined });
  const SORTS = [['recent', 'Most recent'], ['time', 'Most time'], ['days', 'Most days returned'], ['name', 'A–Z']];
  const FILTERS = [['pinned', 'Pinned'], ['note', 'Has a note'], ['week', 'This week']];
  const dayStart = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
  function relativeDay(day, today) {
    const diff = Math.round((dayStart(today) - dayStart(day)) / 86400000);
    if (diff <= 0) return 'today';
    if (diff === 1) return 'yesterday';
    if (diff < 7) return `${diff} days ago`;
    return dayStart(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function render(container, snapshot, options) {
    const opts = options || {};
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    const studioPage = opts.view || (new URLSearchParams(win.location.search).get('view') === 'trails' ? 'trails' : 'home');
    const home = studioPage === 'home';
    let now = opts.now || Date.now();
    let today = CTText.dayKeyFromMs(now);
    let data = { ...snapshot };
    let record = CTTrails.buildRecord(data, { now });
    let selectedId = null;
    let mode = 'recent';
    let query = '', from = '', to = '', ungrouped = false;
    let limit = 20, episodeLimit = 8, sort = 'recent';
    const filters = { pinned: false, note: false, week: false };
    let paused = !!record.settings.capturePaused;
    let disposed = false;
    let dailyView, sheet = null, sheetOpener = null;
    const links = { home: 'newtab.html', map: 'map.html', audit: 'audit.html', settings: 'options.html', demo: 'demo.html', ...(opts.links || {}) };
    const withParam = (href, param) => `${href}${href.includes('?') ? '&' : '?'}${param}`;
    const el = (tag, cls, text) => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const link = (label, href, cls) => {
      const a = el('a', cls, label); a.href = href; return a;
    };
    const button = (label, cls, action) => {
      const node = el('button', cls, label); node.type = 'button';
      if (action) node.addEventListener('click', action);
      return node;
    };
    const pageLink = event => {
      const a = link(event.title, event.url, 'nt-page-link');
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      return a;
    };
    const announce = text => { live.textContent = text; };
    container.textContent = '';
    const shell = el('div', `nt-page nt-${studioPage}`);
    container.appendChild(shell);
    shell.appendChild(link('Skip to search', '#record-search', 'nt-skip'));
    const hero = el('header', 'nt-hero');
    const headline = el('h1', home ? 'nt-greeting' : null, home ? 'Welcome back.' : 'Your trails');
    const subline = el('p', home ? 'nt-dateline' : 'page-sub');
    const heading = el('div', 'nt-hero-heading'); heading.append(headline, subline); hero.append(heading);
    const searchForm = el('form', 'nt-search'); searchForm.setAttribute('role', 'search');
    const input = el('input', 'nt-search-input'); input.type = 'search'; input.name = 'q';
    input.id = 'record-search'; input.autofocus = home;
    input.placeholder = home ? 'Search your trails and pages' : 'Search trails, pages, websites and notes'; input.autocomplete = 'off';
    input.setAttribute('aria-keyshortcuts', '/'); input.setAttribute('aria-label', 'Search your browsing record'); input.setAttribute('aria-controls', 'record-content');
    const submit = el('button', 'nt-search-submit'); submit.type = 'submit'; submit.setAttribute('aria-label', 'Search'); submit.title = 'Search your browsing record'; submit.append(CTStudio.icon(doc, 'enter'));
    searchForm.append(CTStudio.icon(doc, 'search'), input, submit);
    searchForm.addEventListener('submit', event => { event.preventDefault(); runSearch(); });
    input.addEventListener('input', () => { searchTools.hidden = home && !input.value && filterPanel.hidden && mode === 'recent'; if (!input.value) runSearch(); });
    hero.appendChild(searchForm);
    const searchTools = el('div', 'nt-search-tools');
    searchTools.hidden = home;
    const filterToggle = button('Filter by date', 'nt-text-button', () => {
      filterPanel.hidden = !filterPanel.hidden;
      filterToggle.setAttribute('aria-expanded', String(!filterPanel.hidden));
    });
    filterToggle.setAttribute('aria-controls', 'record-filters'); filterToggle.setAttribute('aria-expanded', 'false');
    searchTools.appendChild(filterToggle);
    if (opts.onSearch) {
      const web = button('Search the web ↗', 'nt-text-button', async () => {
        const q = input.value.trim();
        if (!q) { announce('Enter a query to search the web.'); input.focus(); return; }
        try { await opts.onSearch(q); } catch { announce('Web search is unavailable. Use the browser address bar.'); }
      });
      web.title = 'Send the typed query to your default web search engine';
      searchTools.appendChild(web);
    } else searchTools.appendChild(el('span', 'nt-search-hint', 'Search stays on this device'));
    hero.appendChild(searchTools);
    const filterPanel = el('div', 'nt-filters'); filterPanel.id = 'record-filters'; filterPanel.hidden = true;
    function dateFilter(label, name) {
      const wrap = el('label', 'nt-field', label);
      const field = el('input'); field.type = 'date'; field.name = name; field.max = today;
      field.addEventListener('change', runSearch); wrap.appendChild(field); filterPanel.appendChild(wrap); return field;
    }
    const fromInput = dateFilter('From', 'from');
    const toInput = dateFilter('Through', 'through');
    const ungroupedLabel = el('label', 'nt-checkbox');
    const ungroupedInput = el('input'); ungroupedInput.type = 'checkbox';
    ungroupedInput.addEventListener('change', runSearch);
    ungroupedLabel.append(ungroupedInput, doc.createTextNode('Pages without a trail'));
    filterPanel.appendChild(ungroupedLabel);
    filterPanel.appendChild(button('Reset filters', 'nt-text-button', () => {
      fromInput.value = ''; toInput.value = ''; ungroupedInput.checked = false; runSearch();
    }));
    hero.appendChild(filterPanel);
    const live = el('p', 'nt-live'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    const dashboardHost = el('div', 'nt-daily-host');
    const layout = el('div', 'nt-layout');
    const content = el('section', 'nt-content'); content.id = 'record-content'; content.tabIndex = -1;
    layout.append(content);
    const band = el('section', 'nt-record-band'); band.setAttribute('aria-label', 'About this record');
    shell.append(hero, live, dashboardHost, layout, band);

    function resetSearch() {
      input.value = ''; query = ''; fromInput.value = ''; toInput.value = '';
      from = ''; to = ''; ungrouped = false; ungroupedInput.checked = false; limit = 20;
    }
    function runSearch() {
      query = input.value.trim(); from = fromInput.value; to = toInput.value; ungrouped = ungroupedInput.checked;
      if (from && to && from > to) { announce('Choose an end date on or after the start date.'); return; }
      limit = 20; mode = query || from || to || ungrouped ? 'search' : 'recent';
      drawContent();
    }
    function redraw() {
      dailyView.update(record); drawHeader(); drawContent(); drawBand();
      if (sheet) drawSheet();
    }
    async function saveMetadata(trail, value, target) {
      if (opts.readOnly || !opts.onSaveMetadata) return;
      if (target) target.disabled = true;
      try {
        const correction = CTTrails.makeCorrection(trail.id, value, Date.now(),
          (data.corrections || []).find(row => row.correctionId === `trail:${trail.id}`));
        await opts.onSaveMetadata(correction);
        data.corrections = (data.corrections || []).filter(row => row.correctionId !== correction.correctionId).concat(correction);
        record = CTTrails.buildRecord(data, { now });
        redraw(); announce('Saved on this device.');
      } catch {
        if (target) target.disabled = false;
        announce('Could not save this change. Your existing record is unchanged.');
      }
    }
    function pinControl(trail) {
      const pinned = trail.personal.pinned;
      const pin = button(pinned ? 'Pinned' : 'Pin', 'nt-pin', () => saveMetadata(trail, { ...trail.personal, pinned: !pinned }, pin));
      pin.setAttribute('aria-pressed', String(pinned));
      pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${trail.label}`);
      if (opts.readOnly || !opts.onSaveMetadata) { pin.disabled = true; pin.title = 'Pinning is available in your own record.'; }
      return pin;
    }
    // One bar per local day; height is that day's visit count, relative to
    // the busiest day shown. Empty days keep a baseline so gaps stay legible.
    function visitStrip(trail, days) {
      const first = CTText.addDays(today, -(days - 1)), counts = new Map();
      for (const event of trail.events) if (event.day >= first && event.day <= today) counts.set(event.day, (counts.get(event.day) || 0) + 1);
      const max = Math.max(1, ...counts.values());
      const strip = el('span', 'nt-strip');
      for (let offset = days - 1; offset >= 0; offset--) {
        const visits = counts.get(CTText.addDays(today, -offset)) || 0;
        const bar = el('i', visits ? null : 'is-empty');
        if (visits) bar.style.height = `${Math.round(30 + 70 * visits / max)}%`;
        strip.append(bar);
      }
      const label = `Visited on ${counts.size} of the last ${days} days`;
      strip.setAttribute('role', 'img'); strip.setAttribute('aria-label', label); strip.title = label;
      return strip;
    }
    function drawHeader() {
      subline.textContent = '';
      if (!home) {
        subline.textContent = record.events.length ? `${count(record.trails.length, 'trail')} · ${count(record.pageCount, 'page')} recorded` : 'Your recorded pages and suggested trails appear here.';
        return;
      }
      headline.textContent = record.events.length ? 'Welcome back.' : 'Welcome.';
      subline.append(doc.createTextNode(new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })));
      const signals = dailyView?.signals;
      if (signals && (signals.totalMs > 0 || signals.events.length)) {
        subline.append(doc.createTextNode(' · '), button(`${duration(signals.totalMs)} estimated today`, 'nt-text-button nt-dateline-time', () => dailyView.openMetric('time')));
      }
    }
    function drawContent() {
      content.textContent = '';
      const resting = home && mode === 'recent';
      shell.dataset.homeResting = String(resting);
      layout.hidden = resting;
      searchTools.hidden = resting && !input.value && filterPanel.hidden;
      // Keep dialogs mounted even while the rest of Home is out of view.
      dashboardHost.classList.toggle('nt-daily-concealed', home && !resting);
      live.textContent = '';
      if (resting) return;
      if (mode !== 'recent') { drawResults(); return; }
      if (!record.events.length) { drawEmpty(); return; }
      drawTrailList();
    }
    function drawResults() {
      const top = el('div', 'nt-section-heading');
      top.append(el('h2', null, mode === 'search' ? 'Search results' : mode === 'ungrouped' ? 'Pages without a trail' : 'All pages'),
        button(home ? 'Clear search' : '← Your trails', 'nt-text-button', () => { resetSearch(); mode = 'recent'; drawContent(); if (home) input.focus(); }));
      content.appendChild(top);
      const results = CTTrails.search(record, { query, from, to, ungrouped: ungrouped || mode === 'ungrouped' });
      content.appendChild(el('p', 'nt-results-count', `${count(results.length, 'recorded visit')}${query ? ` matching “${query}”` : ''}`));
      announce(`${count(results.length, 'recorded visit')} found.`);
      if (!results.length) {
        const empty = el('div', 'nt-empty compact');
        empty.append(el('h3', null, 'No pages matched this search.'), el('p', null, 'Try a page title, a website, or a wider date range. Pages do not need a topic to appear here.'));
        content.appendChild(empty);
      } else drawVisitList(results, content, true, true);
    }
    function drawTrailList() {
      const toolbar = el('div', 'nt-toolbar');
      const chips = el('div', 'nt-filter-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Filter trails');
      for (const [key, label] of FILTERS) {
        const chip = button(label, 'chip', () => { filters[key] = !filters[key]; limit = 20; drawContent(); });
        chip.setAttribute('aria-pressed', String(filters[key])); chips.append(chip);
      }
      const sortField = el('label', 'nt-sort');
      const select = el('select'); select.setAttribute('aria-label', 'Sort trails');
      for (const [value, label] of SORTS) { const option = el('option', null, label); option.value = value; select.append(option); }
      select.value = sort; select.addEventListener('change', () => { sort = select.value; limit = 20; drawContent(); });
      sortField.append(el('span', null, 'Sort'), select);
      const pageModes = el('div', 'nt-page-modes');
      pageModes.append(button('All pages', 'nt-text-button', () => { resetSearch(); mode = 'pages'; drawContent(); content.focus(); }),
        button('Pages without a trail', 'nt-text-button', () => { resetSearch(); mode = 'ungrouped'; drawContent(); content.focus(); }));
      toolbar.append(chips, sortField, pageModes);
      content.appendChild(toolbar);
      if (!record.trails.length) {
        const empty = el('div', 'nt-empty compact');
        empty.append(el('h3', null, 'Your pages are already here.'), el('p', null, 'Topic grouping happens locally when analysis is available. You can search and reopen your pages now.'));
        empty.appendChild(link('Set up local grouping →', links.settings, 'nt-text-link')); content.appendChild(empty);
        return;
      }
      const weekStart = CTText.addDays(today, -6);
      const lastDay = trail => CTText.dayKeyFromMs(trail.lastAt);
      const sorters = { recent: (a, b) => b.lastAt - a.lastAt, time: (a, b) => b.estimatedMs - a.estimatedMs, days: (a, b) => b.dayCount - a.dayCount, name: () => 0 };
      const trails = record.trails
        .filter(t => (!filters.pinned || t.personal.pinned) && (!filters.note || t.personal.note) && (!filters.week || lastDay(t) >= weekStart))
        .sort((a, b) => sorters[sort](a, b) || a.label.localeCompare(b.label));
      if (!trails.length) {
        const noPins = filters.pinned && !record.trails.some(t => t.personal.pinned);
        const empty = el('div', 'nt-empty compact');
        empty.append(el('h3', null, noPins ? 'Keep a trail within reach.' : 'No trails match these filters.'),
          el('p', null, noPins ? 'Pin a trail to keep it here. Everything else is recorded passively.' : 'Clear a filter to see more of your record.'));
        content.appendChild(empty);
        return;
      }
      let shown = 0;
      const section = (title, rows) => {
        if (!rows.length || shown >= limit) return;
        const group = el('section', 'nt-trail-group');
        const head = el('div', 'nt-group-heading'); head.append(el('h2', null, title), el('span', null, count(rows.length, 'trail')));
        const list = el('ol', 'nt-trail-list');
        for (const trail of rows.slice(0, limit - shown)) list.append(trailRow(trail));
        shown += Math.min(rows.length, limit - shown);
        group.append(head, list); content.append(group);
      };
      if (sort === 'recent') {
        const rest = trails.filter(t => !t.personal.pinned);
        section('Pinned', trails.filter(t => t.personal.pinned));
        section('Today', rest.filter(t => lastDay(t) === today));
        section('This week', rest.filter(t => lastDay(t) !== today && lastDay(t) >= weekStart));
        section('Earlier', rest.filter(t => lastDay(t) < weekStart));
      } else section(SORTS.find(([value]) => value === sort)[1], trails);
      if (trails.length > shown) content.append(button(`Show more trails (${number(trails.length - shown)} remaining)`, 'nt-secondary-button nt-load-more', () => { limit += 30; drawContent(); }));
    }
    function trailRow(trail) {
      const row = el('li', 'nt-trail-row');
      row.style.setProperty('--trail-color', CTStudio.topicColor(trail.id));
      const swatch = el('span', 'nt-swatch'); swatch.setAttribute('aria-hidden', 'true');
      const main = el('div', 'nt-trail-main');
      const title = button(trail.label, 'nt-trail-title', () => openTrail(trail.id));
      title.setAttribute('aria-haspopup', 'dialog');
      const titleWrap = el('h3', 'nt-trail-heading'); titleWrap.append(title); main.append(titleWrap);
      if (trail.personal.name && trail.personal.name !== trail.suggestedLabel) main.append(el('p', 'nt-trail-suggested', `Suggested topic: ${trail.suggestedLabel}`));
      main.append(el('p', 'nt-trail-meta', `${count(trail.pageCount, 'page')} · ${count(trail.sourceCount, 'website')} · last visited ${relativeDay(CTText.dayKeyFromMs(trail.lastAt), today)}`));
      if (trail.personal.note) main.append(el('p', 'nt-card-note', trail.personal.note));
      const time = el('p', 'nt-trail-time'); time.append(el('strong', null, duration(trail.estimatedMs)), el('span', null, 'estimated'));
      time.title = 'Estimated time across every recorded date for this trail';
      row.append(swatch, main, visitStrip(trail, 14), time, pinControl(trail));
      return row;
    }
    function drawEmpty() {
      const empty = el('div', 'nt-empty');
      empty.append(el('h3', null, 'The next page is a place to begin.'),
        el('p', null, 'Browse normally. Eligible pages appear here as they are recorded, ready to search and reopen. No bookmarking required.'),
        el('p', 'nt-empty-note', 'Local models can organize pages into topics later. Search works before they are installed.'));
      const actions = el('div', 'nt-empty-actions');
      actions.append(link('Explore the sample record', links.demo, 'nt-primary-link'), link('Capture & setup', links.settings, 'nt-secondary-link'));
      empty.appendChild(actions); content.appendChild(empty);
    }
    function drawChips(parent, excludeId) {
      if (!record.events.length) {
        const card = el('section', 'nt-welcome');
        card.append(el('h2', null, 'Your record begins with the next page you open.'),
          el('p', null, 'Browse as usual. Eligible pages become searchable here right away, and local models can group them into trails later.'));
        const actions = el('div', 'nt-empty-actions');
        actions.append(link('Explore the sample record', links.demo, 'nt-primary-link'), link('Capture & setup', links.settings, 'nt-secondary-link'));
        card.append(actions); parent.append(card);
        return;
      }
      const block = el('section', 'nt-chips-block'); block.setAttribute('aria-labelledby', 'nt-chips-title');
      const head = el('div', 'nt-block-head'), title = el('h2', null, 'Recent trails'); title.id = 'nt-chips-title';
      head.append(title, link('All trails →', withParam(links.home, 'view=trails'), 'nt-text-link'));
      const list = el('div', 'nt-chip-row');
      const trails = record.trails.filter(t => t.id !== excludeId)
        .sort((a, b) => Number(b.personal.pinned) - Number(a.personal.pinned) || b.lastAt - a.lastAt).slice(0, 4);
      for (const trail of trails) {
        const chip = button('', 'nt-trail-chip', () => openTrail(trail.id));
        chip.style.setProperty('--trail-color', CTStudio.topicColor(trail.id));
        chip.setAttribute('aria-haspopup', 'dialog');
        const text = el('span', 'nt-chip-text');
        text.append(el('span', 'nt-chip-label', trail.label), el('span', 'nt-chip-meta', `${trail.personal.pinned ? 'Pinned · ' : ''}${relativeDay(CTText.dayKeyFromMs(trail.lastAt), today)}`));
        chip.append(visitStrip(trail, 7), text); list.append(chip);
      }
      if (!trails.length) {
        title.textContent = 'Recent pages';
        for (const event of record.events.slice(-3).reverse()) { const a = pageLink(event); a.className = 'nt-page-chip'; list.append(a); }
      }
      block.append(head, list); parent.append(block);
    }
    function openTrail(id) {
      selectedId = id; episodeLimit = 8; drawSheet();
      if (opts.onOpenTrail) opts.onOpenTrail(id);
    }
    function closeSheet() {
      if (!sheet) return;
      sheet.remove(); sheet = null; selectedId = null;
      if (sheetOpener?.isConnected) sheetOpener.focus();
    }
    function drawSheet() {
      const trail = record.trails.find(t => t.id === selectedId);
      if (!trail) { closeSheet(); return; }
      const fresh = !sheet;
      if (fresh) {
        sheetOpener = doc.activeElement;
        sheet = el('dialog', 'nt-sheet'); sheet.setAttribute('aria-labelledby', 'nt-sheet-title');
        sheet.addEventListener('cancel', event => { event.preventDefault(); closeSheet(); });
        // The dialog box itself has no padding, so a click on it is a click on the backdrop.
        sheet.addEventListener('click', event => { if (event.target === sheet) closeSheet(); });
        shell.appendChild(sheet);
      }
      const scroll = sheet.scrollTop;
      sheet.textContent = '';
      const body = el('div', 'nt-sheet-body'); sheet.append(body);
      drawTrail(trail, body);
      if (fresh) {
        if (sheet.showModal) sheet.showModal(); else sheet.setAttribute('open', '');
        sheet.querySelector('.nt-sheet-close')?.focus();
      } else sheet.scrollTop = scroll;
    }
    function drawTrail(trail, target) {
      target.style.setProperty('--trail-color', CTStudio.topicColor(trail.id));
      const top = el('div', 'nt-sheet-top');
      top.append(el('span', 'kicker', trail.personal.name ? 'Your trail' : 'Suggested trail'), button('Close', 'nt-secondary-button nt-sheet-close', closeSheet));
      const heading = el('div', 'nt-detail-heading'), title = el('h2', null, trail.label); title.id = 'nt-sheet-title';
      heading.append(title, pinControl(trail));
      target.append(top, heading);
      target.append(el('p', 'nt-suggested-label', trail.personal.name ? `Suggested topic: ${trail.suggestedLabel}` : 'Suggested topic · Page groupings can be imperfect.'));
      const stats = el('dl', 'nt-sheet-stats');
      for (const [value, label] of [[number(trail.pageCount), 'pages'], [number(trail.sourceCount), 'websites'], [number(trail.returnDays), 'later days returned'], [duration(trail.estimatedMs), 'estimated time']]) {
        const pair = el('div'); pair.append(el('dd', null, value), el('dt', null, label)); stats.append(pair);
      }
      target.append(stats);
      const rhythm = el('div', 'nt-sheet-rhythm');
      rhythm.append(visitStrip(trail, 28), el('p', 'nt-detail-description', `Recorded ${date(trail.firstAt, true)} – ${date(trail.lastAt, true)}. ${count(trail.visitCount, 'visit')} across ${count(trail.dayCount, 'day')}.`));
      target.append(rhythm);
      if (trail.personal.note) {
        const note = el('div', 'nt-personal-note'); note.append(el('span', 'kicker', 'Your note'), el('p', null, trail.personal.note)); target.append(note);
      }
      const actions = el('div', 'nt-sheet-actions');
      const last = trail.events.at(-1);
      if (last) { const a = pageLink(last); a.textContent = 'Open last page ↗'; a.className = 'nt-primary-link'; actions.append(a); }
      actions.append(button('Start session', 'nt-secondary-button', () => dailyView.startSession(trail)),
        link('See it in the graph', withParam(links.map, `trail=${encodeURIComponent(trail.id)}`), 'nt-text-link'));
      target.append(actions);
      const edit = el('details', 'nt-edit'); edit.appendChild(el('summary', null, trail.personal.note || trail.personal.name ? 'Edit your name or note' : 'Add a note or name this trail'));
      if (opts.readOnly || !opts.onSaveMetadata) edit.appendChild(el('p', null, 'This is a sample record. Names, notes, and pins are available in your own record.'));
      else {
        const form = el('form', 'nt-edit-form');
        const nameLabel = el('label', 'nt-field', 'Your trail name');
        const name = el('input'); name.type = 'text'; name.maxLength = 120; name.value = trail.personal.name; name.placeholder = trail.suggestedLabel;
        nameLabel.appendChild(name);
        const noteLabel = el('label', 'nt-field', 'Your note');
        const note = el('textarea'); note.rows = 3; note.maxLength = 1000; note.value = trail.personal.note; note.placeholder = 'A question, a reminder, or where to continue…';
        noteLabel.appendChild(note);
        const save = el('button', 'nt-primary-button', 'Save on this device'); save.type = 'submit';
        form.append(nameLabel, noteLabel, el('p', 'nt-help', 'Optional. Your words stay separate from the suggested topic.'), save);
        form.addEventListener('submit', event => { event.preventDefault(); saveMetadata(trail, { ...trail.personal, name: name.value, note: note.value }, save); });
        edit.appendChild(form);
      }
      target.appendChild(edit);
      const episodesHeading = el('div', 'nt-section-heading nt-episodes-heading');
      episodesHeading.appendChild(el('h3', null, 'Pages along this trail'));
      target.append(episodesHeading, el('p', 'nt-help', 'In visit order. A new section starts after 30 minutes away from this trail or on a new day.'));
      const sessions = trail.episodes.slice().reverse();
      for (const session of sessions.slice(0, episodeLimit)) {
        const block = el('section', 'nt-episode');
        const header = el('div', 'nt-episode-heading');
        header.append(el('h4', null, date(session.firstAt, true)), el('span', null, `${clock(session.firstAt)}${session.events.length > 1 ? ` – ${clock(session.lastAt)}` : ''} · ${count(session.events.length, 'visit')}`));
        block.appendChild(header); drawVisitList(session.events, block, false, false); target.appendChild(block);
      }
      if (sessions.length > episodeLimit) target.appendChild(button('Show earlier episodes', 'nt-secondary-button nt-load-more', () => { episodeLimit += 20; drawSheet(); }));
    }
    function drawVisitList(events, target, paginate, showTrail) {
      const list = el('ol', 'nt-visit-list');
      for (const event of events.slice(0, paginate ? limit : events.length)) {
        const row = el('li', 'nt-visit');
        const trail = event.topicIds.length ? record.trails.find(t => t.id === event.topicIds[0]) : null;
        const dot = el('span', 'nt-visit-dot'); dot.setAttribute('aria-hidden', 'true');
        if (trail) dot.style.setProperty('--trail-color', CTStudio.topicColor(trail.id));
        row.appendChild(dot);
        const body = el('div', 'nt-visit-body'); body.appendChild(pageLink(event));
        const meta = el('div', 'nt-visit-meta');
        const when = el('time', null, `${date(event.time)} · ${clock(event.time)}`); when.dateTime = new Date(event.time).toISOString();
        meta.append(el('span', 'nt-domain', event.domain), when);
        if (!event.topicIds.length) meta.appendChild(el('span', 'nt-ungrouped', 'No topic yet'));
        if (event.pending) meta.appendChild(el('span', 'nt-ungrouped', 'Recent capture'));
        meta.appendChild(el('span', 'nt-visit-time', event.timingMethod.endsWith('unknown') ? 'Duration unknown · this visit' : `${duration(event.dwellMs)} estimated · this visit`));
        body.appendChild(meta);
        body.appendChild(button('Inspect page & grouping', 'nt-text-button nt-inspect-page', () => dailyView.openPage(event)));
        row.appendChild(body);
        if (showTrail && trail) {
          const go = button(trail.label, 'nt-visit-trail', () => openTrail(trail.id));
          go.style.setProperty('--trail-color', CTStudio.topicColor(trail.id));
          go.setAttribute('aria-label', `Open trail: ${trail.label}`); row.appendChild(go);
        }
        list.appendChild(row);
      }
      target.appendChild(list);
      if (paginate && events.length > limit) target.appendChild(button(`Show more (${number(events.length - limit)} remaining)`, 'nt-secondary-button nt-load-more', () => { limit += 20; drawContent(); }));
    }
    function drawBand() {
      band.textContent = '';
      band.hidden = home;
      if (home) return;
      const fromDay = CTText.addDays(today, -6);
      const summary = CTTrails.summarize(record.events.filter(e => e.day >= fromDay && e.day <= today));
      const week = CTExplore.buildSeries(record);
      summary.estimatedMs = week.ms;
      const exploreHref = opts.readOnly ? 'explore.html?demo=1' : 'explore.html';
      const weekCard = el('section', 'nt-band-card nt-record-card');
      const timing = el('div', 'nt-time-estimate');
      timing.append(el('strong', null, summary.visitCount || summary.estimatedMs ? duration(summary.estimatedMs) : '—'), el('span', null, 'estimated browsing time'));
      const max = Math.max(1, ...week.days.map(d => d.ms));
      const chart = el('div', 'nt-mini-week'); chart.setAttribute('aria-label', 'Estimated browsing time over the past seven days');
      for (const day of week.days) {
        const a = link('', exploreHref, 'nt-mini-day'); a.setAttribute('aria-label', `${date(day.bounds.from)}: ${duration(day.ms)} estimated. Explore this week`); a.title = a.getAttribute('aria-label');
        const bar = el('span'); bar.style.height = `${Math.max(2, day.ms / max * 100)}%`; a.append(bar); chart.append(a);
      }
      weekCard.append(el('p', 'kicker', 'The past 7 days'), timing, chart, link('Explore your week →', exploreHref, 'nt-text-link'));
      const coverageCard = el('section', 'nt-band-card');
      const stats = el('dl', 'nt-stats');
      for (const [value, label] of [[summary.visitCount, 'recorded visits'], [summary.pageCount, 'distinct pages'], [summary.sourceCount, 'websites'], [summary.dayCount, 'days with visits']]) {
        const pair = el('div', 'nt-stat'); pair.append(el('dd', null, number(value)), el('dt', null, label)); stats.appendChild(pair);
      }
      coverageCard.append(el('p', 'kicker', 'In this period'), stats, el('p', 'nt-coverage', summary.visitCount
        ? `${number(summary.categorizedCount)} of ${number(summary.visitCount)} visits grouped. Timing measured for ${number(summary.measuredCount)}.`
        : 'Counts describe recorded pages only. Your record will appear as you browse.'));
      if (summary.pendingCount) coverageCard.append(el('p', 'nt-help', `${count(summary.pendingCount, 'recent capture')} included before history processing.`));
      const method = el('details', 'nt-method'); method.appendChild(el('summary', null, 'What these numbers mean'));
      method.appendChild(el('p', null, 'Visits are recorded page openings. Repeated visits remain separate. A returned day is a date after the first recorded date, using this device’s local time. Websites count distinct hostnames.'));
      method.appendChild(el('p', null, 'Timestamped activity preserves breaks and revisits. Older interaction totals and history gaps have estimated placement. Gaps are capped at 30 minutes, with a one-minute allowance after the last visit in a browsing sequence. Overlapping tabs count once across the whole record.'));
      method.appendChild(el('p', null, 'These are browser observations, not a measure of attention or thinking. Other apps and devices, private browsing, paused intervals, and excluded pages are outside this record. Silent reading can be undercounted.'));
      coverageCard.append(method);
      const local = el('section', 'nt-band-card nt-local-card');
      local.append(el('p', 'kicker', opts.readOnly ? 'A recorded example' : 'On this device'));
      const state = el('p', 'nt-capture-status', opts.readOnly ? 'Synthetic pages, real recorded model output.' : 'Your searchable record is stored locally.');
      local.appendChild(state);
      const latest = record.events[record.events.length - 1];
      if (latest) local.appendChild(el('p', 'nt-freshness', `Latest recorded visit: ${date(latest.time)} at ${clock(latest.time)}.`));
      const run = record.runs.find(r => r.status === 'ok' || r.status === 'complete' || r.status === 'completed' || r.status === 'success' || r.status === 'succeeded');
      local.appendChild(el('p', 'nt-freshness', run
        ? `Latest completed grouping: ${date(run.finishedAt || run.endedAt || run.startedAt)} at ${clock(run.finishedAt || run.endedAt || run.startedAt)}.`
        : 'No completed topic grouping in this record yet.'));
      const groupingStatus = el('p', 'nt-help'); local.appendChild(groupingStatus);
      if (!opts.readOnly && opts.onTogglePause) {
        const pause = button(paused ? 'Resume capture' : 'Pause capture', 'nt-secondary-button', async () => {
          pause.disabled = true;
          try {
            const result = await opts.onTogglePause(pause, !paused);
            paused = result && typeof result.paused === 'boolean' ? result.paused : !paused;
            if (opts.loadSnapshot) { data = await opts.loadSnapshot(); record = CTTrails.buildRecord(data); dailyView.update(record); }
            if (result?.endedSession) dailyView.openRecap(result.endedSession);
            pause.textContent = paused ? 'Resume capture' : 'Pause capture';
            state.textContent = paused ? 'Capture is paused. Your existing record is still available.' : 'Capture is enabled for eligible pages.';
            announce(paused ? 'Capture paused.' : 'Capture resumed.');
          } catch { announce('Could not change capture status. Try again from Settings.'); }
          pause.disabled = false;
        });
        local.appendChild(pause);
      }
      local.appendChild(link('Capture, exclusions & models →', links.settings, 'nt-text-link nt-settings-link'));
      band.append(weekCard, coverageCard, local);
      if (opts.statusProvider && !opts.readOnly) {
        Promise.resolve().then(() => opts.statusProvider()).then(info => {
          if (!info || disposed || !local.isConnected) return;
          paused = !!info.paused;
          state.textContent = paused ? 'Capture is paused. Your existing record is still available.' : 'Capture is enabled for eligible pages.';
          const pause = local.querySelector('button'); if (pause) pause.textContent = paused ? 'Resume capture' : 'Pause capture';
          const reachable = info.health ? info.health.reachable : info.ollama;
          if (reachable === false) groupingStatus.textContent = 'Local grouping is offline. Search and page capture remain available.';
          else if (info.health && info.health.missing && info.health.missing.length) groupingStatus.textContent = 'Local grouping needs model setup. Your pages remain searchable.';
        }).catch(() => { if (local.isConnected) groupingStatus.textContent = 'Capture status is unavailable. Check Settings for details.'; });
      }
    }
    async function action(message) {
      const reply = await opts.onAction(message);
      if (!reply?.ok) throw new Error(reply?.error || (reply?.reason === 'session-active' ? 'A session is already running.' : reply?.reason === 'capture-paused' ? 'Resume capture before starting a session.' : 'Could not save. Please retry.'));
      if (opts.loadSnapshot) data = await opts.loadSnapshot();
      else {
        if (reply.session) data.intent_sessions = (data.intent_sessions || []).filter(s => s.sessionId !== reply.session.sessionId).concat(reply.session);
        if (message.type === 'SAVE_PAGE_MEMBERSHIP') data.corrections = (data.corrections || []).filter(c => c.correctionId !== `page:${message.normalizedUrl}`).concat({ correctionId: `page:${message.normalizedUrl}`, kind: 'page_membership', targetId: message.normalizedUrl, value: { topicId: message.topicId }, updatedAt: Date.now() });
      }
      now = opts.now || Date.now(); record = CTTrails.buildRecord(data, { now });
      redraw();
      return reply;
    }
    dailyView = CTDailyView.mount(dashboardHost, record, { mode: home ? 'home' : 'trails', readOnly: opts.readOnly, openTrail, sessionId: opts.sessionId,
      action: opts.onAction ? action : null, renderChips: home ? drawChips : null, topicColor: CTStudio.topicColor });
    CTStudio.mount(shell, { view: studioPage, demo: opts.readOnly, links });
    drawHeader(); drawContent(); drawBand();
    if (opts.trailId) openTrail(opts.trailId);
    if (home && !opts.sessionId && !opts.trailId) input.focus({ preventScroll: true });
    const keyboard = event => {
      const target = event.target;
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !/INPUT|TEXTAREA|SELECT/.test(target.tagName) && !target.isContentEditable) {
        event.preventDefault(); input.focus();
      }
      if (event.key === 'Escape' && target === input && input.value) { input.value = ''; runSearch(); }
    };
    doc.addEventListener('keydown', keyboard);
    return {
      state: record.events.length ? 'rendered' : 'empty',
      get record() { return record; },
      openTrail,
      update(next) {
        // Do not discard an unfinished personal note when background data changes.
        if (disposed || doc.querySelector('.nt-edit[open]') || dailyView.isEditing) return;
        const active = doc.activeElement;
        const preserveContent = active && content.contains(active) && active !== content;
        now = opts.now || Date.now(); today = CTText.dayKeyFromMs(now);
        data = next; record = CTTrails.buildRecord(data, { now });
        fromInput.max = today; toInput.max = today;
        dailyView.update(record);
        drawHeader();
        if (!preserveContent) drawContent();
        drawBand();
        if (sheet && !sheet.contains(active)) drawSheet();
      },
      dispose() { disposed = true; closeSheet(); dailyView.dispose(); doc.removeEventListener('keydown', keyboard); }
    };
  }

  async function main(deps) {
    const d = deps || {};
    const store = d.store || globalThis.CTStore.createStore({});
    await store.open();
    if (store.resetStats) store.resetStats();
    const data = await CTTrails.loadData(store);
    const reads = store.stats ? store.stats.transactions : null;
    const view = render(d.container || document.getElementById('app'), data, {
      ...d,
      loadSnapshot: d.loadSnapshot || (() => CTTrails.loadData(store)),
      onSaveMetadata: d.readOnly ? null : d.onSaveMetadata || (row => store.put('corrections', row))
    });
    const dispose = view.dispose;
    view.dispose = () => { dispose(); if (!d.store) store.close(); };
    view.readTransactions = reads;
    return view;
  }
  return { main, render, loadData: CTTrails.loadData, duration };
});

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id &&
    typeof document !== 'undefined') {
  CTStudio.onPage('newtab.html', () => {
    const send = message => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (response && response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
    return CTNewtab.main({
      trailId: new URLSearchParams(location.search).get('trail'),
      sessionId: new URLSearchParams(location.search).get('session'),
      onAction: send,
      onSaveMetadata: row => send({ type: 'SAVE_TRAIL_METADATA', row }).then(reply => { if (!reply?.ok) throw new Error(reply?.reason || 'Save unavailable'); }),
      statusProvider: () => send({ type: 'GET_STATUS' }),
      onTogglePause: (_button, paused) => send({ type: 'SET_CAPTURE_PAUSED', paused }).then(reply => { if (typeof reply?.paused !== 'boolean') throw new Error('Pause unavailable'); return reply; }),
      onSearch: query => new Promise((resolve, reject) => {
        if (!chrome.search || !chrome.search.query) { reject(new Error('Search unavailable')); return; }
        chrome.search.query({ text: query, disposition: 'CURRENT_TAB' }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve();
        });
      })
    }).then(view => {
      const store = CTStore.createStore({});
      let refreshing = false;
      const refresh = async () => {
        if (document.hidden || refreshing) return;
        refreshing = true;
        try { await send({ type: 'GET_TRAIL_SESSION_STATUS' }); view.update(await CTTrails.loadData(store)); } catch { /* retain the current record */ }
        finally { refreshing = false; }
      };
      const timer = setInterval(refresh, 30000);
      document.addEventListener('visibilitychange', refresh);
      const dispose=()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);view.dispose();store.close();window.removeEventListener('pagehide',dispose);};
      window.CTPageDispose=dispose;window.addEventListener('pagehide',dispose,{once:true});
    }).catch(error => {
      const app = document.getElementById('app');
      app.textContent = 'Your record could not be opened. Reload this tab to try again. ';
      const settings = document.createElement('a'); settings.href = 'options.html'; settings.textContent = 'Open settings'; app.appendChild(settings);
      console.error('Record render failed', error);
    });
  });
}
