// Topic registry: identity across runs, lifecycle, matching (spec §4.7).
// Pure functions over in-memory inputs; the pipeline owns all IndexedDB
// writes so the registry stage can commit atomically.
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'), require('./cluster.js'));
  } else {
    root.CTRegistry = factory(root.CTText, root.CTCluster);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText, CTCluster) {
  'use strict';

  const DEFAULTS = {
    mergeThreshold: 0.80,       // score >= this: cluster merges into topic
    nearMissThreshold: 0.65,    // score in [this, merge): create + record near-miss
    proposalGap: 0.03,          // two existing topics both >= merge within this: propose merge
    centroidWeight: 0.7,
    overlapWeight: 0.3,
    overlapWindowDays: 60,
    dormantAfterDays: 14,
    retireAfterDormantDays: 120,
    retireMaxDwellMs: 30 * 60 * 1000,
    relabelMinConfidence: 0.9,
    relabelMinEditDistance: 0.5
  };

  function levenshtein(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    if (!s.length) return t.length;
    if (!t.length) return s.length;
    let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
    for (let i = 1; i <= s.length; i++) {
      const row = [i];
      for (let j = 1; j <= t.length; j++) {
        row[j] = Math.min(
          prev[j] + 1,
          row[j - 1] + 1,
          prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
        );
      }
      prev = row;
    }
    return prev[t.length];
  }

  function normalizedEditDistance(a, b) {
    const maxLen = Math.max(String(a || '').length, String(b || '').length);
    if (!maxLen) return 0;
    return levenshtein(String(a || '').toLowerCase(), String(b || '').toLowerCase()) / maxLen;
  }

  // score = 0.7 x cosine + 0.3 x page overlap with the topic's recent memberships.
  function matchScore(cluster, topic, recentUrlsByTopic, cfg) {
    const cos = CTCluster.cosine(cluster.centroid, topic.centroid);
    const recent = recentUrlsByTopic.get(topic.topicId) || new Set();
    let overlap = 0;
    for (const page of cluster.pages) {
      if (recent.has(page.normalizedUrl)) overlap++;
    }
    const overlapShare = cluster.pages.length ? overlap / cluster.pages.length : 0;
    return cfg.centroidWeight * cos + cfg.overlapWeight * overlapShare;
  }

  // Decide, for every adjudication-surviving new cluster, whether it merges
  // into an existing topic or becomes a new one. Retired topics are never
  // candidates (an ancient 2-page topic must not absorb new work).
  function matchNewClusters(newClusters, topics, memberships, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const today = cfg.today || CTText.dayKeyFromMs(Date.now());
    const overlapCutoff = CTText.addDays(today, -cfg.overlapWindowDays);
    const candidates = (topics || []).filter(t => t.state === 'active' || t.state === 'dormant');

    const recentUrlsByTopic = new Map();
    for (const membership of memberships || []) {
      if (membership.lastDay < overlapCutoff) continue;
      if (!recentUrlsByTopic.has(membership.topicId)) recentUrlsByTopic.set(membership.topicId, new Set());
      recentUrlsByTopic.get(membership.topicId).add(membership.normalizedUrl);
    }

    const decisions = [];
    for (const cluster of newClusters || []) {
      const scored = candidates
        .map(topic => ({ topic, score: matchScore(cluster, topic, recentUrlsByTopic, cfg) }))
        .sort((a, b) => b.score - a.score || String(a.topic.topicId).localeCompare(String(b.topic.topicId)));
      const best = scored[0] || null;
      const second = scored[1] || null;

      if (best && best.score >= cfg.mergeThreshold) {
        const decision = {
          action: 'merge',
          cluster,
          topicId: best.topic.topicId,
          score: best.score
        };
        // Two existing topics both clearing the bar within 0.03 of each other:
        // membership goes to the higher one, and a merge of the two topics is
        // PROPOSED for the audit page — never executed automatically, because
        // silent merging of mature topics is how registries rot.
        if (second && second.score >= cfg.mergeThreshold && best.score - second.score < cfg.proposalGap) {
          decision.mergeProposal = {
            topicA: best.topic.topicId,
            topicB: second.topic.topicId,
            scoreA: best.score,
            scoreB: second.score
          };
        }
        decisions.push(decision);
      } else if (best && best.score >= cfg.nearMissThreshold) {
        decisions.push({
          action: 'create',
          cluster,
          nearMiss: { topicId: best.topic.topicId, score: best.score },
          lineageParents: [best.topic.topicId]
        });
      } else {
        decisions.push({ action: 'create', cluster, lineageParents: [] });
      }
    }
    return decisions;
  }

  function membershipKey(topicId, normalizedUrl) {
    return `${topicId}|${normalizedUrl}`;
  }

  // Membership stats are RECOMPUTED from the page's authoritative totals, not
  // accumulated. Runs re-ingest a 2 h overlap window by design (§4.1), so
  // adding this run's dwell to the stored row counted the same browsing again
  // on every overlapping run — inflating topic dwell without bound while the
  // day metrics, which read the idempotent `visits` store, stayed correct.
  // `pageTotals` carries each page's totals over all stored visits.
  function buildMembershipRows(topicId, cluster, existingByKey, runId, pageTotals) {
    const rows = [];
    for (const page of cluster.pages) {
      const existing = existingByKey.get(membershipKey(topicId, page.normalizedUrl));
      const totals = (pageTotals && pageTotals.get(page.normalizedUrl)) || {
        dwellMs: Number(page.dwellMs) || 0,
        activeMs: Number(page.activeMs) || 0,
        visitCount: Number(page.visitCount) || 0,
        firstDay: page.firstDay,
        lastDay: page.lastDay
      };
      const firstDay = totals.firstDay || page.firstDay;
      const lastDay = totals.lastDay || page.lastDay;
      rows.push({
        topicId,
        normalizedUrl: page.normalizedUrl,
        firstDay: existing && existing.firstDay < firstDay ? existing.firstDay : firstDay,
        lastDay: existing && existing.lastDay > lastDay ? existing.lastDay : lastDay,
        dwellMs: Number(totals.dwellMs) || 0,
        activeMs: Number(totals.activeMs) || 0,
        visitCount: Number(totals.visitCount) || 0,
        assignedRunId: runId,
        score: page.assignScore ?? cluster.matchScore ?? null
      });
    }
    return rows;
  }

  // Count paused days strictly inside (fromDay, toDay].
  function pausedDaysBetween(fromDay, toDay, pausedDays) {
    if (!pausedDays || !pausedDays.size) return 0;
    let count = 0;
    const span = CTText.diffDays(fromDay, toDay);
    for (let i = 1; i <= span; i++) {
      if (pausedDays.has(CTText.addDays(fromDay, i))) count++;
    }
    return count;
  }

  // Apply match decisions: returns { topicRows, membershipRows, events } for
  // one atomic registryCommit. Existing state comes in via topicsById and
  // membershipsByKey; nothing is mutated in place.
  function applyMatches(decisions, topicsById, membershipsByKey, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const runId = cfg.runId || 'run-unknown';
    const now = cfg.now || Date.now();
    const today = cfg.today || CTText.dayKeyFromMs(now);
    const pausedDays = cfg.pausedDays || new Set();
    const pageTotals = cfg.pageTotals || new Map();
    let createdSequence = 0;
    const newTopicId = cfg.newTopicId || (() => `t-${now.toString(36)}-${(++createdSequence).toString(36)}`);

    const topicRows = new Map();
    const membershipRows = [];
    const events = [];
    const proposalsSeen = new Set();
    const mergeCounts = new Map();

    // Dwell this run genuinely ADDS for a cluster: the page's authoritative
    // total minus whatever the stored membership already accounted for. Using
    // the raw total would over-weight pages that have been in the topic for
    // weeks every time they are revisited.
    const newDwellFor = (topicId, pages) => pages.reduce((sum, page) => {
      const totals = pageTotals.get(page.normalizedUrl);
      const total = totals ? Number(totals.dwellMs) || 0 : Number(page.dwellMs) || 0;
      const existing = topicId ? membershipsByKey.get(membershipKey(topicId, page.normalizedUrl)) : null;
      return sum + Math.max(0, total - (existing ? Number(existing.dwellMs) || 0 : 0));
    }, 0);

    for (const decision of decisions) {
      const cluster = decision.cluster;
      const clusterDwell = newDwellFor(decision.action === 'merge' ? decision.topicId : null, cluster.pages);
      const lastDay = cluster.pages.reduce((max, p) => p.lastDay > max ? p.lastDay : max, cluster.pages[0].lastDay);

      if (decision.action === 'merge') {
        const base = topicRows.get(decision.topicId) || topicsById.get(decision.topicId);
        const oldDwell = Number(base.totalDwellMs) || 0;
        // Dwell-weighted centroid update: one big new day cannot drag a
        // mature topic's centroid.
        const mergedCentroid = CTCluster.centroid(
          [base.centroid, cluster.centroid],
          [Math.max(oldDwell, 1), Math.max(clusterDwell, 1)]
        );
        const updated = {
          ...base,
          centroid: mergedCentroid,
          lastActiveDay: base.lastActiveDay && base.lastActiveDay > lastDay ? base.lastActiveDay : lastDay,
          lastActiveAt: Math.max(Number(base.lastActiveAt) || 0, now)
        };
        if (base.state === 'dormant') {
          const dormantDays = base.lastActiveDay
            ? CTText.diffDays(base.lastActiveDay, today) - pausedDaysBetween(base.lastActiveDay, today, pausedDays)
            : 0;
          updated.state = 'active';
          updated.dormantSince = null;
          events.push({ topicId: base.topicId, day: today, runId, type: 'revived', detail: { dormantDays } });
        } else {
          updated.state = 'active';
        }
        // Relabel only when the evidence is strong and the user has not
        // corrected the label; the old label survives as an alias keyword.
        const newLabel = cluster.label;
        if (
          newLabel && !base.userCorrected &&
          Number(cluster.labelConfidence) > cfg.relabelMinConfidence &&
          normalizedEditDistance(base.label, newLabel) > cfg.relabelMinEditDistance
        ) {
          updated.keywords = Array.from(new Set([...(base.keywords || []), base.label]));
          updated.label = newLabel;
          events.push({
            topicId: base.topicId, day: today, runId, type: 'relabeled',
            detail: { from: base.label, to: newLabel }
          });
        }
        topicRows.set(base.topicId, updated);
        mergeCounts.set(base.topicId, (mergeCounts.get(base.topicId) || 0) + 1);
        membershipRows.push(...buildMembershipRows(base.topicId, { ...cluster, matchScore: decision.score }, membershipsByKey, runId, pageTotals));

        if (decision.mergeProposal) {
          const key = [decision.mergeProposal.topicA, decision.mergeProposal.topicB].sort().join('|');
          if (!proposalsSeen.has(key)) {
            proposalsSeen.add(key);
            events.push({
              topicId: decision.mergeProposal.topicA, day: today, runId, type: 'merged',
              detail: { proposal: true, ...decision.mergeProposal }
            });
          }
        }
      } else {
        const topicId = newTopicId(cluster);
        const row = {
          topicId,
          label: cluster.label || cluster.keywords.slice(0, 2).map(k => k.charAt(0).toUpperCase() + k.slice(1)).join(' ') || 'Browsing topic',
          labelSource: cluster.labelSource || 'keywords',
          centroid: cluster.centroid,
          dim: cluster.centroid ? cluster.centroid.length : 0,
          state: 'active',
          createdAt: now,
          createdRunId: runId,
          lastActiveDay: lastDay,
          lastActiveAt: now,
          dormantSince: null,
          confidence: Number(cluster.labelConfidence) || cluster.heuristicConfidence || 0.5,
          heuristicConfidence: cluster.heuristicConfidence ?? 0.5,
          adjudication: cluster.adjudication || null,
          keywords: cluster.keywords || [],
          rationale: cluster.rationale || 'Grouped locally from content-embedding similarity.',
          userCorrected: false,
          totalDwellMs: clusterDwell,
          lineage: {
            parents: decision.lineageParents || [],
            children: [],
            reason: 'origin'
          }
        };
        topicRows.set(topicId, row);
        membershipRows.push(...buildMembershipRows(topicId, cluster, membershipsByKey, runId, pageTotals));
        events.push({
          topicId, day: today, runId, type: 'created',
          detail: decision.nearMiss ? { nearMiss: decision.nearMiss.topicId, score: decision.nearMiss.score } : {}
        });
      }
    }

    // Topic dwell is the sum over its memberships, recomputed — never a
    // running total, for the same idempotency reason as the rows themselves.
    const rowsByTopic = new Map();
    for (const row of membershipRows) {
      if (!rowsByTopic.has(row.topicId)) rowsByTopic.set(row.topicId, new Map());
      rowsByTopic.get(row.topicId).set(row.normalizedUrl, row);
    }
    for (const [topicId, topic] of topicRows) {
      const merged = new Map();
      for (const membership of membershipsByKey.values()) {
        if (membership.topicId === topicId) merged.set(membership.normalizedUrl, membership);
      }
      for (const [url, row] of rowsByTopic.get(topicId) || []) merged.set(url, row);
      let total = 0;
      for (const membership of merged.values()) total += Number(membership.dwellMs) || 0;
      topicRows.set(topicId, { ...topic, totalDwellMs: total });
    }

    // Multiple new clusters absorbed by one topic in a single run is worth a
    // record (spec: "merge both... emit one event"); a lone routine merge is not.
    for (const [topicId, count] of mergeCounts) {
      if (count >= 2) {
        events.push({ topicId, day: today, runId, type: 'merged', detail: { proposal: false, absorbedClusters: count } });
      }
    }

    return { topicRows: Array.from(topicRows.values()), membershipRows, events };
  }

  // Lifecycle sweep (spec §4.7): dormancy, revival is handled at merge time,
  // retirement. Paused days do not count toward dormancy.
  function lifecycleSweep(topics, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const today = cfg.today || CTText.dayKeyFromMs(Date.now());
    const runId = cfg.runId || 'run-unknown';
    const pausedDays = cfg.pausedDays || new Set();
    const pageTotals = cfg.pageTotals || new Map();
    const updated = [];
    const events = [];

    for (const topic of topics || []) {
      if (topic.state === 'retired' || !topic.lastActiveDay) continue;
      const rawDays = CTText.diffDays(topic.lastActiveDay, today);
      const paused = pausedDaysBetween(topic.lastActiveDay, today, pausedDays);
      const dormantDays = rawDays - paused;

      if (topic.state === 'active' && dormantDays >= cfg.dormantAfterDays) {
        // The event is dated to the day the threshold crossed, not run day.
        const crossedDay = CTText.addDays(topic.lastActiveDay, cfg.dormantAfterDays + paused);
        updated.push({ ...topic, state: 'dormant', dormantSince: CTText.dayKeyToNoonMs(crossedDay) });
        events.push({
          topicId: topic.topicId, day: crossedDay, runId, type: 'dormant',
          detail: { lastActiveDay: topic.lastActiveDay }
        });
        continue;
      }

      if (
        topic.state === 'dormant' &&
        dormantDays >= cfg.retireAfterDormantDays &&
        (Number(topic.totalDwellMs) || 0) < cfg.retireMaxDwellMs &&
        !topic.userCorrected
      ) {
        updated.push({ ...topic, state: 'retired' });
        events.push({
          topicId: topic.topicId, day: today, runId, type: 'retired',
          detail: { dormantDays, totalDwellMs: Number(topic.totalDwellMs) || 0 }
        });
      }
    }
    return { updatedTopics: updated, events };
  }

  return {
    DEFAULTS,
    applyMatches,
    buildMembershipRows,
    levenshtein,
    lifecycleSweep,
    matchNewClusters,
    matchScore,
    membershipKey,
    normalizedEditDistance,
    pausedDaysBetween
  };
});
