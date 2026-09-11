// Registry -> map view-model adapter (spec §5.2). The v4 map keeps the v3
// D3 rendering but reads the persistent registry instead of a snapshot
// analysis: nodes are active topics with dwell in the selected window, edges
// are aggregated transitions, and topic ids are stable so corrections attach
// directly instead of being re-matched by page overlap.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports ? factory(require('../lib/text'), require('../lib/trails'), require('../lib/dashboard')) : factory(root.CTText, root.CTTrails, root.CTDashboard);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTMapData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText, Trails, Dashboard) {
  'use strict';

  const TRANSITION_TYPES = {
    same_topic_flow: {
      label: 'Same-topic continuation',
      color: '#8d94c7',
      description: 'Consecutive visits stayed inside one topic.'
    },
    adjacent_topic_jump: {
      label: 'Similar page subjects',
      color: '#7c8fe0',
      description: 'Consecutive visits between topics with similar page embeddings. Similarity does not establish a shared task.'
    },
    topic_switch: {
      label: 'Between topics',
      color: '#a9a2c9',
      description: 'Consecutive recorded visits in different topic groups.'
    }
  };

  const ATTENTION_BANDS = {
    primary: {
      label: 'Highest estimated time',
      color: '#4356d6',
      description: 'One of the highest-time topics in the selected window.'
    },
    secondary: {
      label: 'Middle estimated time',
      color: '#7c8fe0',
      description: 'Ranked 4–10 by estimated time, or at least 3.5% of grouped estimated time.'
    },
    long_tail: {
      label: 'Long-tail topic',
      color: '#9aa3b8',
      description: 'A smaller topic with limited estimated time or visit evidence.'
    }
  };

  const BAND_PALETTES = {
    primary: ['#4356d6', '#5b6ee0', '#3b49b8'],
    secondary: ['#7c8fe0', '#8f9fe8', '#6a7ed0'],
    long_tail: ['#9aa3b8', '#a8b0c2', '#8a93a8']
  };

  function msToMinutes(ms) {
    return Math.round((ms || 0) / 60000);
  }

  // windowDays: 7 | 30 | 90. Returns the analysis-shaped object map.js renders.
  async function build(store, options) {
    const opts = options || {};
    const windowDays = Number(opts.windowDays) || 30;
    const now = opts.now || Date.now();
    const today = CTText.dayKeyFromMs(now);
    const fromDay = CTText.addDays(today, -(windowDays - 1));

    const snapshot = await Trails.loadData(store);
    const record = Trails.buildRecord(snapshot, { now });
    const [year, month, day] = fromDay.split('-').map(Number);
    const measured = Dashboard.measure(record, { from: new Date(year, month - 1, day).getTime(), to: now });
    const topicRows = (snapshot.topics || []).map(t => ({ ...t, label: record.trails.find(r => r.id === t.topicId)?.label || t.label }));
    const runRows = snapshot.runs || [];
    const pageRows = [...new Map(record.events.map(e => [e.normalizedUrl, { normalizedUrl: e.normalizedUrl, url: e.url, title: e.title, domain: e.domain, source: e.source }])).values()];
    const memberships = [...new Map(record.events.filter(e => e.topicIds.length).map(e => [e.normalizedUrl, { normalizedUrl: e.normalizedUrl, topicId: e.topicIds[0] }])).values()];
    const visitRows = measured.events;
    const windowStatsByUrl = new Map();
    for (const event of measured.events) {
      const entry = windowStatsByUrl.get(event.normalizedUrl) || { dwellMs: 0, visitCount: 0, firstSeen: event.time, lastSeen: event.time };
      entry.visitCount++; entry.firstSeen = Math.min(entry.firstSeen, event.time); entry.lastSeen = Math.max(entry.lastSeen, event.time);
      windowStatsByUrl.set(event.normalizedUrl, entry);
    }
    for (const slice of measured.slices) windowStatsByUrl.get(slice.event.normalizedUrl).dwellMs += slice.end - slice.start;
    const pageByUrl = new Map(pageRows.map(p => [p.normalizedUrl, p]));
    // Only memberships whose page was actually visited inside the window.
    const windowMemberships = memberships.filter(m => windowStatsByUrl.has(m.normalizedUrl));

    // Aggregate per-topic evidence over the window.
    const evidenceByTopic = new Map();
    for (const membership of windowMemberships) {
      const stats = windowStatsByUrl.get(membership.normalizedUrl);
      const entry = evidenceByTopic.get(membership.topicId) ||
        { dwellMs: 0, visitCount: 0, pages: [], domains: new Map() };
      entry.dwellMs += stats.dwellMs;
      entry.visitCount += stats.visitCount;
      const page = pageByUrl.get(membership.normalizedUrl);
      if (page) {
        entry.pages.push({
          id: page.normalizedUrl,
          title: page.title,
          url: page.url,
          domain: page.domain,
          source: page.source,
          visitCount: stats.visitCount,
          estimatedDwellMs: stats.dwellMs,
          estimatedDwellMinutes: msToMinutes(stats.dwellMs),
          firstVisitTime: stats.firstSeen,
          lastVisitTime: stats.lastSeen
        });
        const domainEntry = entry.domains.get(page.domain) || { domain: page.domain, visitCount: 0, estimatedDwellMs: 0 };
        domainEntry.visitCount += stats.visitCount;
        domainEntry.estimatedDwellMs += stats.dwellMs;
        entry.domains.set(page.domain, domainEntry);
      }
      evidenceByTopic.set(membership.topicId, entry);
    }

    const visibleTopics = topicRows
      .filter(topic => evidenceByTopic.has(topic.topicId))
      .map(topic => {
        const evidence = evidenceByTopic.get(topic.topicId);
        evidence.pages.sort((a, b) =>
          (b.visitCount * 3 + msToMinutes(b.estimatedDwellMs)) - (a.visitCount * 3 + msToMinutes(a.estimatedDwellMs)));
        return {
          id: topic.topicId,
          label: topic.label,
          state: topic.state,
          confidence: topic.confidence,
          heuristicConfidence: topic.heuristicConfidence,
          adjudication: topic.adjudication,
          userCorrected: !!topic.userCorrected,
          rationale: topic.rationale,
          keywords: topic.keywords || [],
          lastActiveDay: topic.lastActiveDay,
          createdAt: topic.createdAt,
          pageCount: evidence.pages.length,
          visitCount: evidence.visitCount,
          estimatedDwellMs: evidence.dwellMs,
          estimatedDwellMinutes: msToMinutes(evidence.dwellMs),
          topPages: evidence.pages.slice(0, 8),
          pages: evidence.pages,
          pageUrls: evidence.pages.map(p => p.id),
          pageIds: evidence.pages.map(p => p.id),
          topDomains: Array.from(evidence.domains.values())
            .sort((a, b) => b.visitCount - a.visitCount)
            .slice(0, 5),
          dominantDomainShare: (() => {
            const top = Array.from(evidence.domains.values()).sort((a, b) => b.visitCount - a.visitCount)[0];
            return evidence.visitCount && top ? top.visitCount / evidence.visitCount : 0;
          })(),
          llmLabeled: topic.labelSource === 'llm'
        };
      })
      .filter(topic => topic.estimatedDwellMs > 0 || topic.visitCount > 0);

    // Attention bands over the window.
    const totalDwell = Math.max(visibleTopics.reduce((sum, t) => sum + t.estimatedDwellMs, 0), 1);
    const ranked = visibleTopics.slice().sort((a, b) =>
      b.estimatedDwellMs - a.estimatedDwellMs || b.visitCount - a.visitCount || a.label.localeCompare(b.label));
    ranked.forEach((topic, index) => {
      const rank = index + 1;
      const share = topic.estimatedDwellMs / totalDwell;
      const band = rank <= 3 ? 'primary' : (rank <= 10 || share >= 0.035) ? 'secondary' : 'long_tail';
      topic.attentionRank = rank;
      topic.attentionShare = share;
      topic.attentionBand = band;
      topic.attentionBandLabel = ATTENTION_BANDS[band].label;
      topic.color = BAND_PALETTES[band][(rank - 1) % BAND_PALETTES[band].length];
    });

    // Edges are repeated observed sequences, recomputed after corrections.
    // A lone sequence stays in the timeline; it is not a stable connection.
    const topicById = new Map(visibleTopics.map(t => [t.id, t]));
    const edges = new Map();
    for (const pair of measured.flow.pairs) {
      const sourceTopicId = pair.from.topicIds[0], targetTopicId = pair.to.topicIds[0];
      if (!topicById.has(sourceTopicId) || !topicById.has(targetTopicId)) continue;
      const id = `${sourceTopicId}->${targetTopicId}`, type = pair.same ? 'same_topic_flow' : 'topic_switch';
      const edge = edges.get(id) || { id, sourceTopicId, targetTopicId, sourceLabel: topicById.get(sourceTopicId).label,
        targetLabel: topicById.get(targetTopicId).label, type, label: TRANSITION_TYPES[type].label, color: TRANSITION_TYPES[type].color,
        confidence: 1, similarity: 0, visitCount: 0, days: [], hourCounts: Array(24).fill(0), examples: [],
        rationale: 'Repeated consecutive recorded visits; this does not establish a shared task.', verified: false, uncertain: false };
      edge.visitCount++; edge.hourCounts[new Date(pair.to.time).getHours()]++;
      if (!edge.days.includes(pair.to.day)) edge.days.push(pair.to.day);
      edge.examples.push({ from: { title: pair.from.title, url: pair.from.url }, to: { title: pair.to.title, url: pair.to.url }, at: pair.to.time });
      edges.set(id, edge);
    }
    const transitions = [...edges.values()].filter(e => e.visitCount >= 2).sort((a, b) => b.visitCount - a.visitCount || a.id.localeCompare(b.id));
    const singleTransitions = [...edges.values()].filter(e => e.visitCount < 2).length;
    const activeMs = measured.totalMs, categorizedMs = measured.groupedMs, visitCount = measured.coverage.visits;
    const uncoveredTransitions = measured.flow.uncovered;
    const lastOkRun = runRows.filter(r => r.status === 'ok').sort((a, b) => b.startedAt - a.startedAt)[0] || null;
    const ungroupedUrls = new Set(measured.events.filter(e => !e.topicIds.length).map(e => e.normalizedUrl));
    const uncategorizedPages = [...ungroupedUrls].map(url => {
      const page = pageByUrl.get(url), stats = windowStatsByUrl.get(url), event = measured.events.find(e => e.normalizedUrl === url);
      return { id: url, title: page.title, url: page.url, domain: page.domain, reason: event.groupingReason, visitCount: stats.visitCount,
        estimatedDwellMs: stats.dwellMs, estimatedDwellMinutes: msToMinutes(stats.dwellMs), firstVisitTime: stats.firstSeen, lastVisitTime: stats.lastSeen };
    });

    // Flow aggregates over exactly the edges this window drew, so the summary
    // strip can never claim more switching than the map itself shows. Derived
    // here rather than averaged out of daily_metrics: a per-day rate mean is
    // not the rate over the window.
    const transitionMixItems = Object.keys(TRANSITION_TYPES).map(type => {
      const rows = transitions.filter(t => t.type === type);
      return {
        type,
        label: TRANSITION_TYPES[type].label,
        count: rows.reduce((sum, t) => sum + t.visitCount, 0)
      };
    });
    const switchCount = (transitionMixItems.find(i => i.type === 'topic_switch') || { count: 0 }).count;
    const activeHours = activeMs / 3.6e6;

    return {
      ok: measured.events.length > 0,
      version: 'cognitive-trails-v5.1',
      source: 'corrected recorded visits',
      metrics: {
        switching: {
          switchCount,
          switchesPerActiveHour: activeHours > 0
            ? Math.round((switchCount / activeHours) * 10) / 10
            : 0
        },
        transitionMix: { items: transitionMixItems },
        topicTimeShare: ranked
      },
      generatedAt: lastOkRun ? new Date(lastOkRun.startedAt).toISOString() : new Date(now).toISOString(),
      fromCache: true,
      windowDays,
      models: { embedding: 'bge-m3:latest', chat: 'qwen3:4b' },
      topics: ranked,
      transitions, singleTransitions,
      coverage: {
        days: windowDays,
        visitsExpanded: visitCount,
        estimatedActiveMs: activeMs,
        estimatedActiveMinutes: msToMinutes(activeMs),
        startTime: measured.bounds.from,
        endTime: now,
        dwellMethod: 'Timestamped activity where available; older totals and history gaps have estimated placement. Overlapping tabs count once across the record.'
      },
      categorizedCoverage: (() => {
        // Two genuinely different ratios. Reporting the time figure under both
        // names made the visit coverage look identical to it by construction.
        const categorizedUrls = new Set(windowMemberships.map(m => m.normalizedUrl));
        const categorizedVisits = visitRows.filter(v => categorizedUrls.has(v.normalizedUrl)).length;
        return {
          pagesAvailable: pageRows.length,
          pagesAnalyzed: categorizedUrls.size,
          visitsCategorized: categorizedVisits,
          visitsInWindow: visitRows.length,
          estimatedActiveMs: categorizedMs,
          estimatedActiveMinutes: msToMinutes(categorizedMs),
          activeTimeCoverage: activeMs ? categorizedMs / activeMs : 0,
          visitCoverage: visitRows.length ? categorizedVisits / visitRows.length : 0
        };
      })(),
      uncoveredTransitions,
      uncategorized: {
        pageCount: uncategorizedPages.length,
        visitCount: uncategorizedPages.reduce((sum, p) => sum + p.visitCount, 0),
        estimatedDwellMs: uncategorizedPages.reduce((sum, p) => sum + p.estimatedDwellMs, 0),
        estimatedDwellMinutes: msToMinutes(uncategorizedPages.reduce((sum, p) => sum + p.estimatedDwellMs, 0)),
        pages: uncategorizedPages,
        pageUrls: uncategorizedPages.map(p => p.id),
        byReason: uncategorizedPages.reduce((acc, page) => {
          acc[page.reason] = (acc[page.reason] || 0) + 1;
          return acc;
        }, {})
      },
      warnings: [
        `Topic claims cover ${Math.round((activeMs ? categorizedMs / activeMs : 0) * 100)}% of estimated browsing time in this window.`,
        uncoveredTransitions
          ? `${uncoveredTransitions} transitions touched a page with no topic and are excluded from the flow counts.`
          : null,
        uncategorizedPages.length
          ? `${uncategorizedPages.length} pages are ungrouped; inspect their recorded evidence for the reason.`
          : null
      ].filter(Boolean)
    };
  }

  return { ATTENTION_BANDS, TRANSITION_TYPES, build };
});
