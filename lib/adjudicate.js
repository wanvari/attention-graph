// Self-consistency adjudication (spec §4.5) with the split-grouping
// agreement fix (§4.6). Each uncertain cluster is asked the same question
// twice, page order reversed the second time. Only agreement counts;
// disagreement always lands pages in the uncategorized bucket — never in a
// user-facing review queue (spec D7).
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'), require('./cluster.js'));
  } else {
    root.CTAdjudicate = factory(root.CTText, root.CTCluster);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText, CTCluster) {
  'use strict';

  const DEFAULTS = {
    confidenceThreshold: 0.68,
    // A cluster whose average internal similarity is below the bar we require
    // to merge two pages in the first place is suspicious by our own standard.
    cohesionThreshold: 0.70,
    maxAdjudications: 4,
    maxPagesPerPrompt: 24,
    splitAgreementThreshold: 0.60
  };

  function pageImportance(page) {
    return (Number(page.visitCount) || 1) * 3 + CTText.msToMinutes(page.dwellMs || 0);
  }

  // The gate fires on the EVIDENCE looking mixed, not on the labeling model
  // admitting doubt (gemma reports ~0.95 for almost everything).
  //
  // "Mixed evidence" means low internal cohesion. v3 used domain diversity as
  // the proxy, which was reasonable for title-only embeddings but inverts with
  // content embeddings: measured on the fixture, honest research topics span
  // 4-5 domains (dominant share ~0.25) while blended pages sit around 0.35,
  // so the domain test gated every real topic and none of the junk. Cohesion
  // separates them cleanly (real 0.79-0.88, ambiguous 0.57, junk 0.50).
  function needsAdjudication(cluster, cfg) {
    if (cluster.label === 'MIXED') return true;
    const multiPage = cluster.pages.length >= 3;
    if (!multiPage) return false;
    const incoherent = Number(cluster.cohesion ?? 1) < cfg.cohesionThreshold;
    const weak = Number(cluster.heuristicConfidence ?? 1) < cfg.confidenceThreshold;
    return incoherent || weak;
  }

  function auditPriority(cluster) {
    return Math.min(
      Number(cluster.heuristicConfidence ?? 1),
      Number(cluster.labelConfidence ?? 1)
    );
  }

  function prompt(cluster, pageRows) {
    return [
      'You are auditing one browser-history topic cluster whose label is low confidence.',
      'Decide one verdict:',
      '- "keep": these pages genuinely belong together as one topic.',
      '- "split": the pages form 2-4 clearly distinct topics. Provide groups.',
      '- "uncategorized": the pages are too mixed to support any honest topic label.',
      'Return JSON only, shaped as {"verdict":"keep|split|uncategorized","label":"short topic label (keep only)","confidence":0.0-1.0,"rationale":"one sentence","groups":[{"label":"short topic label","page_indexes":[0,2]}]}.',
      '"groups" is required only for split, and page_indexes reference the "i" field of the input pages.',
      'Do not invent a theme to avoid saying uncategorized.',
      JSON.stringify({
        current_label: cluster.label,
        keywords: (cluster.keywords || []).slice(0, 10),
        pages: pageRows
      })
    ].join('\n');
  }

  function normalizeVerdict(data) {
    const verdict = String((data && data.verdict) || '').toLowerCase().trim();
    return ['keep', 'split', 'uncategorized'].includes(verdict) ? verdict : null;
  }

  // Convert model groups to member index sets. Reversed pass indexes are
  // un-reversed here. Out-of-range and duplicate indexes are dropped; groups
  // left with < 2 members dissolve into leftovers.
  function groupsToIndexSets(groups, pageCount, reversed) {
    const used = new Set();
    const sets = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const indexes = Array.isArray(group && group.page_indexes) ? group.page_indexes : [];
      const members = [];
      for (const raw of indexes) {
        let index = Number(raw);
        if (!Number.isInteger(index)) continue;
        if (reversed) index = pageCount - 1 - index;
        if (index < 0 || index >= pageCount || used.has(index)) continue;
        used.add(index);
        members.push(index);
      }
      if (members.length >= 2) {
        sets.push({ label: String((group && group.label) || '').slice(0, 48), members });
      } else {
        for (const member of members) used.delete(member);
      }
    }
    return sets;
  }

  // Unordered co-membership pairs "a|b" (a < b) for Jaccard comparison.
  function coMembershipPairs(indexSets) {
    const pairs = new Set();
    for (const set of indexSets) {
      const members = set.members.slice().sort((a, b) => a - b);
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          pairs.add(`${members[i]}|${members[j]}`);
        }
      }
    }
    return pairs;
  }

  function pairJaccard(a, b) {
    if (!a.size && !b.size) return 1; // both passes made no pairs: vacuous agreement
    let intersection = 0;
    for (const pair of a) if (b.has(pair)) intersection++;
    const union = a.size + b.size - intersection;
    return union ? intersection / union : 0;
  }

  function rebuildCluster(pages, label, labelConfidence, rationale) {
    const cohesion = CTCluster.clusterCohesion(pages);
    const conf = CTCluster.heuristicConfidence(pages, cohesion);
    return {
      pages,
      centroid: CTCluster.centroid(pages.map(p => p.embedding), pages.map(p => (Number(p.dwellMs) || 0) + 1)),
      cohesion,
      heuristicConfidence: conf.value,
      dominantDomainShare: conf.dominantDomainShare,
      dwellMs: pages.reduce((sum, p) => sum + (Number(p.dwellMs) || 0), 0),
      keywords: CTText.keywordSummary(pages, 12),
      label,
      labelSource: 'llm',
      labelConfidence,
      rationale,
      adjudication: 'split'
    };
  }

  // Main entry. Returns { clusters, uncategorized: [{page, reason}], summary }.
  async function adjudicateClusters(clusters, client, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const candidates = clusters
      .filter(c => needsAdjudication(c, cfg))
      .sort((a, b) => auditPriority(a) - auditPriority(b))
      .slice(0, cfg.maxAdjudications);
    const candidateSet = new Set(candidates);
    const kept = clusters.filter(c => !candidateSet.has(c));
    const uncategorized = [];
    const summary = { audited: 0, kept: 0, split: 0, uncategorized: 0, disagreed: 0, errors: 0, calls: 0 };

    for (const cluster of candidates) {
      const limited = cluster.pages
        .slice()
        .sort((a, b) => pageImportance(b) - pageImportance(a))
        .slice(0, cfg.maxPagesPerPrompt);
      const beyondPrompt = cluster.pages.filter(page => !limited.includes(page));
      const rows = limited.map((page, i) => ({ i, title: page.title, domain: page.domain }));
      const reversedRows = limited.map((page, i) => ({ title: page.title, domain: page.domain }))
        .reverse()
        .map((row, i) => ({ i, ...row }));

      let first;
      let second;
      try {
        // Sequential on purpose: parallel chat calls would pin the machine.
        summary.calls++;
        first = await client.chatJson(prompt(cluster, rows), 'adjudicate_pass1');
        summary.calls++;
        second = await client.chatJson(prompt(cluster, reversedRows), 'adjudicate_pass2');
      } catch (error) {
        if (error && error.code === 'deferred') throw error;
        // Infrastructure failure is not evidence of a bad cluster.
        summary.errors++;
        kept.push(cluster);
        continue;
      }
      summary.audited++;

      const firstVerdict = normalizeVerdict(first);
      const secondVerdict = normalizeVerdict(second);
      if (!firstVerdict || !secondVerdict || firstVerdict !== secondVerdict) {
        summary.disagreed++;
        for (const page of cluster.pages) uncategorized.push({ page, reason: 'disagreement' });
        continue;
      }

      if (firstVerdict === 'keep') {
        summary.kept++;
        const agreedConfidence = Math.min(
          CTText.clamp(Number(first.confidence) || 0, 0, 1),
          CTText.clamp(Number(second.confidence) || 0, 0, 1)
        );
        kept.push({
          ...cluster,
          label: (first.label || cluster.label) ? String(first.label || cluster.label).slice(0, 48) : undefined,
          labelSource: first.label ? 'llm' : cluster.labelSource,
          labelConfidence: agreedConfidence,
          rationale: String(first.rationale || cluster.rationale || '').slice(0, 500),
          adjudication: 'kept'
        });
        continue;
      }

      if (firstVerdict === 'uncategorized') {
        summary.uncategorized++;
        for (const page of cluster.pages) uncategorized.push({ page, reason: 'agreed_uncategorized' });
        continue;
      }

      // Agreed split: compare GROUPINGS, not just verdicts (§4.6).
      const sets1 = groupsToIndexSets(first.groups, limited.length, false);
      const sets2 = groupsToIndexSets(second.groups, limited.length, true);
      const pairs1 = coMembershipPairs(sets1);
      const pairs2 = coMembershipPairs(sets2);
      const agreement = pairJaccard(pairs1, pairs2);
      if (agreement < cfg.splitAgreementThreshold || sets1.length < 2) {
        summary.disagreed++;
        for (const page of cluster.pages) uncategorized.push({ page, reason: 'disagreement' });
        continue;
      }

      // Pages whose pairing the passes dispute (any pair in the symmetric
      // difference) are pulled out as split leftovers.
      const disputed = new Set();
      for (const pair of pairs1) {
        if (!pairs2.has(pair)) pair.split('|').forEach(i => disputed.add(Number(i)));
      }
      for (const pair of pairs2) {
        if (!pairs1.has(pair)) pair.split('|').forEach(i => disputed.add(Number(i)));
      }

      // Apply pass 1's groups minus disputed pages. Agreement on even one
      // group is worth keeping; only a total wash counts as disagreement.
      const survivingGroups = sets1
        .map(set => ({ ...set, members: set.members.filter(i => !disputed.has(i)) }))
        .filter(set => set.members.length >= 2);
      if (survivingGroups.length === 0) {
        summary.disagreed++;
        for (const page of cluster.pages) uncategorized.push({ page, reason: 'disagreement' });
        continue;
      }

      summary.split++;
      const placed = new Set();
      for (const group of survivingGroups) {
        const pages = group.members.map(i => limited[i]);
        for (const page of pages) placed.add(page);
        kept.push(rebuildCluster(
          pages,
          group.label || undefined,
          CTText.clamp(Number(first.confidence) || 0, 0, 0.9),
          String(first.rationale || 'Split from a mixed cluster during local adjudication.').slice(0, 500)
        ));
      }
      for (const page of limited) {
        if (!placed.has(page)) uncategorized.push({ page, reason: 'split_leftover' });
      }
      for (const page of beyondPrompt) {
        uncategorized.push({ page, reason: 'beyond_budget' });
      }
    }

    return { clusters: kept, uncategorized, summary };
  }

  return {
    DEFAULTS,
    adjudicateClusters,
    coMembershipPairs,
    groupsToIndexSets,
    needsAdjudication,
    normalizeVerdict,
    pairJaccard,
    prompt
  };
});
