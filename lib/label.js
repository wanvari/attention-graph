// Topic and transition labeling prompts + parsers (spec §4.4, §4.8).
// Carried from v3; v4 adds the MIXED escape hatch so the model is never
// forced to invent a theme (a later adjudication step handles MIXED).
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'));
  } else {
    root.CTLabel = factory(root.CTText);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText) {
  'use strict';

  const DEFAULTS = {
    labelBatchSize: 6,
    pagesPerCluster: 4,
    textCharsPerPage: 120,
    transitionLabelLimit: 20
  };

  function formatUrl(url) {
    return String(url || '').replace(/^https?:\/\//, '').slice(0, 120);
  }

  // ---- topic labels (§4.4) --------------------------------------------

  function clusterPayload(cluster, index, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    return {
      id: `c${index}`,
      keywords: (cluster.keywords || []).slice(0, 10),
      top_domains: Array.from(new Set(cluster.pages.map(p => p.domain))).slice(0, 5),
      estimated_minutes: CTText.msToMinutes(cluster.dwellMs || 0),
      pages: cluster.pages.slice(0, cfg.pagesPerCluster).map(page => ({
        title: page.title,
        url: formatUrl(page.url || page.normalizedUrl),
        text: String(page.text || '').slice(0, cfg.textCharsPerPage)
      }))
    };
  }

  function labelPrompt(batchPayload) {
    return [
      'Label these browser-history topic clusters.',
      'Return JSON shaped as {"topics":[{"id":"c0","label":"short noun phrase","confidence":0.0-1.0,"rationale":"one sentence explaining why these pages belong together"}]}.',
      'Use specific labels. If the pages share no honest theme, label it \'MIXED\' — a later step will handle it.',
      JSON.stringify(batchPayload)
    ].join('\n\n');
  }

  // Label only NEW clusters (matched pages inherit their topic's label).
  // Mutates nothing; returns new cluster objects.
  async function labelClusters(clusters, client, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    if (!clusters.length) return { clusters: [], calls: 0 };
    const labeled = clusters.map(cluster => ({ ...cluster }));
    let calls = 0;
    for (let i = 0; i < labeled.length; i += cfg.labelBatchSize) {
      const batch = labeled.slice(i, i + cfg.labelBatchSize);
      const payload = batch.map((cluster, j) => clusterPayload(cluster, i + j, cfg));
      let data;
      try {
        calls++;
        data = await client.chatJson(labelPrompt(payload), 'label_topics');
      } catch (error) {
        // A malformed response costs only this batch its labels; an Ollama
        // transport failure fails the run (spec §1.2 vs §7.2).
        if (error && error.code === 'parse') {
          for (const cluster of batch) {
            cluster.labelSource = cluster.labelSource || 'keywords';
          }
          continue;
        }
        throw error;
      }
      const byId = new Map((Array.isArray(data.topics) ? data.topics : [])
        .map(item => [String(item.id || ''), item]));
      batch.forEach((cluster, j) => {
        const item = byId.get(`c${i + j}`);
        if (!item || !item.label) {
          cluster.labelSource = cluster.labelSource || 'keywords';
          return;
        }
        cluster.label = String(item.label).slice(0, 48);
        cluster.labelSource = 'llm';
        // Stored but never used for gating: gemma self-reports ~0.95 for
        // nearly everything (spec §4.4).
        cluster.labelConfidence = CTText.clamp(Number(item.confidence) || 0, 0, 1);
        cluster.rationale = String(item.rationale || '').slice(0, 500);
      });
    }
    return { clusters: labeled, calls };
  }

  // ---- transition labels (§4.8) ---------------------------------------

  const TRANSITION_TYPES = new Set(['same_topic_flow', 'adjacent_topic_jump', 'topic_switch']);

  function normalizeTransitionType(type) {
    const value = String(type || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (TRANSITION_TYPES.has(value)) return value;
    if (value.includes('adjacent')) return 'adjacent_topic_jump';
    if (value.includes('switch')) return 'topic_switch';
    return null;
  }

  function transitionPayload(rows, topicsById) {
    return rows.map(row => ({
      id: `${row.sourceTopicId}->${row.targetTopicId}`,
      source_topic: (topicsById.get(row.sourceTopicId) || {}).label || row.sourceTopicId,
      target_topic: (topicsById.get(row.targetTopicId) || {}).label || row.targetTopicId,
      visit_count: row.visitCount,
      examples: (row.examples || []).slice(0, 3)
    }));
  }

  // One label call over today's top cross-topic transitions.
  async function labelTransitions(rows, topicsById, client) {
    const candidates = rows
      .filter(row => row.sourceTopicId !== row.targetTopicId)
      .sort((a, b) => b.visitCount - a.visitCount)
      .slice(0, DEFAULTS.transitionLabelLimit);
    if (!candidates.length) return { rows, calls: 0 };
    const prompt = [
      'Classify these observed topic transitions from browser history.',
      'Allowed type values: adjacent_topic_jump, topic_switch.',
      'Return JSON shaped as {"transitions":[{"id":"copied id","type":"adjacent_topic_jump|topic_switch","confidence":0.0-1.0,"rationale":"one sentence"}]}.',
      'Copy every id exactly from the input. Do not invent or shorten ids.',
      'Judge only what the titles show. Do not infer the reader\'s intent, task, or purpose.',
      'Use adjacent_topic_jump when the subject matter of the two pages plainly continues — shared entities, terms, or subject.',
      'Use topic_switch when the subject matter does not carry over.',
      JSON.stringify(transitionPayload(candidates, topicsById))
    ].join('\n\n');
    let data;
    try {
      data = await client.chatJson(prompt, 'label_transitions');
    } catch {
      return { rows, calls: 1 };
    }
    const verdicts = new Map((Array.isArray(data.transitions) ? data.transitions : [])
      .map(item => [String(item.id || ''), item]));
    const out = rows.map(row => {
      const verdict = verdicts.get(`${row.sourceTopicId}->${row.targetTopicId}`);
      const type = normalizeTransitionType(verdict && verdict.type);
      if (!verdict || !type || row.sourceTopicId === row.targetTopicId) return row;
      return {
        ...row,
        type,
        confidence: CTText.clamp(Number(verdict.confidence) || row.confidence, 0, 1),
        llmLabeled: true
      };
    });
    return { rows: out, calls: 1 };
  }

  // One verification call over borderline LLM-labeled transitions.
  // Agreement boosts confidence; disagreement falls back to the similarity
  // heuristic, marked uncertain — the user never arbitrates (spec D7).
  async function verifyBorderlineTransitions(rows, topicsById, client, options) {
    const cfg = { adjacentTopicThreshold: 0.58, maxVerifications: 12, ...(options || {}) };
    const isBorderline = row => row.sourceTopicId !== row.targetTopicId && row.llmLabeled &&
      (row.confidence < 0.7 || Math.abs((row.similarity ?? 0) - cfg.adjacentTopicThreshold) < 0.08);
    const candidates = rows.filter(isBorderline).slice(0, cfg.maxVerifications);
    if (!candidates.length) return { rows, calls: 0 };
    const prompt = [
      'Re-classify these observed topic transitions from browser history.',
      'Allowed type values: adjacent_topic_jump, topic_switch.',
      'Return JSON shaped as {"transitions":[{"id":"copied id","type":"adjacent_topic_jump|topic_switch","confidence":0.0-1.0}]}.',
      'Copy every id exactly from the input.',
      'Use adjacent_topic_jump when the subject matter plainly continues between the two pages. Judge the titles, not the reader\'s purpose.',
      JSON.stringify(transitionPayload(candidates.slice().reverse(), topicsById))
    ].join('\n\n');
    let data;
    try {
      data = await client.chatJson(prompt, 'verify_transitions');
    } catch {
      return { rows, calls: 1 }; // verification is best-effort
    }
    const verdicts = new Map((Array.isArray(data.transitions) ? data.transitions : [])
      .map(item => [String(item.id || ''), item]));
    const candidateIds = new Set(candidates.map(row => `${row.sourceTopicId}->${row.targetTopicId}`));
    const out = rows.map(row => {
      const id = `${row.sourceTopicId}->${row.targetTopicId}`;
      if (!candidateIds.has(id)) return row;
      const verdict = verdicts.get(id);
      const verdictType = normalizeTransitionType(verdict && verdict.type);
      if (verdictType && verdictType === row.type) {
        return {
          ...row,
          confidence: CTText.clamp(Math.max(row.confidence, Number(verdict.confidence) || 0), 0, 0.95),
          verified: true
        };
      }
      const fallbackType = row.sourceTopicId === row.targetTopicId
        ? 'same_topic_flow'
        : (row.similarity ?? 0) >= cfg.adjacentTopicThreshold ? 'adjacent_topic_jump' : 'topic_switch';
      return {
        ...row,
        type: fallbackType,
        confidence: Math.min(row.confidence, 0.45),
        llmLabeled: false,
        uncertain: true
      };
    });
    return { rows: out, calls: 1 };
  }

  return {
    DEFAULTS,
    clusterPayload,
    labelClusters,
    labelPrompt,
    labelTransitions,
    normalizeTransitionType,
    verifyBorderlineTransitions
  };
});
