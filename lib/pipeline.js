// Pipeline orchestrator (spec §3.4, §4). The only module that calls all the
// others. Computes in memory and commits per stage; a failed run never moves
// the watermark and never partially writes the registry.
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./text.js'), require('./privacy.js'), require('./store.js'),
      require('./history.js'), require('./cluster.js'), require('./label.js'),
      require('./adjudicate.js'), require('./registry.js'), require('./metrics.js'),
      require('./brief.js')
    );
  } else {
    root.CTPipeline = factory(
      root.CTText, root.CTPrivacy, root.CTStore, root.CTHistory, root.CTCluster,
      root.CTLabel, root.CTAdjudicate, root.CTRegistry, root.CTMetrics, root.CTBrief
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(
  CTText, CTPrivacy, CTStore, CTHistory, CTCluster, CTLabel, CTAdjudicate, CTRegistry, CTMetrics, CTBrief
) {
  'use strict';

  const DEFAULTS = {
    days: 28,                    // first-run ingest horizon
    maxNewPagesPerRun: 300,
    maxResults: 5000,
    watermarkOverlapMs: 2 * 3600 * 1000,
    heartbeatMs: 10 * 1000,
    chatRegrowthShare: 0.3       // llm_chat re-embed only when text grew > 30%
  };

  function embeddingInput(page) {
    if (page.captureText) {
      return `${page.title}\n${page.domain}\n${page.captureText.slice(0, 1500)}`;
    }
    return `${page.title}\n${page.domain}\n${CTText.urlTokens(page.url)}`;
  }

  function embeddingKeyFor(model, input) {
    // Same scheme as v3 (`model|hash(text[:2000])`) so the migrated cache hits.
    return `${model}|${CTText.hashString(String(input).slice(0, 2000))}`;
  }

  function createPipeline(deps) {
    const { store, historyProvider, ollama } = deps;
    // Two clocks, deliberately. `nowFn` is SEMANTIC time — it decides day keys
    // and the watermark, and tests inject it to replay fixture dates. Liveness
    // and durations must use real wall-clock time regardless, or a replayed
    // run reports zero-length stages and never appears to heartbeat.
    const nowFn = deps.now || (() => Date.now());
    const wallNow = () => Date.now();
    const cfg = { ...DEFAULTS, ...(deps.settings || {}) };

    async function run(options) {
      const opts = options || {};
      const startedAt = nowFn();
      const wallStartedAt = wallNow();
      const runId = opts.runId || `run-${startedAt.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      const counts = {
        visitsIngested: 0, pagesEmbedded: 0, embeddingsCached: 0, pagesDeferred: 0,
        topicsCreated: 0, topicsMatched: 0, adjudicated: 0, kept: 0, split: 0,
        uncategorized: 0, disagreed: 0, errors: 0
      };
      const timingsMs = {};
      const warnings = [];
      let stage = 'ingest';
      let heartbeatTimer = null;

      const settings = await store.getSettingsMap();
      const watermarkBefore = Number(settings.watermark) || 0;
      const runRow = {
        runId, startedAt, finishedAt: null, status: 'running', stage,
        heartbeat: wallStartedAt, watermarkBefore, watermarkAfter: null,
        counts, timingsMs,
        ollama: { embedModel: ollama.cfg.embeddingModel, chatModel: ollama.cfg.chatModel, calls: 0, tokensApprox: 0 },
        error: null, warnings, trigger: opts.trigger || 'manual'
      };
      const saveRun = () => store.put('runs', { ...runRow, heartbeat: wallNow() });
      await saveRun();
      heartbeatTimer = setInterval(saveRun, cfg.heartbeatMs);
      if (heartbeatTimer.unref) heartbeatTimer.unref();

      const setStage = async name => { stage = name; runRow.stage = name; await saveRun(); };
      const timed = async (name, fn) => {
        const t0 = wallNow();
        await setStage(name);
        const result = await fn();
        timingsMs[name] = wallNow() - t0;
        return result;
      };

      const today = CTText.dayKeyFromMs(startedAt);
      const priorOkRuns = (await store.getAll('runs')).filter(r => r.status === 'ok' && r.runId !== runId);
      const firstRun = priorOkRuns.length === 0;

      try {
        const pauseIntervals = settings.pauseIntervals || [];
        const denylist = settings.denylist || null;
        const llmChatDomains = settings.llmChatDomains || null;
        const pausedDays = CTPrivacy.fullyPausedDays(pauseIntervals, CTText.dayKeyFromMs);

        // ---- stage 1: ingest (idempotent commit) -----------------------
        const since = watermarkBefore
          ? watermarkBefore - cfg.watermarkOverlapMs
          : startedAt - cfg.days * 24 * 3600 * 1000;

        const { events, capturesByUrl } = await timed('ingest', async () => {
          const { historyItems, visitMap } = await CTHistory.expandVisits(historyProvider, {
            since, maxResults: cfg.maxResults, denylist
          });
          const captureRows = (await store.getAll('captures'))
            .filter(c => Number(c.startedAt) >= since - 90 * 1000);
          const visitEvents = CTHistory.buildVisitEvents(historyItems, visitMap, {
            since, pauseIntervals, denylist, llmChatDomains, captures: captureRows
          });
          counts.visitsIngested = visitEvents.length;

          await store.bulkPut('visits', visitEvents.map(e => ({
            visitId: e.visitId, url: e.url, normalizedUrl: e.normalizedUrl, title: e.title,
            domain: e.domain, visitTime: e.visitTime, transition: e.transition,
            sessionId: e.sessionId, dwellMs: e.dwellMs, endsSession: e.endsSession,
            dayKey: e.dayKey, source: e.source
          })));

          // Recompute page aggregates for affected URLs from ALL stored
          // visits (idempotent under the 2 h overlap re-ingest).
          const affectedUrls = Array.from(new Set(visitEvents.map(e => e.normalizedUrl)));
          const byUrl = new Map();
          for (const capture of captureRows) {
            const list = byUrl.get(capture.normalizedUrl) || [];
            list.push(capture);
            byUrl.set(capture.normalizedUrl, list);
          }
          const pageRows = [];
          for (const url of affectedUrls) {
            const urlVisits = await store.byIndex('visits', 'byNormUrl', url);
            if (!urlVisits.length) continue;
            const existing = await store.get('pages', url);
            // Every capture for this URL, not only the ones in the overlap
            // window: an incremental run that saw one recent capture would
            // otherwise rewrite the page's lifetime active time down to it.
            const captures = (await store.byIndex('captures', 'byNormUrl', url))
                .sort((a, b) => b.startedAt - a.startedAt);
            const latestWithText = captures.find(c => c.textLength > 0);
            const last = urlVisits.reduce((a, b) => (a.visitTime > b.visitTime ? a : b));
            pageRows.push({
              normalizedUrl: url,
              url: last.url,
              title: last.title,
              domain: last.domain,
              source: captures[0] ? captures[0].source : last.source,
              firstSeen: Math.min(...urlVisits.map(v => v.visitTime), existing ? existing.firstSeen : Infinity),
              lastSeen: Math.max(...urlVisits.map(v => v.visitTime)),
              visitCount: urlVisits.length,
              dwellMs: urlVisits.reduce((sum, v) => sum + (v.dwellMs || 0), 0),
              activeMs: captures.reduce((sum, c) => sum + (c.activeMs || 0), 0),
              latestTextHash: latestWithText ? latestWithText.textHash : (existing ? existing.latestTextHash : null),
              latestTextLength: latestWithText ? latestWithText.textLength : (existing ? existing.latestTextLength : 0),
              embeddingKey: existing ? existing.embeddingKey : null,
              embeddingVariant: existing ? existing.embeddingVariant : null,
              // Stored visit titles are already cleaned (fallback-filled), so
              // only the raw-title flag from this run's events — or a prior
              // run's verdict — can prove the page ever had a real title.
              hadTitle: visitEvents.some(e => e.normalizedUrl === url && e.hadTitle) ||
                Boolean(existing && existing.hadTitle)
            });
          }
          await store.bulkPut('pages', pageRows);
          return { events: visitEvents, capturesByUrl: byUrl };
        });

        // ---- stage 2: embed (idempotent commit) ------------------------
        const uncategorizedPages = []; // {normalizedUrl, day, dwellMs, reason}
        const runPages = await timed('embed', async () => {
          const allPages = await store.getAll('pages');
          const model = ollama.cfg.embeddingModel;
          const eventByUrl = new Map();
          for (const event of events) {
            const list = eventByUrl.get(event.normalizedUrl) || [];
            list.push(event);
            eventByUrl.set(event.normalizedUrl, list);
          }

          // A page is a candidate if it was touched in this window OR if a
          // previous run deferred it past the budget. Selecting purely on the
          // time window silently abandoned deferred work: once a page fell out
          // of the window it was never reconsidered, contradicting the
          // settings copy that promises deferred pages are never dropped.
          const candidates = [];
          for (const page of allPages) {
            const touched = page.lastSeen >= since;
            if (!touched && !page.needsEmbedding) continue;

            const captures = (await store.byIndex('captures', 'byNormUrl', page.normalizedUrl))
              .filter(c => c.textLength > 0)
              .sort((a, b) => b.startedAt - a.startedAt);
            const latestWithText = captures[0];
            const captureText = latestWithText ? latestWithText.extractedText : '';

            // No real title and no content: excluded, never embedded on URL
            // tokens alone (§4.1).
            if (!page.hadTitle && !captureText) {
              const urlEvents = eventByUrl.get(page.normalizedUrl) || [];
              if (urlEvents.length) {
                uncategorizedPages.push({
                  normalizedUrl: page.normalizedUrl,
                  day: urlEvents[urlEvents.length - 1].dayKey,
                  dwellMs: urlEvents.reduce((sum, e) => sum + (e.dwellMs || 0), 0),
                  reason: 'no_content'
                });
              }
              continue;
            }

            const input = embeddingInput({ ...page, captureText });
            const key = embeddingKeyFor(model, input);

            // Already embedded from exactly this input.
            if (page.embeddingKey === key) {
              candidates.push({ page, input, key, captureText, cached: true });
              continue;
            }

            // An existing content embedding is never downgraded to a
            // title-only one. Text ages out after 30 days by design, so a
            // revisit with no fresh capture must keep the better vector
            // rather than recompute a worse one.
            if (page.embeddingKey && page.embeddingVariant === 'content' && !captureText) {
              candidates.push({ page, input: null, key: page.embeddingKey, captureText: '', cached: true, keptVariant: true });
              continue;
            }

            // llm_chat conversations grow; re-embed only on > 30% growth.
            if (
              page.embeddingKey && page.source === 'llm_chat' && latestWithText &&
              page.embeddedTextLength &&
              latestWithText.textLength <= page.embeddedTextLength * (1 + cfg.chatRegrowthShare)
            ) {
              candidates.push({ page, input: null, key: page.embeddingKey, captureText, cached: true });
              continue;
            }

            candidates.push({ page, input, key, captureText, cached: false });
          }

          // Only pages needing work count against the per-run budget.
          const needWork = candidates.filter(c => !c.cached);
          const importance = c => (c.page.visitCount || 0) * 3 + CTText.msToMinutes(c.page.dwellMs || 0);
          needWork.sort((a, b) => importance(b) - importance(a));
          const withinBudget = new Set(needWork.slice(0, cfg.maxNewPagesPerRun));
          const deferred = needWork.filter(c => !withinBudget.has(c));
          counts.pagesDeferred = deferred.length;
          // The backlog is a property of the page row, so it survives the
          // window moving on and is retried until the work is actually done.
          if (deferred.length) {
            await store.bulkPut('pages', deferred.map(c => ({ ...c.page, needsEmbedding: true })));
          }

          const selected = candidates.filter(c => c.cached || withinBudget.has(c));

          // Resolve from cache first, then embed the misses.
          const keys = selected.map(c => c.key);
          const cachedRows = await store.getEmbeddings(keys);
          const misses = [];
          selected.forEach((candidate, i) => {
            if (cachedRows[i]) {
              candidate.vector = CTStore.bufToVec(cachedRows[i].vector);
              counts.embeddingsCached++;
            } else if (candidate.input) {
              misses.push(candidate);
            }
          });
          if (misses.length) {
            const vectors = await ollama.embed(misses.map(c => c.input), { keepAlive: ollama.cfg.embedKeepAlive });
            const embedRows = [];
            const nowMs = nowFn();
            misses.forEach((candidate, i) => {
              const normalized = CTCluster.normalize(Float32Array.from(vectors[i]));
              candidate.vector = normalized;
              embedRows.push({
                key: candidate.key,
                model,
                vector: CTStore.vecToBuf(normalized),
                dim: normalized.length,
                createdAt: nowMs,
                lastUsedAt: nowMs
              });
            });
            await store.bulkPut('embeddings', embedRows);
            counts.pagesEmbedded = misses.length;
          }
          await store.touchEmbeddings(keys, nowFn());

          // Update page rows with embedding bookkeeping.
          const pageUpdates = [];
          for (const candidate of selected) {
            if (!candidate.vector) continue;
            pageUpdates.push({
              ...candidate.page,
              embeddingKey: candidate.key,
              // A kept vector keeps the variant that produced it.
              embeddingVariant: candidate.keptVariant
                ? candidate.page.embeddingVariant
                : (candidate.captureText ? 'content' : 'title_only'),
              embeddedTextLength: candidate.keptVariant
                ? candidate.page.embeddedTextLength
                : (candidate.captureText ? candidate.captureText.length : 0),
              needsEmbedding: false
            });
          }
          await store.bulkPut('pages', pageUpdates);

          // Assemble run-page objects with this run's per-window stats.
          const out = [];
          for (const candidate of selected) {
            if (!candidate.vector) continue;
            const urlEvents = eventByUrl.get(candidate.page.normalizedUrl) || [];
            if (!urlEvents.length) continue;
            const days = urlEvents.map(e => e.dayKey).sort();
            out.push({
              normalizedUrl: candidate.page.normalizedUrl,
              url: candidate.page.url,
              title: candidate.page.title,
              domain: candidate.page.domain,
              source: candidate.page.source || 'web',
              embedding: candidate.vector,
              text: candidate.captureText ? candidate.captureText.slice(0, 200) : '',
              dwellMs: urlEvents.reduce((sum, e) => sum + (e.dwellMs || 0), 0),
              activeMs: 0,
              visitCount: urlEvents.length,
              firstDay: days[0],
              lastDay: days[days.length - 1]
            });
          }
          return out;
        });

        // ---- stage 3+4+5: cluster, label, adjudicate (in memory) -------
        const registryTopics = (await store.getAll('topics')).map(topic => ({
          ...topic,
          centroid: CTStore.bufToVec(topic.centroid)
        }));
        const allMemberships = await store.getAll('memberships');
        const membershipsByKey = new Map(allMemberships.map(m => [CTRegistry.membershipKey(m.topicId, m.normalizedUrl), m]));
        const memberedUrls = new Set(allMemberships.map(m => m.normalizedUrl));

        const clusterResult = await timed('cluster', async () => {
          // Pages already in the registry re-attach to their topic directly;
          // only genuinely new pages go through assignment/clustering.
          const knownPages = runPages.filter(p => memberedUrls.has(p.normalizedUrl));
          const newPages = runPages.filter(p => !memberedUrls.has(p.normalizedUrl));
          const { assigned, remainder } = CTCluster.assignToExistingTopics(newPages, registryTopics, cfg);
          const clustered = CTCluster.clusterNewPages(remainder, cfg);
          for (const page of clustered.thinSingletons) {
            uncategorizedPages.push({ normalizedUrl: page.normalizedUrl, day: page.lastDay, dwellMs: page.dwellMs, reason: 'thin_evidence' });
          }
          for (const page of clustered.beyondBudget) {
            uncategorizedPages.push({ normalizedUrl: page.normalizedUrl, day: page.lastDay, dwellMs: page.dwellMs, reason: 'beyond_budget' });
          }
          if (clustered.rejected.length) warnings.push(`${clustered.rejected.length} pages had invalid embedding vectors`);
          return { assigned, clusters: clustered.clusters, knownPages };
        });

        const labeled = await timed('label', async () => {
          // Unload the embedding model before any chat call (spec §6).
          await ollama.unloadEmbedModel();
          const { clusters } = await CTLabel.labelClusters(clusterResult.clusters, ollama, cfg);
          return clusters;
        });

        const adjudicated = await timed('adjudicate', async () => {
          const result = await CTAdjudicate.adjudicateClusters(labeled, ollama, cfg);
          counts.adjudicated = result.summary.audited;
          counts.kept = result.summary.kept;
          counts.split = result.summary.split;
          counts.disagreed = result.summary.disagreed;
          counts.errors += result.summary.errors;
          for (const entry of result.uncategorized) {
            uncategorizedPages.push({
              normalizedUrl: entry.page.normalizedUrl,
              day: entry.page.lastDay,
              dwellMs: entry.page.dwellMs,
              reason: entry.reason
            });
          }
          return result.clusters;
        });
        counts.uncategorized = uncategorizedPages.length;

        // ---- stage 6: registry (single atomic commit) ------------------
        const registryOutcome = await timed('registry', async () => {
          const topicsById = new Map(registryTopics.map(t => [t.topicId, t]));
          const decisions = CTRegistry.matchNewClusters(adjudicated, registryTopics, allMemberships, { ...cfg, today });
          counts.topicsCreated = decisions.filter(d => d.action === 'create').length;
          counts.topicsMatched = decisions.filter(d => d.action === 'merge').length;

          // Pseudo-clusters: (a) new pages assigned directly to a topic,
          // (b) re-visited pages already membered in a topic.
          const extraByTopic = new Map();
          for (const [topicId, entries] of clusterResult.assigned) {
            extraByTopic.set(topicId, entries.map(e => ({ ...e.page, assignScore: e.score })));
          }
          for (const page of clusterResult.knownPages) {
            const membership = allMemberships.find(m => m.normalizedUrl === page.normalizedUrl);
            if (!membership) continue;
            const list = extraByTopic.get(membership.topicId) || [];
            list.push(page);
            extraByTopic.set(membership.topicId, list);
          }
          counts.topicsMatched += extraByTopic.size;
          for (const [topicId, pages] of extraByTopic) {
            if (!topicsById.has(topicId)) continue;
            decisions.push({
              action: 'merge',
              topicId,
              score: null,
              cluster: {
                pages,
                centroid: CTCluster.centroid(pages.map(p => p.embedding).filter(Boolean)),
                keywords: []
              }
            });
          }

          // Authoritative per-page totals over every stored visit. Membership
          // stats are recomputed from these rather than accumulated, so the
          // 2 h re-ingest overlap cannot inflate topic dwell.
          const pageTotals = new Map();
          for (const page of await store.getAll('pages')) {
            pageTotals.set(page.normalizedUrl, {
              dwellMs: page.dwellMs || 0,
              activeMs: page.activeMs || 0,
              visitCount: page.visitCount || 0,
              firstDay: page.firstSeen ? CTText.dayKeyFromMs(page.firstSeen) : null,
              lastDay: page.lastSeen ? CTText.dayKeyFromMs(page.lastSeen) : null
            });
          }

          const applied = CTRegistry.applyMatches(decisions, topicsById, membershipsByKey, {
            ...cfg, runId, today, now: nowFn(), pausedDays, pageTotals, newTopicId: deps.newTopicId
          });

          // Lifecycle sweep over the post-update registry state.
          const updatedById = new Map(applied.topicRows.map(t => [t.topicId, t]));
          const sweepInput = registryTopics.map(t => updatedById.get(t.topicId) || t);
          const sweep = CTRegistry.lifecycleSweep(sweepInput, { ...cfg, today, runId, pausedDays });
          for (const topic of sweep.updatedTopics) updatedById.set(topic.topicId, topic);

          const topicRows = Array.from(updatedById.values()).map(topic => ({
            ...topic,
            centroid: CTStore.vecToBuf(topic.centroid)
          }));
          const events2 = [...applied.events, ...sweep.events];
          await store.registryCommit({
            topics: topicRows,
            memberships: applied.membershipRows,
            events: events2
          });
          return { events: events2 };
        });

        // ---- stage 7+8: transitions + metrics per touched day ----------
        await timed('transitions', async () => {
          // Rebuild lookup tables from the committed registry.
          const topics = (await store.getAll('topics')).map(topic => ({
            ...topic, centroid: CTStore.bufToVec(topic.centroid)
          }));
          const topicsById = new Map(topics.map(t => [t.topicId, t]));
          const memberships = await store.getAll('memberships');
          const topicByUrl = new Map();
          for (const membership of memberships) {
            const existing = topicByUrl.get(membership.normalizedUrl);
            if (!existing || String(membership.assignedRunId) > String(existing.assignedRunId)) {
              topicByUrl.set(membership.normalizedUrl, membership);
            }
          }
          const urlToTopic = new Map(Array.from(topicByUrl.entries()).map(([url, m]) => [url, m.topicId]));

          const daysTouched = Array.from(new Set(events.map(e => e.dayKey))).sort();
          const uncategorizedByDay = new Map();
          for (const entry of uncategorizedPages) {
            const day = entry.day || today;
            const list = uncategorizedByDay.get(day) || [];
            list.push(entry);
            uncategorizedByDay.set(day, list);
          }

          for (const day of daysTouched) {
            const dayVisits = await store.byIndex('visits', 'byDay', day);
            let { transitions, uncoveredTransitions } = CTMetrics.buildDayTransitions(day, dayVisits, urlToTopic, topicsById, cfg);

            if (day === today && transitions.some(t => t.sourceTopicId !== t.targetTopicId)) {
              // ≤ 1 label call + ≤ 1 verify call, today only (spec §4.8).
              const labeledT = await CTLabel.labelTransitions(transitions, topicsById, ollama);
              const verifiedT = await CTLabel.verifyBorderlineTransitions(labeledT.rows, topicsById, ollama, cfg);
              transitions = verifiedT.rows;
            }

            const windowStart = CTText.addDays(day, -(CTMetrics.DEFAULTS.convergenceWindowDays - 1));
            const windowVisits = await store.byIndex('visits', 'byDay', store.range(windowStart, day));
            const dayEvents = await store.byIndex('topic_events', 'byDay', day);
            const metricsRow = CTMetrics.computeDayMetrics(day, {
              dayVisits, windowVisits, topicByUrl: urlToTopic, topicsById, dayEvents,
              runId, transitions, uncoveredTransitions, now: nowFn()
            });

            const excludedToday = new Set((uncategorizedByDay.get(day) || []).map(e => e.normalizedUrl));
            const commitPayload = {
              metrics: metricsRow,
              transitions: transitions.map(({ examples, ...row }) => row),
              uncategorized: (uncategorizedByDay.get(day) || []).map(entry => ({
                day, normalizedUrl: entry.normalizedUrl, reason: entry.reason,
                dwellMs: entry.dwellMs || 0, runId
              })),
              // Pages this run placed in a topic: any stale exclusion for them
              // is cleared. Pages the run never looked at keep theirs.
              categorizedUrls: dayVisits
                .map(v => v.normalizedUrl)
                .filter(url => urlToTopic.has(url) && !excludedToday.has(url))
            };

            if (day === today) {
              const history = await store.getAll('daily_metrics');
              const withToday = history.filter(r => r.day !== day).concat([metricsRow]);
              const baselines = CTMetrics.computeAllBaselines(withToday, day, cfg);
              const zScores = {};
              for (const baseline of baselines) {
                zScores[baseline.metric] = { ...CTMetrics.zScore(metricsRow[baseline.metric], baseline, cfg), mean: baseline.mean };
              }

              // Newly convergent this week: in today's window, not yesterday's.
              const yesterday = CTText.addDays(day, -1);
              const yWindowStart = CTText.addDays(yesterday, -(CTMetrics.DEFAULTS.convergenceWindowDays - 1));
              const yWindowVisits = await store.byIndex('visits', 'byDay', store.range(yWindowStart, yesterday));
              const previouslyConvergent = new Set(CTMetrics.convergentTopicIds(yWindowVisits, urlToTopic));
              const newlyConvergent = (metricsRow.convergentTopicIds || []).filter(id => !previouslyConvergent.has(id));

              // Gap: consecutive zero-visit days immediately before today.
              let gap = null;
              {
                let cursor = CTText.addDays(day, -1);
                let gapDays = 0;
                for (let i = 0; i < 14; i++) {
                  const dayRows = await store.byIndex('visits', 'byDay', cursor);
                  if (dayRows.length) break;
                  gapDays++;
                  cursor = CTText.addDays(cursor, -1);
                }
                if (gapDays >= 2) {
                  gap = { days: gapDays, from: CTText.addDays(day, -gapDays), to: yesterday };
                }
              }

              let pausedMsToday = 0;
              const dayStart = CTText.dayKeyToNoonMs(day) - 12 * 3600 * 1000;
              for (const interval of pauseIntervals) {
                const start = Math.max(interval.start, dayStart);
                const end = Math.min(interval.end ?? nowFn(), dayStart + 24 * 3600 * 1000);
                if (end > start) pausedMsToday += end - start;
              }

              commitPayload.baselines = baselines;
              commitPayload.brief = CTBrief.buildBrief({
                day, metrics: metricsRow, events: registryOutcome.events.filter(e => e.day === day),
                zScores, topicsById, gap, pausedMsToday,
                newlyConvergentTopicIds: newlyConvergent, firstRun, runId, now: nowFn()
              });
              runRow.brief = commitPayload.brief;
            }

            await store.dayCommit(day, commitPayload);
          }
        });

        // ---- stage 9: finish -------------------------------------------
        await setStage('metrics');
        runRow.ollama.calls = ollama.stats.chatCalls + ollama.stats.embedCalls;
        runRow.status = 'ok';
        runRow.finishedAt = nowFn();
        runRow.durationMs = wallNow() - wallStartedAt;
        runRow.watermarkAfter = startedAt;
        await saveRun();
        await store.setSetting('watermark', startedAt);

        // Housekeeping, best effort.
        try {
          await store.pruneEmbeddings(nowFn());
          await store.retentionSweep(nowFn());
        } catch (error) {
          warnings.push(`housekeeping failed: ${error.message}`);
        }
        if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
          try {
            const estimate = await navigator.storage.estimate();
            if (estimate.quota && estimate.usage / estimate.quota > 0.8) {
              warnings.push(`storage usage at ${Math.round(estimate.usage / estimate.quota * 100)}% of quota`);
              await saveRun();
            }
          } catch { /* best effort */ }
        }

        clearInterval(heartbeatTimer);
        await saveRun();
        return { ok: true, runId, day: today, brief: runRow.brief || null, counts, timingsMs, warnings };
      } catch (error) {
        clearInterval(heartbeatTimer);
        runRow.status = 'failed';
        runRow.error = String((error && error.message) || error);
        runRow.finishedAt = nowFn();
        runRow.durationMs = wallNow() - wallStartedAt;
        // Watermark deliberately unmoved: the next run re-ingests and redoes
        // the work (idempotent stages; registry was all-or-nothing).
        await saveRun();
        return { ok: false, runId, stage, error: runRow.error };
      }
    }

    return { run, cfg };
  }

  return { DEFAULTS, createPipeline, embeddingInput, embeddingKeyFor };
});
