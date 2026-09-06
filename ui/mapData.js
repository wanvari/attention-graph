// Registry -> map view-model adapter (spec §5.2). The v4 map keeps the v3
// D3 rendering but reads the persistent registry instead of a snapshot
// analysis: nodes are active topics with dwell in the selected window, edges
// are aggregated transitions, and topic ids are stable so corrections attach
// directly instead of being re-matched by page overlap.
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTMapData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
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

    const [topicRows, memberships, transitionRows, pageRows, metricRows, uncategorizedRows, runRows, visitRows] = await Promise.all([
      store.getAll('topics'),
      store.getAll('memberships'),
      store.getAll('transitions'),
      store.getAll('pages'),
      store.getAll('daily_metrics'),
      store.getAll('uncategorized'),
      store.getAll('runs'),
      store.byIndex('visits', 'byDay', store.range(fromDay, today))
    ]);

    // A membership row carries the page's LIFETIME dwell and visit totals, so
    // summing those for a 7-day window reported months of attention as if it
    // happened this week. Window figures come from the visits actually inside
    // the window instead; memberships only say which topic a page belongs to.
    const windowStatsByUrl = new Map();
    for (const visit of visitRows) {
      const entry = windowStatsByUrl.get(visit.normalizedUrl) ||
        { dwellMs: 0, visitCount: 0, firstSeen: visit.visitTime, lastSeen: visit.visitTime };
      entry.dwellMs += visit.dwellMs || 0;
      entry.visitCount++;
      entry.firstSeen = Math.min(entry.firstSeen, visit.visitTime);
      entry.lastSeen = Math.max(entry.lastSeen, visit.visitTime);
      windowStatsByUrl.set(visit.normalizedUrl, entry);
    }

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
      .filter(topic => topic.state !== 'retired' && evidenceByTopic.has(topic.topicId))
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

    // Aggregate the window's per-day transition rows into edges.
    const topicById = new Map(visibleTopics.map(t => [t.id, t]));
    const edges = new Map();
    for (const row of transitionRows) {
      if (row.day < fromDay) continue;
      if (!topicById.has(row.sourceTopicId) || !topicById.has(row.targetTopicId)) continue;
      const key = `${row.sourceTopicId}->${row.targetTopicId}`;
      const existing = edges.get(key);
      if (!existing) {
        edges.set(key, {
          id: `transition-${CTText.hashString(key)}`,
          sourceTopicId: row.sourceTopicId,
          targetTopicId: row.targetTopicId,
          sourceLabel: topicById.get(row.sourceTopicId).label,
          targetLabel: topicById.get(row.targetTopicId).label,
          similarity: row.similarity ?? 0,
          type: row.type,
          label: (TRANSITION_TYPES[row.type] || TRANSITION_TYPES.topic_switch).label,
          color: (TRANSITION_TYPES[row.type] || TRANSITION_TYPES.topic_switch).color,
          confidence: row.confidence,
          rationale: row.uncertain
            ? 'Local labels disagreed between passes; showing the similarity-based estimate instead.'
            : 'Observed consecutive visits between these topics.',
          visitCount: row.visitCount || 0,
          verified: !!row.verified,
          uncertain: !!row.uncertain,
          llmLabeled: !!row.llmLabeled,
          hourCounts: (row.hourCounts || new Array(24).fill(0)).slice(),
          representativeVisits: [],
          days: [row.day]
        });
        continue;
      }
      existing.visitCount += row.visitCount || 0;
      existing.days.push(row.day);
      for (let hour = 0; hour < 24; hour++) {
        existing.hourCounts[hour] += (row.hourCounts || [])[hour] || 0;
      }
      // A day marked uncertain keeps the aggregate honest.
      if (row.uncertain) existing.uncertain = true;
      if (row.verified) existing.verified = true;
    }
    const transitions = Array.from(edges.values())
      .sort((a, b) => b.visitCount - a.visitCount || b.confidence - a.confidence);

    // Coverage over the window, from the stored daily metrics.
    const windowMetrics = metricRows.filter(m => m.day >= fromDay);
    const activeMs = windowMetrics.reduce((sum, m) => sum + (m.activeMs || 0), 0);
    const categorizedMs = windowMetrics.reduce((sum, m) => sum + (m.activeMs || 0) * (m.categorizedShare || 0), 0);
    const visitCount = windowMetrics.reduce((sum, m) => sum + (m.visitCount || 0), 0);
    const uncoveredTransitions = windowMetrics.reduce((sum, m) => sum + (m.uncoveredTransitions || 0), 0);
    const windowUncategorized = uncategorizedRows.filter(u => u.day >= fromDay);
    const lastOkRun = runRows.filter(r => r.status === 'ok').sort((a, b) => b.startedAt - a.startedAt)[0] || null;

    const uncategorizedPages = windowUncategorized.map(row => {
      const page = pageByUrl.get(row.normalizedUrl);
      return {
        id: row.normalizedUrl,
        title: page ? page.title : row.normalizedUrl,
        url: page ? page.url : row.normalizedUrl,
        domain: page ? page.domain : '',
        reason: row.reason,
        visitCount: page ? page.visitCount : 0,
        estimatedDwellMs: row.dwellMs || 0,
        estimatedDwellMinutes: msToMinutes(row.dwellMs)
      };
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
      ok: visibleTopics.length > 0,
      version: 'cognitive-trails-v4',
      source: 'registry',
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
      models: { embedding: 'bge-m3:latest', chat: 'gemma3:12b' },
      topics: ranked,
      transitions,
      coverage: {
        days: windowDays,
        visitsExpanded: visitCount,
        estimatedActiveMs: activeMs,
        estimatedActiveMinutes: msToMinutes(activeMs),
        startTime: windowMetrics.length ? CTText.dayKeyToNoonMs(windowMetrics[0].day) : null,
        endTime: lastOkRun ? lastOkRun.startedAt : now,
        dwellMethod: 'estimated from gaps between visits (capped at 30 minutes; session-ending visits count 1 minute), lowered by measured active time when a capture matches'
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
        pages: uncategorizedPages.slice(0, 30),
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
          ? `${uncategorizedPages.length} pages were too ambiguous to label and are reported as uncategorized instead of being forced into a topic.`
          : null
      ].filter(Boolean)
    };
  }

  return { ATTENTION_BANDS, TRANSITION_TYPES, build };
});
