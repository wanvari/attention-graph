// Rebuild replaceable totals from retained observations. Raw records and user
// choices survive; missing historical measurements cannot be reconstructed.
(function(root, factory) {
  const api = typeof module !== 'undefined' && module.exports
    ? factory(require('./trails.js'), require('./cluster.js')) : factory(root.CTTrails, root.CTCluster);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTIntegrity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Trails, Cluster) {
  'use strict';
  const TABLES = ['visits', 'captures', 'pages', 'topics', 'memberships', 'corrections', 'settings', 'embeddings'];
  function rebuild(snapshot, now = Date.now()) {
    const record = Trails.buildRecord(snapshot, { now });
    const byPage = new Map(), byEvent = new Map(record.events.map(e => [e.id, e]));
    const audit = { version: 2, checkedAt: now, changedPages: 0, changedVisits: 0, removedMemberships: 0, changedTopics: 0, utilityMembershipsRemoved: 0,
      conflictingPages: record.events.filter(e => e.groupingReason === 'conflicting-owners').length,
      historyOnlyVisits: record.events.filter(e => !e.measured).length, estimatedMs: record.estimatedMs };
    for (const event of record.events) {
      const entry = byPage.get(event.normalizedUrl) || { events: [], dwellMs: 0, activeMs: 0 };
      entry.events.push(event); entry.dwellMs += event.dwellMs;
      if (event.measured) entry.activeMs += event.dwellMs;
      byPage.set(event.normalizedUrl, entry);
    }
    const visits = (snapshot.visits || []).map(v => {
      const event = byEvent.get(String(v.visitId));
      const dwellMs = event ? event.dwellMs : 0;
      if (dwellMs !== v.dwellMs) audit.changedVisits++;
      return { ...v, gapDwellMs: v.gapDwellMs ?? v.dwellMs, dwellMs,
        captureId: event?.captureId || v.captureId || null, timingMethod: event?.timingMethod || 'unknown' };
    });
    const pages = (snapshot.pages || []).map(p => {
      const evidence = byPage.get(p.normalizedUrl);
      const events = evidence?.events || [];
      const changed = p.dwellMs !== (evidence?.dwellMs || 0) || p.visitCount !== events.length;
      if (changed) audit.changedPages++;
      const grouped = events.some(e => e.topicIds.length);
      const reason = events[0]?.groupingReason;
      const mustExclude = ['utility_page', 'limited-evidence', 'operational-page', 'conflicting-owners', 'your-choice'].includes(reason) && !grouped;
      return { ...p, dwellMs: evidence?.dwellMs || 0, activeMs: evidence?.activeMs || 0, visitCount: events.length,
        ...(changed || grouped && p.classificationReason ? { metricsDirty: true } : {}),
        ...(grouped ? { classificationStatus: 'categorized', classificationReason: null, needsClassification: false } : {}),
        ...(mustExclude ? { classificationStatus: 'excluded', classificationReason: reason, needsClassification: reason === 'conflicting-owners' } : {}) };
    });
    const pageMap = new Map(pages.map(p => [p.normalizedUrl, p]));
    const memberships = [];
    for (const [url, evidence] of byPage) {
      const topicId = evidence.events[0].topicIds[0];
      if (!topicId) continue;
      const prior = (snapshot.memberships || []).find(m => m.normalizedUrl === url && m.topicId === topicId) || {};
      memberships.push({ ...prior, topicId, normalizedUrl: url, dwellMs: evidence.dwellMs, activeMs: evidence.activeMs,
        visitCount: evidence.events.length, firstDay: evidence.events[0].day, lastDay: evidence.events[evidence.events.length - 1].day,
        userCorrected: record.overrides.has(url) });
    }
    const keys = new Set(memberships.map(m => `${m.topicId}\n${m.normalizedUrl}`));
    const removeMemberships = (snapshot.memberships || []).filter(m => !keys.has(`${m.topicId}\n${m.normalizedUrl}`)).map(m => [m.topicId, m.normalizedUrl]);
    audit.removedMemberships = removeMemberships.length;
    audit.utilityMembershipsRemoved = removeMemberships.filter(([, url]) => byPage.get(url)?.events[0]?.groupingReason === 'utility_page').length;
    const removedTopics = new Set(removeMemberships.map(([id]) => id));
    const embeddings = new Map((snapshot.embeddings || []).map(e => [e.key, e]));
    const topics = (snapshot.topics || []).map(t => {
      const members = memberships.filter(m => m.topicId === t.topicId);
      const total = members.reduce((n, m) => n + m.dwellMs, 0);
      const result = { ...t, totalDwellMs: total };
      if (t.state === 'retired' && members.some(m => m.userCorrected)) { result.state = 'active'; result.needsRebuild = true; }
      if (total !== t.totalDwellMs) audit.changedTopics++;
      if (removedTopics.has(t.topicId) || t.needsRebuild) {
        if (!members.length) result.state = 'retired';
        else {
          const vectors = [], weights = [];
          for (const m of members) {
            const row = embeddings.get(pageMap.get(m.normalizedUrl)?.embeddingKey);
            if (!row || t.embeddingModel && row.model !== t.embeddingModel) continue;
            const vector = row.vector instanceof ArrayBuffer ? new Float32Array(row.vector) : row.vector;
            if (Cluster.isValidVector(vector)) { vectors.push(vector); weights.push(Math.max(m.dwellMs, 1)); }
          }
          if (vectors.length === members.length && vectors.length && vectors.every(v => v.length === vectors[0].length)) { result.centroid = Cluster.centroid(vectors, weights).buffer; result.needsRebuild = false; }
          else result.needsRebuild = true;
        }
      }
      return result;
    });
    return { visits, pages, memberships, removeMemberships, topics, audit };
  }
  async function repair(store, options = {}) {
    return store.updateEvidence(snapshot => {
      const settings = Object.fromEntries((snapshot.settings || []).map(r => [r.key, r.value]));
      if (options.once && settings.evidenceRepairVersion === 2) return {};
      if (options.correction) snapshot.corrections = (snapshot.corrections || []).filter(r => r.correctionId !== options.correction.correctionId).concat(options.correction);
      const result = rebuild(snapshot, options.now);
      result.corrections = options.correction ? [options.correction] : [];
      result.settings = [{ key: 'evidenceRepairVersion', value: 2 }, { key: 'evidenceAudit', value: result.audit }];
      return result;
    });
  }
  return { TABLES, rebuild, repair };
});
