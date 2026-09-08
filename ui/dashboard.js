// Dashboard, evidence drawers and opt-in sessions. All persistence goes through
// the host's worker action callback; this renderer never invokes a model.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports ? factory(require('../lib/dashboard'), require('../lib/trails')) : factory(root.CTDashboard, root.CTTrails);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTDailyView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(D, T) {
  'use strict';
  const labels = { continuity: 'Continuity', top: 'Top trail', return: 'Return share', time: 'Estimated time recorded' };
  const percent = value => value === null ? '—' : `${Math.round(value * 100)}%`;
  const minutes = ms => `${Math.round(ms / 60000 * 10) / 10}m`;
  const duration = ms => ms === 0 ? '0m' : ms < 60000 ? '<1m' : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m`;
  const stamp = at => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function mount(container, initial, options = {}) {
    const doc = container.ownerDocument;
    let record = initial, signals, dialog = null, opener = null;
    const main = doc.createElement('div'); container.appendChild(main);
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const button = (text, cls, fn) => { const b = el('button', cls, text); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; };
    const link = event => { const a = el('a', 'nt-page-link', event.title); a.href = event.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
    function close() {
      if (!dialog) return;
      dialog.remove(); dialog = null;
      if (opener?.isConnected) opener.focus(); else main.querySelector('button')?.focus();
    }
    function open(title) {
      close(); opener = doc.activeElement;
      dialog = el('dialog', 'nt-drawer'); dialog.setAttribute('aria-labelledby', 'nt-drawer-title');
      const head = el('div', 'nt-drawer-heading'); const heading = el('h2', null, title); heading.id = 'nt-drawer-title';
      const exit = button('Close', 'nt-secondary-button', close); head.append(heading, exit); dialog.append(head);
      container.appendChild(dialog);
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const nodes = [...dialog.querySelectorAll('button:not([disabled]), a[href], input, select, textarea, summary')].filter(n => !n.hidden);
          if (event.shiftKey && doc.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
          if (!event.shiftKey && doc.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
        }
      });
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
      exit.focus();
      return dialog;
    }
    const paragraph = (parent, text, cls = 'nt-help') => parent.appendChild(el('p', cls, text));
    function comparison(key) {
      const range = signals.comparisons[key];
      if (!signals[key].eligible) return 'More recorded evidence needed for a comparison';
      if (range.n < 7) return `Building your comparison: ${range.n} of 7 days`;
      return `${range.direction[0].toUpperCase() + range.direction.slice(1)} recent range`;
    }
    const raw = key => key === 'continuity' ? `${signals.continuity.numerator} of ${signals.continuity.denominator} classified transitions stayed in one trail`
      : `${minutes(signals[key].numerator)} of ${minutes(signals[key].denominator)} grouped time`;
    function coverage(parent, stats) {
      const c = stats.coverage;
      paragraph(parent, `${c.groupedVisits} of ${c.visits} recorded visits grouped · interaction timing for ${c.measuredVisits} of ${c.visits} · ${c.exactTimingVisits} with timestamped activity`, 'nt-signal-coverage');
    }
    function pageRows(parent, events, bounds) {
      const list = el('ol', 'nt-evidence-list'); let limit = 30;
      const show = () => {
        list.textContent = '';
        for (const e of events.slice(0, limit)) {
          const li = el('li'); li.append(link(e));
          paragraph(li, `${stamp(e.time)} · this visit: ${duration(T.estimateMs([e], bounds))} estimated · ${e.timingMethod === 'observed-intervals' ? 'timestamped activity' : e.measured ? 'interaction total; placement estimated' : e.timingMethod.endsWith('unknown') ? 'duration unknown' : 'history gap estimate'}`);
          li.append(button('Inspect page', 'nt-text-button', () => openPage(e))); list.append(li);
        }
        more.hidden = events.length <= limit;
      };
      const more = button('Show more evidence', 'nt-secondary-button', () => { limit += 50; show(); });
      parent.append(list, more); show();
    }
    function openMetric(key) {
      const box = open(labels[key]);
      paragraph(box, `${stamp(signals.bounds.from)} – ${stamp(signals.bounds.to)}. All values use this period.`, 'nt-scope');
      if (key === 'time') {
        paragraph(box, `${duration(signals.totalMs)} total = ${duration(signals.groupedMs)} grouped + ${duration(signals.ungroupedMs)} ungrouped.`, 'nt-drawer-lead');
        paragraph(box, 'Timestamped activity is clipped to this period. Older interaction totals and history gaps use estimated placement. Overlapping tabs count once. Silent reading and activity outside this browser may be absent.');
      } else {
        paragraph(box, `${percent(signals[key].value)} · ${raw(key)}`, 'nt-drawer-lead');
        paragraph(box, key === 'continuity' ? 'Same-trail transitions ÷ classified within-session transitions. Reloads, the same URL, gaps over 30 minutes and day boundaries are excluded.'
          : key === 'top' ? 'Estimated minutes in the largest trail ÷ all grouped estimated minutes.'
          : 'Estimated minutes in trails first recorded before today ÷ all grouped estimated minutes.');
      }
      const range = signals.comparisons[key];
      paragraph(box, comparison(key));
      if (range.n) {
        const format = key === 'time' ? duration : percent;
        const middle = range.n >= 7 ? ` · middle 50%: ${format(range.q1)}–${format(range.q3)}` : '';
        paragraph(box, `Recent median: ${format(range.median)}${middle} · ${range.n} eligible days in the preceding 28 calendar days, each through the same local clock time.`);
      }
      paragraph(box, 'Below, within and above describe your recent range. None is a target or a grade. Comparisons require 7 eligible days, 3 classified transitions for Continuity, or 10 grouped minutes for the time-share rings.');
      coverage(box, signals);
      if (key === 'continuity') {
        paragraph(box, `${signals.flow.uncovered} of ${signals.flow.eligible} eligible transitions have an ungrouped endpoint and are excluded.`);
        const list = el('ol', 'nt-evidence-list');
        for (const pair of signals.flow.pairs) {
          const li = el('li'); li.append(link(pair.from), doc.createTextNode(' → '), link(pair.to));
          paragraph(li, pair.same ? 'Same trail' : 'Different trails'); list.append(li);
        }
        box.append(list);
      } else {
        if (key === 'top' || key === 'return') {
          const groups = el('div', 'nt-evidence-groups');
          for (const [id, ms] of [...signals.byTopic].sort((a, b) => b[1] - a[1])) {
            const trail = record.trails.find(t => t.id === id);
            if (key === 'return' && trail.firstAt >= signals.bounds.from) continue;
            const row = el('div'); row.append(button(`${trail.label} · ${duration(ms)}`, 'nt-text-button', () => { close(); options.openTrail(id, true); }),
              button('Start session', 'nt-secondary-button', () => startSession(trail))); groups.append(row);
          }
          box.append(groups);
        }
        const events = key === 'top' ? signals.events.filter(e => e.topicIds.includes(signals.top.topicId))
          : key === 'return' ? signals.events.filter(e => e.topicIds.some(id => record.trails.find(t => t.id === id)?.firstAt < signals.bounds.from)) : signals.events;
        pageRows(box, events, signals.bounds);
      }
    }
    async function perform(message, control, success) {
      if (!options.action || options.readOnly) return;
      control.disabled = true;
      const box = dialog;
      const error = el('p', 'nt-action-error'); error.setAttribute('role', 'alert'); box?.append(error);
      try { const result = await options.action(message); close(); draw(); if (success) success(result); }
      catch (e) { control.disabled = false; error.textContent = e.message || 'Could not save. Please try again.'; }
    }
    function startSession(trail) {
      const box = open(`Start a session · ${trail.label}`);
      paragraph(box, 'Choose a trail to return to and an optional next step. The recap describes the pages recorded during this session.');
      if (options.readOnly || !options.action) { paragraph(box, 'Sessions are available in your own installed record.'); return; }
      const active = record.sessions.find(s => s.status === 'active');
      if (active) { paragraph(box, 'A session is already running. End it before starting another.'); box.append(button('View session', 'nt-primary-button', () => openRecap(active))); return; }
      if ((record.settings.pauseIntervals || []).some(i => i.end == null)) { paragraph(box, 'Capture is paused. Resume capture before starting a session.'); return; }
      const form = el('form', 'nt-session-form');
      const durationLabel = el('label', 'nt-field', 'Duration');
      const select = el('select'); select.name = 'duration'; select.setAttribute('aria-label', 'Duration');
      for (const value of [25, 50, 90, null]) { const option = el('option', null, value === null ? 'Untimed' : `${value} minutes`); option.value = String(value); select.append(option); }
      durationLabel.append(select);
      const noteLabel = el('label', 'nt-field', 'Next step (optional)'); const note = el('textarea'); note.rows = 3; note.maxLength = 1000; note.placeholder = 'Where do you want to pick up?'; noteLabel.append(note);
      const submit = el('button', 'nt-primary-button', 'Start session'); submit.type = 'submit';
      form.append(durationLabel, noteLabel);
      paragraph(form, 'Timed sessions send a generic browser notification when they end. It contains no trail name or note. Untimed sessions end when you choose.');
      form.append(submit); box.append(form);
      form.addEventListener('submit', event => { event.preventDefault(); perform({ type: 'START_TRAIL_SESSION', topicId: trail.id, durationMinutes: select.value === 'null' ? null : Number(select.value), note: note.value }, submit); });
    }
    function openRecap(session) {
      const recap = D.buildSessionRecap(record, session), box = open(session.status === 'active' ? 'Session so far' : 'Session recap');
      paragraph(box, record.trails.find(t => t.id === session.topicId)?.label || session.targetLabel || 'Selected trail', 'nt-drawer-lead');
      paragraph(box, `${stamp(session.startedAt)} – ${stamp(session.endedAt ?? record.now)} · ${duration(recap.elapsedMs)} elapsed`);
      if (session.note) paragraph(box, session.note, 'nt-session-note');
      const stats = el('dl', 'nt-recap-stats');
      for (const [label, value] of [['Selected trail', recap.targetMs], ['Other grouped trails', recap.otherMs], ['Ungrouped pages', recap.ungroupedMs]]) {
        const pair = el('div'); pair.append(el('dt', null, label), el('dd', null, duration(value))); stats.append(pair);
      }
      box.append(stats); coverage(box, recap);
      paragraph(box, `${duration(recap.totalMs)} estimated recorded time. Elapsed wall time includes any time away from the browser. Grouping and corrections can update this recap later.`);
      if (session.endReason === 'capture-paused') paragraph(box, 'This session ended when capture was paused.');
      if (session.status === 'active' && options.action) {
        const end = button('End session', 'nt-primary-button', () => perform({ type: 'END_TRAIL_SESSION', sessionId: session.sessionId }, end, reply => openRecap(reply.session))); box.append(end);
      } else if (!options.readOnly && options.action && !session.recapSeenAt) {
        // Marking a recap seen is a persistence action, serialized by the worker.
        options.action({ type: 'MARK_TRAIL_SESSION_RECAP_SEEN', sessionId: session.sessionId }).catch(() => {});
      }
      pageRows(box, recap.events, recap.bounds);
    }
    function openPage(event) {
      const box = open('Page evidence'); box.append(link(event));
      const visits = record.events.filter(e => e.normalizedUrl === event.normalizedUrl);
      paragraph(box, `${event.domain} · recorded ${stamp(event.time)}`, 'nt-scope');
      paragraph(box, `This visit: ${duration(event.dwellMs)} estimated. This page across ${visits.length} recorded visit${visits.length === 1 ? '' : 's'}: ${duration(T.estimateMs(visits))} estimated.`, 'nt-drawer-lead');
      for (const id of event.topicIds) {
        const trail = record.trails.find(t => t.id === id);
        if (trail) paragraph(box, `Entire trail “${trail.label}”: ${duration(trail.estimatedMs)} across all recorded dates (${stamp(trail.firstAt)} – ${stamp(trail.lastAt)}). This includes other pages.`);
      }
      paragraph(box, `Grouping: ${event.groupingReason.replaceAll('-', ' ').replaceAll('_', ' ')}. Timing: ${event.timingMethod.replaceAll('-', ' ')}.`);
      if (event.timingMethod === 'operational-duration-unknown') paragraph(box, 'Status-page refreshes can create history entries while you are away. Unmeasured gaps on these pages are excluded from time totals and remain unknown.');
      paragraph(box, 'An estimated history gap does not prove the page was visible for that entire time. Missing past measurements cannot be recovered.');
      if (!options.readOnly && options.action) {
        const form = el('form', 'nt-session-form'), label = el('label', 'nt-field', 'Page grouping');
        const select = el('select'); select.name = 'topic'; select.setAttribute('aria-label', 'Page grouping');
        const empty = el('option', null, 'Keep ungrouped'); empty.value = ''; select.append(empty);
        for (const trail of record.availableTrails || record.trails) { const option = el('option', null, trail.label); option.value = trail.id; select.append(option); }
        select.value = event.topicIds[0] || ''; label.append(select);
        const save = el('button', 'nt-primary-button', 'Save grouping'); save.type = 'submit'; form.append(label, save);
        paragraph(form, 'Applies to this page’s recorded visits. Your choice stays in place during future automatic grouping.');
        form.addEventListener('submit', e => { e.preventDefault(); perform({ type: 'SAVE_PAGE_MEMBERSHIP', normalizedUrl: event.normalizedUrl, topicId: select.value || null }, save); });
        box.append(form);
        if (event.topicIds.length) {
          const remove = button('Remove from trail', 'nt-secondary-button', () => perform({ type: 'SAVE_PAGE_MEMBERSHIP', normalizedUrl: event.normalizedUrl, topicId: null }, remove)); box.append(remove);
        }
      }
    }
    function draw() {
      signals = D.buildDailySignals(record); main.textContent = '';
      const dashboard = el('section', 'nt-dashboard'); dashboard.setAttribute('aria-labelledby', 'nt-today-title');
      const heading = el('div', 'nt-dashboard-heading'); const title = el('h2', null, 'Today, so far'); title.id = 'nt-today-title';
      heading.append(title, el('span', 'nt-scope', `Through ${new Date(record.now).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`)); dashboard.append(heading);
      const time = button('', 'nt-time-headline', () => openMetric('time'));
      time.append(el('strong', null, duration(signals.totalMs)), el('span', null, 'estimated time recorded'));
      const timeRow = el('div', 'nt-time-row'); timeRow.append(time);
      const timeCompare = el('div', `nt-comparison nt-direction-${signals.comparisons.time.direction}`); timeCompare.append(el('span', null, comparison('time')));
      if (signals.comparisons.time.n) timeCompare.append(el('small', null, `${duration(signals.comparisons.time.median)} recent median · ${signals.comparisons.time.n} days`));
      timeRow.append(timeCompare); dashboard.append(timeRow);
      const rings = el('div', 'nt-rings');
      for (const key of ['continuity', 'top', 'return']) {
        const metric = signals[key], range = signals.comparisons[key];
        const ring = button('', `nt-ring-card nt-direction-${range.direction}`, () => openMetric(key)); ring.setAttribute('aria-label', `${labels[key]} ${percent(metric.value)}. ${raw(key)}. Inspect evidence.`);
        const dial = el('span', 'nt-ring-dial'); dial.style.setProperty('--ring-turn', `${(metric.value || 0) * 360}deg`); dial.setAttribute('aria-hidden', 'true');
        dial.append(el('strong', null, percent(metric.value))); ring.append(dial, el('span', 'nt-ring-title', labels[key]));
        const top = key === 'top' ? record.trails.find(t => t.id === metric.topicId)?.label : null;
        ring.append(el('span', 'nt-ring-subject', top || (key === 'continuity' ? 'Stayed in one trail' : key === 'return' ? 'Earlier trails revisited' : 'No grouped time yet')),
          el('span', 'nt-ring-raw', raw(key)), el('span', 'nt-comparison', comparison(key)), el('span', 'nt-inspect', 'Inspect evidence ↗'));
        rings.append(ring);
      }
      dashboard.append(rings); paragraph(dashboard, signals.observation, 'nt-observation'); coverage(dashboard, signals);
      paragraph(dashboard, 'Your recent range describes your own recorded days.', 'nt-signal-note'); main.append(dashboard);
      const resume = D.continuation(record);
      if (resume.page || resume.session) {
        const card = el('section', 'nt-continuation'); card.setAttribute('aria-label', 'Continue your trail');
        const body = el('div'); body.append(el('div', 'nt-eyebrow', resume.session ? 'Session in progress' : 'A place to continue'), el('h2', null, resume.trail?.label || resume.session?.targetLabel || resume.page.title));
        if (resume.session) {
          const remaining = resume.session.durationMinutes === null ? null : Math.max(0, resume.session.startedAt + resume.session.durationMinutes * 60000 - record.now);
          paragraph(body, remaining === null ? `${duration(record.now - resume.session.startedAt)} elapsed · untimed` : remaining ? `${duration(remaining)} remaining` : 'Time ended · preparing recap', 'nt-session-countdown');
          if (resume.session.note) paragraph(body, resume.session.note, 'nt-session-note');
        } else if (resume.trail?.personal.note) paragraph(body, resume.trail.personal.note, 'nt-session-note');
        const actions = el('div', 'nt-session-actions');
        if (resume.page) { const a = link(resume.page); a.textContent = 'Open last page ↗'; a.className = 'nt-primary-link'; actions.append(a); }
        if (resume.session) actions.append(button('View or end session', 'nt-secondary-button', () => openRecap(resume.session)));
        else if (resume.trail) actions.append(button('Start session', 'nt-secondary-button', () => startSession(resume.trail)));
        card.append(body, actions); main.append(card);
      }
      const completed = record.sessions.filter(s => s.status === 'complete').sort((a, b) => b.startedAt - a.startedAt);
      if (completed.length) {
        const history = el('details', 'nt-session-history'); history.append(el('summary', null, `${completed.length} session recap${completed.length === 1 ? '' : 's'}`));
        for (const session of completed) history.append(button(`${stamp(session.startedAt)} · ${session.targetLabel || 'Trail session'}`, 'nt-text-button', () => openRecap(session)));
        main.append(history);
      }
    }
    draw();
    if (options.sessionId) {
      const session = record.sessions.find(s => s.sessionId === options.sessionId);
      if (session) openRecap(session); else { const box = open('Session unavailable'); paragraph(box, 'This session is no longer in your record.'); }
    }
    return { openPage, startSession, openRecap, get isEditing() { return !!dialog; },
      update(next) { record = next; draw(); }, dispose() { close(); container.textContent = ''; } };
  }
  return { mount, duration, percent };
});
