'use strict';
const assert = require('assert');
const CTHistory = require('../../lib/history.js');

const MIN = 60 * 1000;
const base = new Date(2026, 2, 10, 9, 0, 0).getTime();

function item(url, title, lastVisitTime) {
  return { url, title, lastVisitTime };
}
function visit(id, visitTime, transition) {
  return { visitId: id, visitTime, transition: transition || 'link' };
}

// --- v3 suite carried forward: repeat visits stay separate events ---------
{
  const history = [item('https://example.com/article', 'Example Article', base + 70 * MIN)];
  const visits = {
    'https://example.com/article': [visit('first', base), visit('second', base + 5 * MIN), visit('third', base + 70 * MIN)]
  };
  const events = CTHistory.buildVisitEvents(history, visits, {});
  assert.strictEqual(events.length, 3, 'repeat visits preserved as separate events');
  assert.strictEqual(events[0].dwellMs, 5 * MIN, 'dwell from gap to next visit');
  assert.strictEqual(events[1].endsSession, true, 'long gap marks session break');
  assert.strictEqual(events[1].dwellMs, MIN, 'session-ending visit gets the 1-minute allowance, not phantom minutes');
  assert.strictEqual(events[2].dwellMs, MIN, 'final visit also gets the allowance');
}

// --- dwell cap at 30 minutes ---------------------------------------------
{
  const history = [item('https://a.example/x', 'A', base), item('https://b.example/y', 'B', base + 29 * MIN)];
  const visits = {
    'https://a.example/x': [visit('a1', base)],
    'https://b.example/y': [visit('b1', base + 29 * MIN)]
  };
  const events = CTHistory.buildVisitEvents(history, visits, {});
  assert.strictEqual(events[0].dwellMs, 29 * MIN, 'sub-cap gap passes through');
}

// --- redirect collapse at 1.9 s and 2.1 s --------------------------------
{
  const mk = gapMs => CTHistory.buildVisitEvents(
    [
      item('https://redirector.example/out', 'Redirecting', base),
      item('https://target.example/landing', 'Landing page', base + gapMs)
    ],
    {
      'https://redirector.example/out': [visit('r1', base)],
      'https://target.example/landing': [visit('t1', base + gapMs, 'auto_toplevel')]
    },
    {}
  );
  assert.strictEqual(mk(1900).length, 1, '1.9 s auto transition collapses into the later URL');
  assert.strictEqual(mk(1900)[0].url, 'https://target.example/landing');
  assert.strictEqual(mk(2100).length, 2, '2.1 s apart stays two events');
}

// --- same-domain rapid browsing remains separate -------------------------------
{
  const events = CTHistory.buildVisitEvents(
    [
      item('https://shop.example/a', 'A', base),
      item('https://shop.example/b', 'B', base + 1000)
    ],
    {
      'https://shop.example/a': [visit('a', base)],
      'https://shop.example/b': [visit('b', base + 1000, 'link')]
    },
    {}
  );
  assert.strictEqual(events.length, 2, 'same-domain sub-2s browsing is not evidence of a redirect');
  assert.strictEqual(events[0].dwellMs, 1000, 'the brief first page retains its own bounded time');
}

// --- capture-based dwell; ±90 s matching window -------------------------
// A capture only speaks for the span it observed. When it watched the whole
// visit the rule is exactly min(active, gap); when it watched part of it, the
// unobserved remainder keeps the gap estimate.
{
  const history = [item('https://a.example/x', 'A', base), item('https://b.example/y', 'B', base + 10 * MIN)];
  const visits = {
    'https://a.example/x': [visit('a1', base)],
    'https://b.example/y': [visit('b1', base + 10 * MIN)]
  };
  // Observed the full 10-minute visit and measured 3 minutes of it.
  const capture = offsetMs => [{
    normalizedUrl: 'https://a.example/x', startedAt: base + offsetMs, activeMs: 3 * MIN,
    endedAt: base + offsetMs + 10 * MIN, source: 'web', captureId: 'c1'
  }];
  const matched = CTHistory.buildVisitEvents(history, visits, { captures: capture(0) });
  assert.strictEqual(matched[0].dwellMs, 3 * MIN, 'measured active time lowers gap dwell');
  const bigActive = CTHistory.buildVisitEvents(history, visits, {
    captures: [{
      normalizedUrl: 'https://a.example/x', startedAt: base, activeMs: 60 * MIN,
      endedAt: base + 60 * MIN, captureId: 'c1'
    }]
  });
  assert.strictEqual(bigActive[0].dwellMs, 10 * MIN, 'a capture never inflates dwell above the gap');
  const inWindow = CTHistory.buildVisitEvents(history, visits, { captures: capture(89 * 1000) });
  assert.strictEqual(inWindow[0].dwellMs, 3 * MIN, '89 s offset still matches');
  const outWindow = CTHistory.buildVisitEvents(history, visits, { captures: capture(91 * 1000) });
  assert.strictEqual(outWindow[0].dwellMs, 10 * MIN, '91 s offset does not match');

  // The regression that blanked the home screen: every capture is created
  // with activeMs 0 and sent the moment the page loads. Read as a whole-visit
  // measurement it erased the visit; it must lower nothing instead.
  const justLoaded = CTHistory.buildVisitEvents(history, visits, {
    captures: [{
      normalizedUrl: 'https://a.example/x', startedAt: base, activeMs: 0,
      updatedAt: base, captureId: 'c1'
    }]
  });
  assert.strictEqual(justLoaded[0].dwellMs, 10 * MIN,
    'a capture that has observed nothing must not zero the visit');

  // A tab hidden after 2 minutes, with 30 s of measured attention. The capture
  // goes quiet because the tab stopped being visible, not because the time is
  // unknown — the remaining 8 minutes were not attention and must not survive.
  // This is the download-page-in-a-background-tab case.
  const backgrounded = CTHistory.buildVisitEvents(history, visits, {
    captures: [{
      normalizedUrl: 'https://a.example/x', startedAt: base, activeMs: 30 * 1000,
      updatedAt: base + 2 * MIN, captureId: 'c1'
    }]
  });
  assert.strictEqual(backgrounded[0].dwellMs, 30 * 1000,
    'a capture that went quiet must still cut the gap estimate down to measured time');

  // A legacy row carrying neither endedAt nor updatedAt and no measured time
  // proves nothing either way, so it lowers nothing.
  const legacy = CTHistory.buildVisitEvents(history, visits, {
    captures: [{
      normalizedUrl: 'https://a.example/x', startedAt: base, activeMs: 0, captureId: 'c1'
    }]
  });
  assert.strictEqual(legacy[0].dwellMs, 10 * MIN,
    'a capture with no measurement and no observed span lowers nothing');

  // ...but a legacy row that did measure something still counts.
  const legacyMeasured = CTHistory.buildVisitEvents(history, visits, {
    captures: [{
      normalizedUrl: 'https://a.example/x', startedAt: base, activeMs: 90 * 1000, captureId: 'c1'
    }]
  });
  assert.strictEqual(legacyMeasured[0].dwellMs, 90 * 1000,
    'a legacy capture with measured time still lowers dwell');

  // A capture that has ticked for a while and genuinely measured zero active
  // time (loaded, never focused) is evidence, and must lower the visit.
  const openedNeverRead = CTHistory.buildVisitEvents(history, visits, {
    captures: [{
      normalizedUrl: 'https://a.example/x', startedAt: base, activeMs: 0,
      updatedAt: base + 45 * 1000, captureId: 'c1'
    }]
  });
  assert.strictEqual(openedNeverRead[0].dwellMs, 0,
    'a capture that watched and measured nothing is evidence the visit was empty');

  // The invariant that must survive all of this.
  for (const activeMs of [0, 1, 30 * 1000, 3 * MIN, 9 * MIN, 60 * MIN]) {
    for (const observedMs of [0, 1000, 2 * MIN, 10 * MIN, 40 * MIN]) {
      const events = CTHistory.buildVisitEvents(history, visits, {
        captures: [{
          normalizedUrl: 'https://a.example/x', startedAt: base, activeMs,
          updatedAt: base + observedMs, captureId: 'c1'
        }]
      });
      assert.ok(events[0].dwellMs <= 10 * MIN,
        `capture dwell must never exceed the gap (active=${activeMs}, observed=${observedMs})`);
    }
  }
}

// --- pause interval exclusion --------------------------------------------
{
  const history = [
    item('https://a.example/x', 'A', base),
    item('https://b.example/y', 'B', base + 5 * MIN),
    item('https://c.example/z', 'C', base + 60 * MIN)
  ];
  const visits = {
    'https://a.example/x': [visit('a1', base)],
    'https://b.example/y': [visit('b1', base + 5 * MIN)],
    'https://c.example/z': [visit('c1', base + 60 * MIN)]
  };
  const events = CTHistory.buildVisitEvents(history, visits, {
    pauseIntervals: [{ start: base + 4 * MIN, end: base + 30 * MIN }]
  });
  assert.strictEqual(events.length, 2, 'visits inside a pause interval are dropped');
  assert.ok(!events.some(e => e.url.includes('b.example')));
}

// --- denylist exclusion at ingest ----------------------------------------
{
  const history = [
    item('https://a.example/x', 'A', base),
    item('https://secure.chase.com/home', 'Bank', base + MIN)
  ];
  const visits = {
    'https://a.example/x': [visit('a1', base)],
    'https://secure.chase.com/home': [visit('b1', base + MIN)]
  };
  const events = CTHistory.buildVisitEvents(history, visits, {});
  assert.strictEqual(events.length, 1, 'denylisted domains never enter the record');
}

// --- midnight-spanning session stays one session, days per-visit ---------
{
  const night = new Date(2026, 2, 10, 23, 55, 0).getTime();
  const history = [
    item('https://a.example/1', 'Late 1', night),
    item('https://a.example/2', 'Late 2', night + 10 * MIN)
  ];
  const visits = {
    'https://a.example/1': [visit('n1', night)],
    'https://a.example/2': [visit('n2', night + 10 * MIN)]
  };
  const events = CTHistory.buildVisitEvents(history, visits, {});
  assert.strictEqual(events[0].sessionId, events[1].sessionId, 'sessions are gap-based, not day-based');
  assert.strictEqual(events[0].dayKey, '2026-03-10');
  assert.strictEqual(events[1].dayKey, '2026-03-11', 'each visit attributed to its own day');
}

// --- reload transitions remain visit events (filtered later in §4.8) ------
{
  const history = [item('https://a.example/x', 'A', base + 5 * MIN)];
  const visits = { 'https://a.example/x': [visit('a1', base), visit('a2', base + 5 * MIN, 'reload')] };
  const events = CTHistory.buildVisitEvents(history, visits, {});
  assert.strictEqual(events.length, 2, 'reloads count as visits');
  assert.strictEqual(events[1].transition, 'reload', 'transition preserved for the §4.8 filter');
}

// --- source tagging flows from captures and URL --------------------------
{
  const history = [item('https://claude.ai/chat/abc', 'Chat', base)];
  const visits = { 'https://claude.ai/chat/abc': [visit('c1', base)] };
  const events = CTHistory.buildVisitEvents(history, visits, {});
  assert.strictEqual(events[0].source, 'llm_chat');
}

console.log('history tests passed');
