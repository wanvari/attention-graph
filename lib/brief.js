// The daily brief (spec §5.3). Facts only: the system records; the user
// interprets. Copy never contains normative words (tested in §7.5), every
// item carries evidence, at most five items, strict priority order.
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'));
  } else {
    root.CTBrief = factory(root.CTText);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText) {
  'use strict';

  const MAX_ITEMS = 5;

  const METRIC_DISPLAY = {
    topicEntropy: { name: 'Spread', unit: 'bits', format: v => `${v.toFixed(1)} bits` },
    activeTopicCount: { name: 'Topics touched', unit: '', format: v => `${Math.round(v)}` },
    switchesPerActiveHour: { name: 'Switch rate', unit: '/h', format: v => `${v.toFixed(1)} per active hour` },
    continuityShare: { name: 'Continuity', unit: '%', format: v => `${Math.round(v * 100)}%` },
    activeMs: { name: 'Active time', unit: '', format: v => {
      const minutes = Math.round(v / 60000);
      return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
    } }
  };

  function weekdayName(dayKey) {
    return new Date(CTText.dayKeyToNoonMs(dayKey)).toLocaleDateString('en-US', { weekday: 'short' });
  }

  // Input (all optional except day):
  // { day, metrics, events, baselines, zScores, topicsById, gap, pausedMsToday,
  //   newlyConvergentTopicIds, firstRun }
  function buildBrief(input) {
    const {
      day,
      metrics = null,
      events = [],
      zScores = {},
      topicsById = new Map(),
      gap = null,
      pausedMsToday = 0,
      newlyConvergentTopicIds = [],
      firstRun = false,
      runId = null,
      now = Date.now()
    } = input || {};

    const items = [];
    const labelOf = topicId => {
      const topic = topicsById.get(topicId);
      return topic ? topic.label : topicId;
    };

    // 0. First run ever: no lifecycle events can exist yet; say so plainly.
    if (firstRun) {
      items.push({
        kind: 'first_run',
        text: 'First analysis complete. Dormancy, revivals, and ranges appear once the record has history to compare against.',
        topicIds: [],
        evidence: { day }
      });
    }

    // 1. Data gaps — the record shows absence; it never editorializes about it.
    if (gap && gap.days >= 2) {
      const fromName = weekdayName(gap.from);
      const toName = weekdayName(gap.to);
      items.push({
        kind: 'data_gap',
        text: `No browsing recorded for ${gap.days} days (${fromName}–${toName}).`,
        topicIds: [],
        evidence: { from: gap.from, to: gap.to, days: gap.days }
      });
    }
    if (pausedMsToday >= 30 * 60 * 1000) {
      const hours = Math.round(pausedMsToday / 3600000 * 10) / 10;
      items.push({
        kind: 'data_gap',
        text: `Capture was paused ${hours}h today.`,
        topicIds: [],
        evidence: { pausedMs: pausedMsToday, day }
      });
    }

    // 2. Revivals (dormantDays >= 14 by construction of the lifecycle).
    const revivals = events.filter(e => e.type === 'revived' && (e.detail?.dormantDays ?? 0) >= 14);
    for (const event of revivals) {
      items.push({
        kind: 'revival',
        text: `*${labelOf(event.topicId)}* returned after ${event.detail.dormantDays} dormant days.`,
        topicIds: [event.topicId],
        evidence: { event: 'revived', topicId: event.topicId, dormantDays: event.detail.dormantDays }
      });
    }

    // 3. Dormancy crossings, max 2, highest lifetime dwell first.
    const dormancies = events
      .filter(e => e.type === 'dormant')
      .sort((a, b) => (topicsById.get(b.topicId)?.totalDwellMs || 0) - (topicsById.get(a.topicId)?.totalDwellMs || 0))
      .slice(0, 2);
    for (const event of dormancies) {
      const topic = topicsById.get(event.topicId);
      const lastSeen = topic && topic.lastActiveDay ? CTText.diffDays(topic.lastActiveDay, day) : 14;
      items.push({
        kind: 'dormancy',
        text: `*${labelOf(event.topicId)}* went quiet — last seen ${lastSeen} days ago.`,
        topicIds: [event.topicId],
        evidence: { event: 'dormant', topicId: event.topicId, lastActiveDay: topic ? topic.lastActiveDay : null }
      });
    }

    // 4. Convergence — presence in two sources, new this week only. Reported
    // as a fact of appearance, never as a relation between topics (spec D6).
    for (const topicId of newlyConvergentTopicIds) {
      items.push({
        kind: 'convergence',
        text: `*${labelOf(topicId)}* appeared in both browsing and LLM chats this week.`,
        topicIds: [topicId],
        evidence: { topicId, sources: ['web', 'llm_chat'], day }
      });
    }

    // 5. Range deviations, |z| >= 2 only. "For you", never good/bad. A
    // low-data day cannot support a deviation claim (it is excluded from
    // baselines for the same reason), so it makes none.
    for (const [metric, entry] of Object.entries(metrics && metrics.lowData ? {} : zScores)) {
      if (!entry || entry.z === null || Math.abs(entry.z) < 2) continue;
      const display = METRIC_DISPLAY[metric];
      if (!display || !metrics) continue;
      const todayValue = Number(metrics[metric]);
      const meanValue = Number(entry.mean);
      if (!Number.isFinite(todayValue) || !Number.isFinite(meanValue)) continue;
      items.push({
        kind: 'deviation',
        text: `${display.name} was unusual for you today (${display.format(todayValue)} vs your usual ${display.format(meanValue)}).`,
        topicIds: [],
        evidence: { metric, value: todayValue, mean: meanValue, z: entry.z, day }
      });
    }

    // 6. New topics — only if nothing above filled the slots.
    if (items.length < MAX_ITEMS) {
      const created = events.filter(e => e.type === 'created');
      if (created.length) {
        const names = created.slice(0, 3).map(e => `*${labelOf(e.topicId)}*`).join(', ');
        items.push({
          kind: 'new_topics',
          text: created.length === 1
            ? `A new topic started: ${names}.`
            : `${created.length} new topics started: ${names}.`,
          topicIds: created.map(e => e.topicId),
          evidence: { count: created.length, topicIds: created.map(e => e.topicId) }
        });
      }
    }

    return {
      day,
      generatedAt: now,
      runId,
      items: items.slice(0, MAX_ITEMS),
      seen: false,
      seenAt: null
    };
  }

  return { MAX_ITEMS, METRIC_DISPLAY, buildBrief };
});
