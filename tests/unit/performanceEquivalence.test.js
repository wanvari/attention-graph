'use strict';
const assert = require('node:assert/strict');
const T = require('../../lib/trails'), D = require('../../lib/dashboard');
const OldT = require('../helpers/reference/trails-5.1.1'), OldD = require('../helpers/reference/dashboard-5.1.1');
const { makeRecordFixture } = require('../helpers/performanceFixture');
const check = (data, now) => {
  const actual = T.buildRecord(data, { now }), expected = OldT.buildRecord(data, { now });
  assert.deepEqual(actual, expected, 'every record field must match the frozen pre-optimization implementation');
  assert.deepEqual(D.buildDailySignals(actual), OldD.buildDailySignals(expected));
  for (const from of [now - 40 * 86400000, now - 1800000, now - 11000, now]) {
    const bounds = { from, to: now };
    assert.deepEqual(D.measure(actual, bounds), OldD.measure(expected, bounds));
    const session = { topicId: 't0', startedAt: from, endedAt: now };
    assert.deepEqual(D.buildSessionRecap(actual, session), OldD.buildSessionRecap(expected, session));
  }
};
let seed = 42;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const priorZone = process.env.TZ;
for (const zone of ['America/New_York', 'Europe/Berlin', 'Asia/Kolkata']) {
  process.env.TZ = zone;
  for (let n = 0; n < 35; n++) {
    const { data } = makeRecordFixture(80, 12, 4);
    const now = new Date(2026, n % 2 ? 2 : 10, n % 2 ? 9 : 2, n % 3 ? 15 : 0, 5).getTime();
    for (const [i, v] of data.visits.entries()) {
      v.visitTime = now - Math.floor(random() * 30 * 86400) * 1000;
      if (i % 9 === 0) v.visitTime = now - 5000; // ambiguous simultaneous visits
      if (i % 13 === 0) v.visitTime = now + 1000; // future evidence must stay clipped
      v.gapDwellMs = Math.floor(random() * 2000000);
      if (i % 3 === 0) data.captures.push({ captureId: `c${i}`, url: v.url, normalizedUrl: v.normalizedUrl,
        startedAt: v.visitTime, updatedAt: v.visitTime + 170000, endedAt: i % 2 ? null : v.visitTime + 170000,
        activeMs: 80000, activityIntervals: [[v.visitTime, v.visitTime + 9000], [v.visitTime + 20000, v.visitTime + 95000]] });
    }
    data.captures.push({ captureId: 'midnight', url: data.pages[0].url, startedAt: now - 600000, endedAt: now + 10000,
      activityIntervals: [[now - 600000, now + 10000]], activeMs: 610000 });
    data.visits.push({ visitId: 'status', url: 'https://status.claude.com/', title: 'Claude Status', visitTime: now - 200000, dwellMs: 805 * 60000 });
    data.settings = [{ key: 'pauseIntervals', value: [{ start: now - 50000, end: now - 22000 }, ...(n % 2 ? [{ start: now - 1000 }] : [])] }];
    data.corrections.push({ correctionId: 'choice', kind: 'page_membership', targetId: data.pages[1].url, value: { topicId: n % 2 ? 't2' : null }, updatedAt: now });
    if (n % 3 === 0) data.memberships.push({ ...data.memberships[2], topicId: 't3' });
    check(data, now);
    // Reuse the same data with new clocks and edited evidence. No stale index.
    check(data, now + 45000);
    data.captures[0].activityIntervals = []; data.memberships.pop(); check(data, now + 86400000);
  }
}
if (priorZone === undefined) delete process.env.TZ; else process.env.TZ = priorZone;
const large = makeRecordFixture(3000, 150, 30); check(large.data, large.now);
console.log('316 complete record/dashboard/recap comparisons match frozen 5.1.1, including edits, pauses, overlaps, unknowns, midnight and DST');
