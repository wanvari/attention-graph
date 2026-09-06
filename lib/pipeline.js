// Pipeline orchestrator (spec §3.4, §4). The only module that calls all the
// others. Computes in memory and commits per stage; a failed run never moves
// the watermark and never partially writes the registry.
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./text.js'), require('./privacy.js'), require('./store.js'),
      require('./history.js'), require('./cluster.js'), require('./label.js'),
      require('./adjudicate.js'), require('./registry.js'), require('./metrics.js'),
      require('./brief.js'), require('./relevance.js'), require('./integrity.js')
    );
  } else {
    root.CTPipeline = factory(
      root.CTText, root.CTPrivacy, root.CTStore, root.CTHistory, root.CTCluster,
      root.CTLabel, root.CTAdjudicate, root.CTRegistry, root.CTMetrics, root.CTBrief,
      root.CTRelevance, root.CTIntegrity
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(
  CTText, CTPrivacy, CTStore, CTHistory, CTCluster, CTLabel, CTAdjudicate, CTRegistry, CTMetrics,
  CTBrief, CTRelevance, CTIntegrity
) {
  'use strict';

  const DEFAULTS = {
    days: 28,                    // first-run ingest horizon
    maxNewPagesPerRun: 100,
    maxNewTopicsPerRun: 12,
    maxResults: 5000,
    watermarkOverlapMs: 2 * 3600 * 1000,
    heartbeatMs: 10 * 1000,
    classifyTransitionsWithModel: false,
    chatRegrowthShare: 0.3       // llm_chat re-embed only when text grew > 30%
  };

  function embeddingInput(page) {
    if (page.captureText) {
      const sample = page.source === 'llm_chat' && page.captureText.length > 1500
        ? `${page.captureText.slice(0, 900)}\n${page.captureText.slice(-600)}`
        : page.captureText.slice(0, 1500);
      return `${page.title}\n${page.domain}\n${sample}`;
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
        visitsIngested: 0, pagesEmbedded: 0, embeddingsCached: 0, pagesDeferred: 0, pagesPending: 0,
        topicsCreated: 0, topicsMatched: 0, adjudicated: 0, kept: 0, split: 0,
        uncategorized: 0, disagreed: 0, errors: 0,
        utilityPagesExcluded: 0, utilityMembershipsRemoved: 0
      };
      const timingsMs = {};
      const warnings = [];
      let stage = 'ingest';
      let heartbeatTimer = null;

      const initialRepair = await CTIntegrity.repair(store, { once: true, now: startedAt });
      counts.utilityMembershipsRemoved += initialRepair?.utilityMembershipsRemoved || 0;
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
        // Centroids, thresholds and every cosine in the registry are defined
        // in one embedding model's vector space. Switching models does not
        // migrate them, it invalidates them -- so refuse rather than blend two
        // spaces and quietly produce meaningless similarities.
        const existingTopics = await store.getAll('topics');
        const storedSpace = settings.embeddingSpace || null;
        const model = ollama.cfg.embeddingModel;
        const activeModel = typeof storedSpace === 'string' ? storedSpace : storedSpace && storedSpace.model;
        let dimension = Number(ollama.cfg.embeddingDimensions) ||
          Number(activeModel === model && storedSpace && storedSpace.dimension) || 0;
        if (activeModel && activeModel !== model && existingTopics.length) {
          throw new Error(`Embedding model changed from "${activeModel}" to "${model}". ` +
            'Restore the previous embedding model to continue this record; existing trails have been preserved.');
        }
        for (const topic of existingTopics) {
          let vector;
          try { vector = CTStore.bufToVec(topic.centroid); } catch { vector = null; }
          const topicModel = topic.embeddingModel || activeModel || 'bge-m3:latest';
          if (topicModel !== model || !CTCluster.isValidVector(vector) ||
              (dimension && vector.length !== dimension) || (topic.dim && topic.dim !== vector.length)) {
            throw new Error(`Topic "${topic.label || topic.topicId}" has an incompatible embedding space. ` +
              'Existing trails have been preserved; restore their embedding model before processing.');
          }
          dimension = vector.length;
        }
        const embeddingSpace = () => dimension ? { version: 1, model, dimension } : null;
        const existingMemberships = await store.getAll('memberships');
        const eligibleTopicIds = new Set(existingTopics.filter(t => t.state !== 'retired').map(t => t.topicId));
        const existingOwners = new Map(existingMemberships
          .filter(m => eligibleTopicIds.has(m.topicId)).map(m => [m.normalizedUrl, m]));
        const previousExclusions = new Map((await store.getAll('uncategorized')).map(e => [e.normalizedUrl, e.reason]));

        const pauseIntervals = settings.pauseIntervals || [];
        const denylist = settings.denylist || null;
        const llmChatDomains = settings.llmChatDomains || null;
        // Extra path segments the user considers plumbing, on top of the
        // built-in list in lib/relevance.js.
        const utilitySegments = new Set(
          (settings.utilitySegments || []).map(s => String(s).toLowerCase())
        );
        const pausedDays = CTPrivacy.fullyPausedDays(pauseIntervals, CTText.dayKeyFromMs);

        // ---- stage 1: ingest (idempotent commit) -----------------------
        // One-shot repair: records written before the capture-coverage fix in
        // lib/history.js have dwell that a not-yet-measured capture zeroed,
        // and the incremental watermark would never revisit those visits. A
        // record that predates the fix re-ingests its whole horizon once, which
        // rewrites every visit's dwell and recomputes each affected day. Every
        // stage is idempotent, embeddings are content-keyed and cached, and the
        // per-run compute caps still apply, so this costs a slower run and
        // nothing else.
        const dwellRepairNeeded = !settings.dwellCoverageRepair && watermarkBefore > 0;
        if (dwellRepairNeeded) {
          warnings.push(
            'Re-read the full history horizon once to recompute dwell: earlier runs let a ' +
            'capture that had not measured anything yet lower a visit to zero.'
          );
        }
        const since = Math.max(Number(settings.historyImportAfter) || 0,
          (watermarkBefore && !dwellRepairNeeded)
            ? watermarkBefore - cfg.watermarkOverlapMs
            : startedAt - cfg.days * 24 * 3600 * 1000);

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
            sessionId: e.sessionId, dwellMs: e.dwellMs, gapDwellMs: e.gapDwellMs, captureId: e.captureId || null, endsSession: e.endsSession,
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
              ...existing,
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
          const repaired = await CTIntegrity.repair(store, { now: startedAt });
          counts.utilityMembershipsRemoved += repaired?.utilityMembershipsRemoved || 0;
          return { events: visitEvents, capturesByUrl: byUrl };
        });

        // ---- stage 2: embed (idempotent commit) ------------------------
        // A vector is an intermediate result, never proof that a page was
        // classified. Page work remains pending through the registry commit.
        const uncategorizedPages = [];
        const outcomeReasons = new Map();
        let runUtilityUrls = new Set();
        const runPages = await timed('embed', async () => {
          const allPages = await store.getAll('pages');
          const candidates = [];
          const utilityUrls = new Set();
          for (const page of allPages) {
            const touched = events.some(e => e.normalizedUrl === page.normalizedUrl);
            const override = (await store.get('corrections', `page:${page.normalizedUrl}`));
            if (override?.kind === 'page_membership') continue;
            const oldReason = page.classificationReason || previousExclusions.get(page.normalizedUrl);
            // Repair records made before the durable queue existed, including
            // cached pages abandoned after the ingest watermark moved on.
            const hasOutcome = existingOwners.has(page.normalizedUrl) ||
              (oldReason && oldReason !== 'beyond_budget');
            if (!touched && !page.needsEmbedding && !page.needsClassification &&
                (page.classificationStatus || hasOutcome)) continue;

            if (CTRelevance.classify(page, { extraSegments: utilitySegments })) {
              utilityUrls.add(page.normalizedUrl);
              outcomeReasons.set(page.normalizedUrl, 'utility_page');
              continue;
            }
            if (!CTRelevance.hasGroupingEvidence(page)) {
              utilityUrls.add(page.normalizedUrl);
              outcomeReasons.set(page.normalizedUrl, CTRelevance.isOperationalPage(page) ? 'operational-page' : 'thin_evidence');
              continue;
            }
            const captures = (await store.byIndex('captures', 'byNormUrl', page.normalizedUrl))
              .filter(c => c.textLength > 0 && c.extractedText)
              .sort((a, b) => b.startedAt - a.startedAt);
            const latestWithText = captures[0];
            const captureText = latestWithText ? latestWithText.extractedText : '';
            if (!page.hadTitle && !captureText && !page.embeddingKey) {
              outcomeReasons.set(page.normalizedUrl, 'no_content');
              continue;
            }

            let input = embeddingInput({ ...page, captureText });
            let key = embeddingKeyFor(model, input);
            let keptVariant = false;
            const sameModel = page.embeddingKey && page.embeddingKey.startsWith(`${model}|`);
            if (sameModel && page.embeddingVariant === 'content' && !captureText) {
              key = page.embeddingKey;
              keptVariant = true;
            } else if (sameModel && page.source === 'llm_chat' && latestWithText &&
                       page.embeddedTextLength && latestWithText.textLength < 8000 && latestWithText.textLength <=
                       page.embeddedTextLength * (1 + cfg.chatRegrowthShare)) {
              key = page.embeddingKey;
              keptVariant = true;
            }
            candidates.push({ page, input, key, captureText, keptVariant,
              cached: page.embeddingKey === key && !page.needsEmbedding && existingOwners.has(page.normalizedUrl) });
          }
          runUtilityUrls = utilityUrls;

          // Validate persisted vectors just as strictly as model responses.
          // A model tag alone is not a vector-space contract. In particular,
          // malformed caches cannot inject NaNs or truncated centroids.
          const cachedRows = await store.getEmbeddings(candidates.map(c => c.key));
          for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            const row = cachedRows[i];
            let vector = null;
            if (row) {
              try { vector = CTStore.bufToVec(row.vector); } catch { /* replace malformed cache */ }
              if (row.model !== model || !CTCluster.isValidVector(vector) ||
                  Number(row.dim) !== vector.length || (dimension && vector.length !== dimension)) {
                vector = null;
                warnings.push('An incompatible cached embedding was queued for replacement.');
              }
            }
            if (vector) {
              if (!dimension) dimension = vector.length;
              candidate.vector = vector;
            } else {
              candidate.cached = false;
              if (candidate.keptVariant) {
                // The old vector is missing/corrupt and its text may have
                // expired. Rebuild honestly from the evidence still present.
                candidate.key = embeddingKeyFor(model, candidate.input);
                candidate.keptVariant = false;
              }
            }
          }

          const needWork = candidates.filter(c => !c.cached);
          const importance = c => (c.page.visitCount || 0) * 3 + CTText.msToMinutes(c.page.dwellMs || 0);
          needWork.sort((a, b) => importance(b) - importance(a) ||
            a.page.normalizedUrl.localeCompare(b.page.normalizedUrl));
          const withinBudget = new Set(needWork.slice(0, cfg.maxNewPagesPerRun));
          const deferred = needWork.filter(c => !withinBudget.has(c));
          counts.pagesDeferred = deferred.length;
          await store.bulkPut('pages', deferred.map(c => ({ ...c.page,
            needsEmbedding: !c.vector || c.page.embeddingKey !== c.key,
            needsClassification: true, classificationStatus: 'pending' })));
          const selected = candidates.filter(c => c.cached || withinBudget.has(c));
          // Persist before calling the model so an interrupted/failed label
          // stage can resume from cached vectors even outside the overlap.
          await store.bulkPut('pages', selected.map(c => ({ ...c.page,
            needsClassification: true, classificationStatus: 'pending' })));
          const misses = selected.filter(c => !c.vector);
          // Commit each completed batch. An idle-window interruption must not
          // discard earlier model work and repeat it on the next run.
          const batchSize = Math.max(1, Number(ollama.cfg.embedBatchSize) || 8);
          for (let offset = 0; offset < misses.length; offset += batchSize) {
            const batch = misses.slice(offset, offset + batchSize);
            const vectors = await ollama.embed(batch.map(c => c.input), { keepAlive: ollama.cfg.embedKeepAlive });
            if (!Array.isArray(vectors) || vectors.length !== batch.length) {
              throw new Error('Embedding response did not match pending pages');
            }
            const rows = [];
            for (let i = 0; i < batch.length; i++) {
              const vector = vectors[i];
              if (!CTCluster.isValidVector(vector) || (dimension && vector.length !== dimension)) {
                throw new Error(`Embedding response is incompatible with the ${dimension || 'expected'}-dimension vector space`);
              }
              dimension = vector.length;
              const normalized = CTCluster.normalize(Float32Array.from(vector));
              batch[i].vector = normalized;
              rows.push({ key: batch[i].key, model, vector: CTStore.vecToBuf(normalized),
                dim: dimension, createdAt: nowFn(), lastUsedAt: nowFn() });
            }
            await store.bulkPut('embeddings', rows);
            counts.pagesEmbedded += batch.length;
          }
          counts.embeddingsCached = selected.length - misses.length;
          await store.touchEmbeddings(selected.map(c => c.key), nowFn());
          await store.bulkPut('pages', selected.map(c => ({
            ...c.page, embeddingKey: c.key,
            embeddingVariant: c.keptVariant ? c.page.embeddingVariant : (c.captureText ? 'content' : 'title_only'),
            embeddedTextLength: c.keptVariant ? c.page.embeddedTextLength : c.captureText.length,
            needsEmbedding: false, needsClassification: true, classificationStatus: 'pending'
          })));

          // Backlog work uses ALL stored visits. A page can finish processing
          // days after its last visit; an empty current window loses none of
          // its evidence and all those days will be repaired below.
          const out = [];
          for (const c of selected) {
            const urlVisits = await store.byIndex('visits', 'byNormUrl', c.page.normalizedUrl);
            if (!urlVisits.length) {
              outcomeReasons.set(c.page.normalizedUrl, 'no_content');
              continue;
            }
            const days = urlVisits.map(v => v.dayKey).sort();
            out.push({ normalizedUrl: c.page.normalizedUrl, url: c.page.url,
              title: c.page.title, domain: c.page.domain, source: c.page.source || 'web',
              embedding: c.vector, text: c.captureText.slice(0, 200),
              dwellMs: c.page.dwellMs || 0, activeMs: c.page.activeMs || 0,
              visitCount: urlVisits.length, firstDay: days[0], lastDay: days[days.length - 1],
              lastVisitAt: c.page.lastSeen });
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
        const liveTopicIds = new Set(registryTopics.filter(t => t.state !== 'retired').map(t => t.topicId));
        const liveMemberships = allMemberships.filter(m => liveTopicIds.has(m.topicId));
        const memberedUrls = new Set(liveMemberships.map(m => m.normalizedUrl));

        const memberPages = new Map((await store.getAll('pages')).map(p => [p.normalizedUrl, p]));
        const memberEmbeddings = new Map((await store.getAll('embeddings')).map(e => [e.key, e]));
        cfg.memberVectorsByTopic = new Map();
        for (const membership of liveMemberships) {
          const embed = memberEmbeddings.get(memberPages.get(membership.normalizedUrl)?.embeddingKey);
          if (!embed || embed.model !== model) continue;
          const vector = CTStore.bufToVec(embed.vector);
          if (!CTCluster.isValidVector(vector) || vector.length !== dimension) continue;
          const list = cfg.memberVectorsByTopic.get(membership.topicId) || [];
          list.push(vector); cfg.memberVectorsByTopic.set(membership.topicId, list);
        }
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
          if (clustered.rejected.length) throw new Error('Clustering rejected a validated embedding vector');
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
        for (const entry of uncategorizedPages) outcomeReasons.set(entry.normalizedUrl, entry.reason);
        counts.uncategorized = outcomeReasons.size;

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
            const membership = liveMemberships.find(m => m.normalizedUrl === page.normalizedUrl);
            if (!membership) continue;
            // A retired topic is not a match candidate anywhere else (§4.7);
            // letting a revisited page quietly reactivate one through this
            // path would contradict that. The page re-clusters on its own.
            const owner = topicsById.get(membership.topicId);
            if (!owner || owner.state === 'retired') continue;
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
          const registryPages = new Map((await store.getAll('pages')).map(p => [p.normalizedUrl, p]));
          for (const page of registryPages.values()) {
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
            centroid: CTStore.vecToBuf(topic.centroid),
            embeddingModel: model,
            dim: dimension
          }));
          const events2 = [...applied.events, ...sweep.events];

          // Pages reclassified as plumbing may already sit in the registry
          // from earlier runs -- that is exactly how a topic named after an
          // SSO screen gets there. Drop those memberships so the topic loses
          // its evidence and the next lifecycle sweep can retire it. Only
          // memberships this run did not just write are removed, so a page can
          // never be added and deleted in the same commit.
          const assignedOwners = new Map(applied.membershipRows.map(m => [m.normalizedUrl, m.topicId]));
          const removeMemberships = [];
          for (const membership of allMemberships) {
            const newOwner = assignedOwners.get(membership.normalizedUrl);
            if (runUtilityUrls.has(membership.normalizedUrl) ||
                (newOwner && newOwner !== membership.topicId)) {
              removeMemberships.push([membership.topicId, membership.normalizedUrl]);
            }
          }
          counts.utilityPagesExcluded = runUtilityUrls.size;
          counts.utilityMembershipsRemoved += removeMemberships.filter(([, url]) => runUtilityUrls.has(url)).length;

          // Removing evidence updates the owner in the same transaction. An
          // empty topic remains in the archive, with no misleading dwell.
          const removedKeys = new Set(removeMemberships.map(([id, url]) => CTRegistry.membershipKey(id, url)));
          const finalMemberships = new Map(allMemberships
            .filter(m => !removedKeys.has(CTRegistry.membershipKey(m.topicId, m.normalizedUrl)))
            .map(m => [CTRegistry.membershipKey(m.topicId, m.normalizedUrl), m]));
          for (const m of applied.membershipRows) finalMemberships.set(CTRegistry.membershipKey(m.topicId, m.normalizedUrl), m);
          for (const topicId of new Set(removeMemberships.map(([id]) => id))) {
            const rows = [...finalMemberships.values()].filter(m => m.topicId === topicId);
            const at = topicRows.findIndex(t => t.topicId === topicId);
            const prior = at >= 0 ? topicRows[at] : existingTopics.find(t => t.topicId === topicId);
            if (!prior) continue;
            const updated = { ...prior, totalDwellMs: rows.reduce((sum, m) => sum + (m.dwellMs || 0), 0) };
            if (rows.length) {
              const embeddedMembers = rows.filter(m => registryPages.get(m.normalizedUrl)?.embeddingKey);
              const embeds = await store.getEmbeddings(embeddedMembers.map(m => registryPages.get(m.normalizedUrl).embeddingKey));
              const vectors = [];
              const weights = [];
              embeds.forEach((entry, i) => {
                let vector;
                try { vector = entry && CTStore.bufToVec(entry.vector); } catch { return; }
                if (entry && entry.model === model && CTCluster.isValidVector(vector) && vector.length === dimension) {
                  vectors.push(vector); weights.push(Math.max(embeddedMembers[i].dwellMs || 0, 1));
                }
              });
              if (vectors.length) updated.centroid = CTStore.vecToBuf(CTCluster.centroid(vectors, weights));
            } else {
              updated.state = 'retired';
              if (prior.state !== 'retired') events2.push({ topicId, day: today, runId, type: 'retired',
                detail: { reason: 'no_remaining_evidence' } });
            }
            if (at >= 0) topicRows[at] = updated;
            else topicRows.push(updated);
          }
          const completedUrls = new Set([...assignedOwners.keys(), ...outcomeReasons.keys()]);
          const pageRows = [];
          for (const url of completedUrls) {
            const page = await store.get('pages', url);
            if (!page) continue;
            const reason = assignedOwners.has(url) ? null : outcomeReasons.get(url);
            const pending = reason === 'beyond_budget';
            pageRows.push({ ...page, needsClassification: pending, needsEmbedding: false,
              classificationStatus: pending ? 'pending' : reason ? 'excluded' : 'categorized',
              classificationReason: reason, classifiedRunId: runId, metricsDirty: true });
          }
          await store.registryCommit({ topics: topicRows, memberships: applied.membershipRows,
            removeMemberships, events: events2, pages: pageRows });
          const repaired = await CTIntegrity.repair(store, { now: startedAt });
          counts.utilityMembershipsRemoved += repaired?.utilityMembershipsRemoved || 0;
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

          const dirtyPages = (await store.getAll('pages')).filter(p => p.metricsDirty);
          const touchedDays = new Set([today, ...events.map(e => e.dayKey)]);
          const uncategorizedByDay = new Map();
          for (const page of dirtyPages) {
            const visits = await store.byIndex('visits', 'byNormUrl', page.normalizedUrl);
            const dwellByDay = new Map();
            for (const visit of visits) {
              touchedDays.add(visit.dayKey);
              dwellByDay.set(visit.dayKey, (dwellByDay.get(visit.dayKey) || 0) + (visit.dwellMs || 0));
            }
            if (page.classificationReason) {
              for (const [day, dwellMs] of dwellByDay) {
                const rows = uncategorizedByDay.get(day) || [];
                rows.push({ normalizedUrl: page.normalizedUrl, reason: page.classificationReason, dwellMs });
                uncategorizedByDay.set(day, rows);
              }
            }
          }
          // Classification changes also affect later rolling-window metrics.
          const changedDays = [...touchedDays];
          for (const row of await store.getAll('daily_metrics')) {
            if (changedDays.some(day => CTText.diffDays(day, row.day) >= 0 &&
                CTText.diffDays(day, row.day) < CTMetrics.DEFAULTS.convergenceWindowDays)) touchedDays.add(row.day);
          }
          const daysTouched = [...touchedDays].filter(day => day <= today).sort();

          for (const day of daysTouched) {
            const dayVisits = await store.byIndex('visits', 'byDay', day);
            let { transitions, uncoveredTransitions } = CTMetrics.buildDayTransitions(day, dayVisits, urlToTopic, topicsById, cfg);

            if (cfg.classifyTransitionsWithModel && day === today && transitions.some(t => t.sourceTopicId !== t.targetTopicId)) {
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
                zScores, includeDeviations: false, topicsById, gap, pausedMsToday,
                newlyConvergentTopicIds: newlyConvergent, firstRun, runId, now: nowFn()
              });
              runRow.brief = commitPayload.brief;
            }

            await store.dayCommit(day, commitPayload);
          }
          // A failed day commit leaves every dirty marker intact. Recovery
          // recomputes the complete affected range, then clears it here.
          await store.bulkPut('pages', dirtyPages.map(p => ({ ...p, metricsDirty: false })));
        });

        counts.pagesPending = (await store.getAll('pages')).filter(p => p.needsEmbedding || p.needsClassification).length;

        // ---- stage 9: finish -------------------------------------------
        await setStage('metrics');
        runRow.ollama.calls = ollama.stats.chatCalls + ollama.stats.embedCalls;
        runRow.status = 'ok';
        runRow.finishedAt = nowFn();
        runRow.durationMs = wallNow() - wallStartedAt;
        runRow.watermarkAfter = startedAt;
        await saveRun();
        await store.setSetting('watermark', startedAt);
        if (embeddingSpace()) await store.setSetting('embeddingSpace', embeddingSpace());
        // Set after any run that actually completed, so a fresh record — which
        // never needed the repair — does not take a full re-ingest on its
        // second run, and a failed repair is retried rather than marked done.
        await store.setSetting('dwellCoverageRepair', true);

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
        runRow.status = error && error.code === 'deferred' ? 'deferred' : 'failed';
        runRow.error = String((error && error.message) || error);
        runRow.finishedAt = nowFn();
        runRow.durationMs = wallNow() - wallStartedAt;
        // Watermark deliberately unmoved: the next run re-ingests and redoes
        // the work (idempotent stages; registry was all-or-nothing).
        await saveRun();
        return { ok: false, deferred: runRow.status === 'deferred', runId, stage, error: runRow.error };
      }
    }

    return { run, cfg };
  }

  return { DEFAULTS, createPipeline, embeddingInput, embeddingKeyFor };
});
