// Order-invariant clustering for the v4 pipeline (spec §4.3).
// Average-linkage agglomerative clustering over cosine distance replaces the
// v3 greedy online assigner: shuffling the input must never change the
// partition, because the adjudicator holds the LLM to an order-insensitivity
// standard and the clusterer has to meet the same bar.
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'));
  } else {
    root.CTCluster = factory(root.CTText);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText) {
  'use strict';

  const DEFAULTS = {
    assignThreshold: 0.78,   // new page -> existing registry topic centroid
    clusterThreshold: 0.70,  // new page <-> new page average linkage cut
    maxNewTopicsPerRun: 20,
    thinEvidenceDwellMs: 2 * 60 * 1000,
    thinEvidencePenalty: 0.08
  };

  const MIXED_DOMAIN_PENALTY_WEIGHT = 0.15;

  function isValidVector(vector) {
    if (!vector || !vector.length) return false;
    let sumSq = 0;
    for (let i = 0; i < vector.length; i++) {
      const v = vector[i];
      if (!Number.isFinite(v)) return false;
      sumSq += v * v;
    }
    return sumSq > 0;
  }

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length || !a.length) return 0;
    let dot = 0, aNorm = 0, bNorm = 0;
    for (let i = 0; i < a.length; i++) {
      const av = a[i], bv = b[i];
      dot += av * bv;
      aNorm += av * av;
      bNorm += bv * bv;
    }
    const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
    return denom ? dot / denom : 0;
  }

  function normalize(vector) {
    let sumSq = 0;
    for (let i = 0; i < vector.length; i++) sumSq += vector[i] * vector[i];
    const norm = Math.sqrt(sumSq);
    const out = new Float32Array(vector.length);
    if (!norm) return out;
    for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
    return out;
  }

  // Weighted mean of unit vectors, re-normalized. weights default to 1.
  function centroid(vectors, weights) {
    const valid = [];
    for (let i = 0; i < vectors.length; i++) {
      if (vectors[i] && vectors[i].length) valid.push(i);
    }
    if (!valid.length) return new Float32Array(0);
    const dim = vectors[valid[0]].length;
    const out = new Float32Array(dim);
    let totalWeight = 0;
    for (const i of valid) {
      const w = weights ? Math.max(Number(weights[i]) || 0, 0) : 1;
      if (!w) continue;
      totalWeight += w;
      const vec = vectors[i];
      for (let j = 0; j < dim; j++) out[j] += vec[j] * w;
    }
    if (!totalWeight) return out;
    for (let j = 0; j < dim; j++) out[j] /= totalWeight;
    return normalize(out);
  }

  // Stage 1 of §4.3: try to attach each new page to an existing registry
  // topic. Returns { assigned: Map<topicId, pages[]>, remainder: pages[] }.
  function assignToExistingTopics(pages, topics, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const assigned = new Map();
    const remainder = [];
    const candidates = (topics || []).filter(t => t.centroid && t.centroid.length && t.state !== 'retired');
    for (const page of pages) {
      let best = null;
      let bestScore = -Infinity;
      for (const topic of candidates) {
        const score = cosine(page.embedding, topic.centroid);
        if (score > bestScore || (score === bestScore && best && topic.topicId < best.topicId)) {
          bestScore = score;
          best = topic;
        }
      }
      if (best && bestScore >= cfg.assignThreshold) {
        if (!assigned.has(best.topicId)) assigned.set(best.topicId, []);
        assigned.get(best.topicId).push({ page, score: bestScore });
      } else {
        remainder.push(page);
      }
    }
    return { assigned, remainder };
  }

  // Average-linkage agglomerative clustering, cut at 1 - clusterThreshold.
  // Order invariance: inputs are canonically sorted by normalizedUrl before
  // anything else happens, and every tie-break below is on that stable order,
  // so the caller's input order cannot leak into the result.
  function agglomerate(pagesInput, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const rejected = [];
    const pages = [];
    for (const page of pagesInput || []) {
      if (isValidVector(page.embedding)) pages.push(page);
      else rejected.push(page);
    }
    pages.sort((a, b) => String(a.normalizedUrl).localeCompare(String(b.normalizedUrl)));
    const n = pages.length;
    if (!n) return { clusters: [], rejected };

    // Pairwise cosine matrix once; average linkage over it thereafter.
    const sim = new Array(n);
    for (let i = 0; i < n; i++) sim[i] = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const s = cosine(pages[i].embedding, pages[j].embedding);
        sim[i][j] = s;
        sim[j][i] = s;
      }
    }

    // clusters as arrays of page indexes, identified by smallest member index.
    let clusters = pages.map((_, i) => [i]);
    const linkage = (a, b) => {
      let total = 0;
      for (const i of a) for (const j of b) total += sim[i][j];
      return total / (a.length * b.length);
    };

    for (;;) {
      let bestScore = -Infinity;
      let bestA = -1;
      let bestB = -1;
      for (let a = 0; a < clusters.length; a++) {
        for (let b = a + 1; b < clusters.length; b++) {
          const score = linkage(clusters[a], clusters[b]);
          if (score > bestScore + 1e-12) {
            bestScore = score;
            bestA = a;
            bestB = b;
          }
          // Exact ties resolve to the pair whose smallest member index is
          // lowest — already guaranteed by the scan order (a ascending).
        }
      }
      if (bestA === -1 || bestScore < cfg.clusterThreshold) break;
      clusters[bestA] = clusters[bestA].concat(clusters[bestB]).sort((x, y) => x - y);
      clusters.splice(bestB, 1);
      if (clusters.length === 1) break;
    }

    return {
      clusters: clusters
        .map(members => members.map(i => pages[i]))
        .sort((a, b) => String(a[0].normalizedUrl).localeCompare(String(b[0].normalizedUrl))),
      rejected
    };
  }

  // Heuristic confidence carried from v3. This is a rank signal for the
  // adjudication gate, never a displayed probability (spec D4).
  //
  // The cross-domain term is a small nudge, not a veto (§4.3.4: "content
  // embeddings make domain a weak prior"). v3 weighted it at 0.6, which was
  // right when embeddings saw only titles. Measured on the fixture with
  // content embeddings, domain share does not separate real topics from junk
  // at all — genuine research topics span 4-5 domains (share ~0.25) while
  // blended pages cluster on fewer (share ~0.35) — so at weight 0.6 it pushed
  // every honest multi-domain topic under the audit gate. Cohesion carries
  // that signal instead; see MIXED_DOMAIN_PENALTY_WEIGHT.
  function heuristicConfidence(clusterPages, cohesion) {
    const domains = new Map();
    let visitTotal = 0;
    for (const page of clusterPages) {
      const visits = Number(page.visitCount) || 1;
      visitTotal += visits;
      domains.set(page.domain, (domains.get(page.domain) || 0) + visits);
    }
    const dominant = Math.max(0, ...domains.values());
    const dominantDomainShare = visitTotal ? dominant / visitTotal : 0;
    const mixedDomainPenalty = domains.size >= 2 && dominantDomainShare < 0.75
      ? (0.75 - dominantDomainShare) * MIXED_DOMAIN_PENALTY_WEIGHT
      : 0;
    const thin = clusterPages.length < 3 ? DEFAULTS.thinEvidencePenalty : 0;
    const value = CTText.clamp(
      0.40 + (cohesion ?? 0.55) * 0.42 + Math.min(clusterPages.length, 8) * 0.015 - mixedDomainPenalty - thin,
      0.25,
      0.9
    );
    return { value, cohesion: cohesion ?? 0.55, dominantDomainShare, mixedDomainPenalty };
  }

  function clusterCohesion(clusterPages) {
    if (clusterPages.length < 2) return 0.55;
    let total = 0;
    let count = 0;
    for (let i = 0; i < clusterPages.length; i++) {
      for (let j = i + 1; j < clusterPages.length; j++) {
        total += cosine(clusterPages[i].embedding, clusterPages[j].embedding);
        count++;
      }
    }
    return count ? total / count : 0.55;
  }

  // Full §4.3 treatment of the pages that did not attach to existing topics:
  // agglomerate, route singletons, cap new topics per run.
  function clusterNewPages(pagesInput, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const { clusters, rejected } = agglomerate(pagesInput, cfg);
    const kept = [];
    const thinSingletons = [];
    for (const members of clusters) {
      if (members.length === 1) {
        const page = members[0];
        if ((Number(page.dwellMs) || 0) < cfg.thinEvidenceDwellMs) {
          thinSingletons.push(page);
          continue;
        }
      }
      const cohesion = clusterCohesion(members);
      const conf = heuristicConfidence(members, cohesion);
      kept.push({
        pages: members,
        centroid: centroid(members.map(p => p.embedding), members.map(p => (Number(p.dwellMs) || 0) + 1)),
        cohesion,
        heuristicConfidence: conf.value,
        dominantDomainShare: conf.dominantDomainShare,
        dwellMs: members.reduce((sum, p) => sum + (Number(p.dwellMs) || 0), 0),
        keywords: CTText.keywordSummary(members, 12)
      });
    }
    kept.sort((a, b) => b.dwellMs - a.dwellMs ||
      String(a.pages[0].normalizedUrl).localeCompare(String(b.pages[0].normalizedUrl)));
    const withinBudget = kept.slice(0, cfg.maxNewTopicsPerRun);
    const beyondBudget = kept.slice(cfg.maxNewTopicsPerRun).flatMap(c => c.pages);
    return {
      clusters: withinBudget,
      thinSingletons,
      beyondBudget,
      rejected
    };
  }

  return {
    DEFAULTS,
    MIXED_DOMAIN_PENALTY_WEIGHT,
    agglomerate,
    assignToExistingTopics,
    centroid,
    clusterCohesion,
    clusterNewPages,
    cosine,
    heuristicConfidence,
    isValidVector,
    normalize
  };
});
