// The useful record is available without a running model. Rendering is local,
// reads one projected snapshot, and never schedules inference.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports
    ? factory(require('../lib/text.js'), require('../lib/trails.js'))
    : factory(root.CTText, root.CTTrails);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTNewtab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText, CTTrails) {
  'use strict';
  const number = value => Number(value || 0).toLocaleString();
  const count = (value, noun) => `${number(value)} ${noun}${value === 1 ? '' : 's'}`;
  function duration(ms) {
    if (!ms) return '0m';
    const minutes = Math.round(ms / 60000);
    if (!minutes) return '<1m';
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
  }
  const clock = at => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const date = (at, full) => new Date(at).toLocaleDateString(undefined, { month: full ? 'long' : 'short', day: 'numeric', year: full ? 'numeric' : undefined });

  function render(container, snapshot, options) {
    const opts = options || {};
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    let now = opts.now || Date.now();
    let today = CTText.dayKeyFromMs(now);
    let data = { ...snapshot };
    let record = CTTrails.buildRecord(data, { now });
    let selectedId = opts.trailId || null;
    let mode = 'recent';
    let query = '';
    let from = '', to = '', ungrouped = false;
    let limit = 8;
    let paused = !!record.settings.capturePaused;
    let disposed = false;
    const links = { home: 'newtab.html', map: 'map.html', audit: 'audit.html', settings: 'options.html', demo: 'demo.html', ...(opts.links || {}) };
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
    const shell = el('div', 'nt-page');
    container.appendChild(shell);
    const skip = link('Skip to your record', '#record-content', 'nt-skip');
    shell.appendChild(skip);
    const header = el('header', 'nt-header');
    const brand = link('Cognitive Trails', links.home, 'nt-brand');
    const mark = el('span', 'nt-brand-mark', '⋮'); mark.setAttribute('aria-hidden', 'true');
    brand.prepend(mark); header.appendChild(brand);
    const nav = el('nav', 'nt-nav'); nav.setAttribute('aria-label', 'Main');
    nav.append(link('Map', links.map), link('Settings', links.settings));
    header.appendChild(nav); shell.appendChild(header);

    const hero = el('section', 'nt-hero');
    const eyebrow = el('div', 'nt-eyebrow', opts.readOnly ? 'A sample browsing record' : 'Your browsing, kept close');
    hero.append(eyebrow, el('h1', null, 'Pick up where you left off.'),
      el('p', 'nt-intro', 'Find the page, revisit the trail, and carry on. Your record stays on this device.'));
    const searchForm = el('form', 'nt-search'); searchForm.setAttribute('role', 'search');
    const searchIcon = el('span', 'nt-search-icon', '⌕'); searchIcon.setAttribute('aria-hidden', 'true');
    const input = el('input', 'nt-search-input'); input.type = 'search'; input.name = 'q';
    input.placeholder = 'Search titles, topics, or websites'; input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Search your browsing record'); input.setAttribute('aria-controls', 'record-content');
    const submit = el('button', 'nt-search-submit', 'Search'); submit.type = 'submit';
    searchForm.append(searchIcon, input, submit);
    searchForm.addEventListener('submit', event => { event.preventDefault(); runSearch(); });
    input.addEventListener('input', () => { if (!input.value) runSearch(); });
    hero.appendChild(searchForm);
    const searchTools = el('div', 'nt-search-tools');
    const filters = button('Filter by date', 'nt-text-button', () => {
      filterPanel.hidden = !filterPanel.hidden;
      filters.setAttribute('aria-expanded', String(!filterPanel.hidden));
    });
    filters.setAttribute('aria-controls', 'record-filters'); filters.setAttribute('aria-expanded', 'false');
    searchTools.appendChild(filters);
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
    hero.appendChild(filterPanel); shell.appendChild(hero);

    const live = el('p', 'nt-live'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    shell.appendChild(live);
    const layout = el('div', 'nt-layout'); shell.appendChild(layout);
    const content = el('section', 'nt-content'); content.id = 'record-content'; content.tabIndex = -1;
    const aside = el('aside', 'nt-sidebar'); aside.setAttribute('aria-label', 'About this record');
    layout.append(content, aside);
    const footer = el('footer', 'nt-footer');
    footer.append(link('Record & privacy', links.audit), el('span', null, 'Local by design. Yours to revisit.'));
    shell.appendChild(footer);

    function resetSearch() {
      input.value = ''; query = ''; fromInput.value = ''; toInput.value = '';
      from = ''; to = ''; ungrouped = false; ungroupedInput.checked = false; limit = 8;
    }
    function runSearch() {
      query = input.value.trim(); from = fromInput.value; to = toInput.value; ungrouped = ungroupedInput.checked;
      if (from && to && from > to) { announce('Choose an end date on or after the start date.'); return; }
      selectedId = null; limit = 8; mode = query || from || to || ungrouped ? 'search' : 'recent';
      drawContent(); drawAside();
    }
    function openTrail(id, moveFocus) {
      selectedId = id; resetSearch(); drawContent(); drawAside();
      if (moveFocus) content.focus();
      if (opts.onOpenTrail) opts.onOpenTrail(id);
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
        drawContent(); drawAside(); announce('Saved on this device.');
      } catch {
        if (target) target.disabled = false;
        announce('Could not save this change. Your existing record is unchanged.');
      }
    }
    function pinControl(trail) {
      const pin = button(trail.personal.pinned ? 'Pinned' : 'Pin', 'nt-pin', () => saveMetadata(trail, {
        ...trail.personal, pinned: !trail.personal.pinned
      }, pin));
      pin.setAttribute('aria-pressed', String(trail.personal.pinned));
      pin.setAttribute('aria-label', `${trail.personal.pinned ? 'Unpin' : 'Pin'} ${trail.label}`);
      if (opts.readOnly || !opts.onSaveMetadata) { pin.disabled = true; pin.title = 'Pinning is available in your own record.'; }
      return pin;
    }
    function drawContent() {
      content.textContent = '';
      const selected = record.trails.find(t => t.id === selectedId);
      if (selected) { drawTrail(selected); return; }
      const top = el('div', 'nt-section-heading');
      top.appendChild(el('h2', null, mode === 'search' ? 'Search your record' : 'Your trails'));
      const tabs = el('div', 'nt-view-controls'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Record view');
      for (const [value, label] of [['recent', 'Recent'], ['pinned', 'Pinned'], ['pages', 'All pages']]) {
        const tab = button(label, mode === value ? 'nt-view active' : 'nt-view', () => {
          selectedId = null; mode = value; resetSearch(); drawContent(); drawAside();
        });
        tab.setAttribute('aria-pressed', String(mode === value)); tabs.appendChild(tab);
      }
      top.appendChild(tabs); content.appendChild(top);
      if (!record.events.length) { drawEmpty(); return; }
      if (mode === 'search' || mode === 'pages') {
        const results = CTTrails.search(record, { query, from, to, ungrouped });
        content.appendChild(el('p', 'nt-results-count', `${count(results.length, 'recorded visit')}${query ? ` matching “${query}”` : ''}`));
        announce(`${count(results.length, 'recorded visit')} found.`);
        if (!results.length) {
          const empty = el('div', 'nt-empty compact');
          empty.append(el('h3', null, 'No pages matched this search.'), el('p', null, 'Try a page title, a website, or a wider date range. Pages do not need a topic to appear here.'));
          content.appendChild(empty);
        } else drawVisitList(results, content, true);
        return;
      }
      const trails = mode === 'pinned' ? record.trails.filter(t => t.personal.pinned) : record.trails;
      if (trails.length) {
        const cards = el('div', 'nt-trail-list');
        for (const trail of trails.slice(0, limit)) cards.appendChild(trailCard(trail));
        content.appendChild(cards);
        if (trails.length > limit) content.appendChild(button('Show more trails', 'nt-secondary-button nt-load-more', () => { limit += 20; drawContent(); }));
      } else if (mode === 'pinned') {
        const empty = el('div', 'nt-empty compact');
        empty.append(el('h3', null, 'Keep a trail within reach.'), el('p', null, 'Pin a trail from Recent to keep it here. Everything else is recorded passively.'));
        content.appendChild(empty);
      } else {
        const empty = el('div', 'nt-empty compact');
        empty.append(el('h3', null, 'Your pages are already here.'), el('p', null, 'Topic grouping happens locally when analysis is available. You can search and reopen your pages now.'));
        empty.appendChild(link('Set up local grouping →', links.settings)); content.appendChild(empty);
      }
      if (mode === 'recent') {
        const recent = record.events.slice().reverse();
        const heading = el('div', 'nt-section-heading nt-recent-heading');
        heading.append(el('h2', null, 'Recently visited'), button('View all pages →', 'nt-text-button', () => {
          mode = 'pages'; resetSearch(); drawContent(); drawAside(); content.focus();
        }));
        content.appendChild(heading);
        drawVisitList(recent.slice(0, 6), content, false);
      }
    }
    function trailCard(trail) {
      const card = el('article', 'nt-trail-card');
      const top = el('div', 'nt-trail-top');
      const label = el('span', 'nt-trail-date', `Last visited ${date(trail.lastAt)}`);
      top.append(label, pinControl(trail)); card.appendChild(top);
      const heading = el('h3');
      const open = button(trail.label, 'nt-trail-title', () => openTrail(trail.id, true));
      heading.appendChild(open); card.appendChild(heading);
      card.appendChild(el('p', 'nt-trail-meta', `${count(trail.pageCount, 'page')} · ${count(trail.sourceCount, 'website')} · ${trail.returnDays ? `returned on ${count(trail.returnDays, 'later day')}` : 'first recorded day'}${trail.dayCount > 1 ? ` · ${count(trail.episodes.length, 'session')}` : ''}`));
      if (trail.personal.note) card.appendChild(el('p', 'nt-card-note', trail.personal.note));
      const previews = el('div', 'nt-previews');
      const seen = new Set();
      for (const event of trail.events.slice().reverse()) {
        if (seen.has(event.normalizedUrl)) continue;
        seen.add(event.normalizedUrl);
        const row = el('div', 'nt-preview'); row.append(el('span', 'nt-domain', event.domain), pageLink(event)); previews.appendChild(row);
        if (seen.size >= 2) break;
      }
      card.appendChild(previews);
      card.appendChild(button('Open trail →', 'nt-text-button nt-open-trail', () => openTrail(trail.id, true)));
      return card;
    }
    function drawEmpty() {
      const empty = el('div', 'nt-empty');
      const motif = el('div', 'nt-empty-motif', '· ── · ── ·'); motif.setAttribute('aria-hidden', 'true');
      empty.append(motif, el('h3', null, 'The next page is a place to begin.'),
        el('p', null, 'Browse normally. Eligible pages appear here as they are recorded, ready to search and reopen. No bookmarking required.'),
        el('p', 'nt-empty-note', 'Local models can organize pages into topics later. Search works before they are installed.'));
      const actions = el('div', 'nt-empty-actions');
      actions.append(link('Explore the sample record', links.demo, 'nt-primary-link'), link('Capture & setup', links.settings, 'nt-secondary-link'));
      empty.appendChild(actions); content.appendChild(empty);
    }
    function drawTrail(trail) {
      content.appendChild(button('← All trails', 'nt-text-button nt-back', () => { selectedId = null; mode = 'recent'; drawContent(); drawAside(); content.focus(); }));
      const heading = el('div', 'nt-detail-heading'); heading.append(el('h2', null, trail.label), pinControl(trail)); content.appendChild(heading);
      content.appendChild(el('p', 'nt-detail-description', `Recorded from ${date(trail.firstAt, true)} to ${date(trail.lastAt, true)}. ${count(trail.visitCount, 'visit')} across ${count(trail.dayCount, 'day')}.`));
      if (trail.personal.name) content.appendChild(el('p', 'nt-suggested-label', `Your title · Suggested topic: ${trail.suggestedLabel}`));
      else content.appendChild(el('p', 'nt-suggested-label', 'Suggested topic · Page groupings can be imperfect.'));
      if (trail.personal.note) {
        const note = el('div', 'nt-personal-note'); note.append(el('span', 'nt-eyebrow', 'Your note'), el('p', null, trail.personal.note)); content.appendChild(note);
      }
      const edit = el('details', 'nt-edit'); edit.appendChild(el('summary', null, 'Add a note or name this trail'));
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
      content.appendChild(edit);
      const sessionHeading = el('div', 'nt-section-heading nt-recent-heading');
      sessionHeading.appendChild(el('h3', null, 'The pages along this trail'));
      content.append(sessionHeading, el('p', 'nt-help', 'Sessions start after a 30-minute gap between visits in this trail, or on a new day. Pages are ordered by visit time.'));
      const sessions = trail.episodes.slice().reverse();
      for (const session of sessions.slice(0, limit)) {
        const block = el('section', 'nt-episode');
        const header = el('div', 'nt-episode-heading');
        header.append(el('h4', null, date(session.firstAt, true)), el('span', null, `${clock(session.firstAt)}${session.events.length > 1 ? ` – ${clock(session.lastAt)}` : ''} · ${count(session.events.length, 'visit')}`));
        block.appendChild(header); drawVisitList(session.events, block, false); content.appendChild(block);
      }
      if (sessions.length > limit) content.appendChild(button('Show earlier sessions', 'nt-secondary-button nt-load-more', () => { limit += 20; drawContent(); }));
    }
    function drawVisitList(events, target, paginate) {
      const list = el('ol', 'nt-visit-list');
      for (const event of events.slice(0, paginate ? limit : events.length)) {
        const row = el('li', 'nt-visit');
        const dot = el('span', 'nt-visit-dot'); dot.setAttribute('aria-hidden', 'true'); row.appendChild(dot);
        const body = el('div', 'nt-visit-body'); body.appendChild(pageLink(event));
        const meta = el('div', 'nt-visit-meta');
        meta.append(el('span', 'nt-domain', event.domain), el('time', null, `${date(event.time)} · ${clock(event.time)}`));
        meta.querySelector('time').dateTime = new Date(event.time).toISOString();
        if (!event.topicIds.length) meta.appendChild(el('span', 'nt-ungrouped', 'No topic yet'));
        if (event.pending) meta.appendChild(el('span', 'nt-ungrouped', 'Recent capture'));
        body.appendChild(meta); row.appendChild(body);
        if (!selectedId && event.topicIds.length) {
          const trail = record.trails.find(t => t.id === event.topicIds[0]);
          if (trail) {
            const go = button('Trail ↗', 'nt-visit-trail', () => openTrail(trail.id, true));
            go.setAttribute('aria-label', `Open trail: ${trail.label}`); row.appendChild(go);
          }
        }
        list.appendChild(row);
      }
      target.appendChild(list);
      if (paginate && events.length > limit) target.appendChild(button(`Show more (${number(events.length - limit)} remaining)`, 'nt-secondary-button nt-load-more', () => { limit += 20; drawContent(); }));
    }
    function drawAside() {
      aside.textContent = '';
      const selected = record.trails.find(t => t.id === selectedId);
      const fromDay = CTText.addDays(today, -6);
      const events = selected ? selected.events : record.events.filter(e => e.day >= fromDay && e.day <= today);
      const summary = CTTrails.summarize(events);
      const card = el('section', 'nt-record-card');
      card.append(el('div', 'nt-eyebrow', selected ? 'This trail, in the record' : 'The past 7 days'), el('h2', null, selected ? 'A few useful bearings' : 'A little context'));
      const stats = el('dl', 'nt-stats');
      for (const [value, label] of [[summary.visitCount, 'recorded visits'], [summary.pageCount, 'distinct pages'], [summary.sourceCount, 'websites'], [selected ? summary.returnDays : summary.dayCount, selected ? 'later days returned' : 'days with visits']]) {
        const pair = el('div', 'nt-stat'); pair.append(el('dd', null, number(value)), el('dt', null, label)); stats.appendChild(pair);
      }
      card.appendChild(stats);
      const timing = el('div', 'nt-time-estimate');
      timing.append(el('strong', null, summary.visitCount ? duration(summary.estimatedMs) : '—'), el('span', null, 'estimated browsing time'));
      card.appendChild(timing);
      const coverage = el('p', 'nt-coverage', summary.visitCount
        ? `${count(summary.categorizedCount, 'visit')} grouped of ${number(summary.visitCount)} recorded. Interaction timing available for ${number(summary.measuredCount)} of ${number(summary.visitCount)}.`
        : 'Counts describe recorded pages only. Your record will appear as you browse.');
      card.appendChild(coverage);
      if (summary.pendingCount) card.appendChild(el('p', 'nt-help', `${count(summary.pendingCount, 'recent capture')} included before history processing.`));
      const method = el('details', 'nt-method'); method.appendChild(el('summary', null, 'What these numbers mean'));
      method.appendChild(el('p', null, 'Visits are recorded page openings. Repeated visits remain separate. A returned day is a date after the first recorded date, using this device’s local time. Websites count distinct hostnames.'));
      method.appendChild(el('p', null, 'Time uses gaps between visits, capped at 30 minutes, with a one-minute allowance at a session end. Available interaction measurements can lower that estimate. Recent captures use measured time; overlapping estimates are counted once.'));
      method.appendChild(el('p', null, 'These are browser observations, not a measure of attention or thinking. Other apps and devices, private browsing, paused intervals, and excluded pages are outside this record. Silent reading can be undercounted.'));
      card.appendChild(method); aside.appendChild(card);
      const local = el('section', 'nt-local-card');
      local.appendChild(el('h2', null, opts.readOnly ? 'A recorded example' : 'On this device'));
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
            pause.textContent = paused ? 'Resume capture' : 'Pause capture';
            state.textContent = paused ? 'Capture is paused. Your existing record is still available.' : 'Capture is enabled for eligible pages.';
            announce(paused ? 'Capture paused.' : 'Capture resumed.');
          } catch { announce('Could not change capture status. Try again from Settings.'); }
          pause.disabled = false;
        });
        local.appendChild(pause);
      }
      local.appendChild(link('Capture, exclusions & models →', links.settings, 'nt-settings-link'));
      aside.appendChild(local);
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
    drawContent(); drawAside();
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
        if (disposed || doc.querySelector('.nt-edit[open]')) return;
        const active = doc.activeElement;
        if (active && content.contains(active) && active !== content) return;
        now = opts.now || Date.now(); today = CTText.dayKeyFromMs(now);
        data = next; record = CTTrails.buildRecord(data, { now });
        drawContent(); drawAside();
      },
      dispose() { disposed = true; doc.removeEventListener('keydown', keyboard); }
    };
  }

  async function main(deps) {
    const d = deps || {};
    const store = d.store || globalThis.CTStore.createStore({});
    await store.open();
    if (store.resetStats) store.resetStats();
    const data = await CTTrails.loadData(store);
    const reads = store.stats ? store.stats.transactions : null;
    return { ...render(d.container || document.getElementById('app'), data, {
      ...d,
      onSaveMetadata: d.readOnly ? null : d.onSaveMetadata || (row => store.put('corrections', row))
    }), readTransactions: reads };
  }
  return { main, render, loadData: CTTrails.loadData, duration };
});

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id &&
    typeof document !== 'undefined' && !globalThis.__CT_DEMO__) {
  document.addEventListener('DOMContentLoaded', () => {
    const send = message => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (response && response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
    CTNewtab.main({
      trailId: new URLSearchParams(location.search).get('trail'),
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
        try { view.update(await CTTrails.loadData(store)); } catch { /* retain the current record */ }
        finally { refreshing = false; }
      };
      const timer = setInterval(refresh, 30000);
      document.addEventListener('visibilitychange', refresh);
      window.addEventListener('pagehide', () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); view.dispose(); store.close(); }, { once: true });
    }).catch(error => {
      const app = document.getElementById('app');
      app.textContent = 'Your record could not be opened. Reload this tab to try again. ';
      const settings = document.createElement('a'); settings.href = 'options.html'; settings.textContent = 'Open settings'; app.appendChild(settings);
      console.error('Record render failed', error);
    });
  });
}
