// Service worker: message routing, capture buffering, alarms, offscreen
// lifecycle (spec §1.2-§1.3, §2.4). The pipeline NEVER runs here — the SW is
// killed after ~30 s idle; all analysis happens in the offscreen document.
importScripts('lib/text.js', 'lib/privacy.js', 'lib/store.js', 'lib/ollama.js', 'lib/ollamaRules.js', 'lib/captureBuffer.js', 'lib/relevance.js', 'lib/trails.js', 'lib/cluster.js', 'lib/integrity.js', 'lib/dashboard.js', 'lib/sessions.js');

const store = CTStore.createStore({});

const FLUSH_ALARM = 'flush';
const RETENTION_ALARM = 'retention';
const DAILY_ALARM = 'daily';
const RUN_MIN_INTERVAL_MS = 20 * 3600 * 1000;   // condition 1a
const RUN_NEW_VISIT_TRIGGER = 150;              // condition 1b
const HEARTBEAT_FRESH_MS = 60 * 1000;
const HEARTBEAT_ABANDONED_MS = 10 * 60 * 1000;
const OLLAMA_BASE = 'http://localhost:11434';

// All worker-owned writes and pipeline starts share this barrier. Deletion
// closes the gate synchronously, then drains work already in flight before
// closing the offscreen writer and wiping storage. A check before an await
// alone does not protect against a start/retention/capture racing a wipe.
let deletionInProgress = false;
let deletionPromise = null;
let writerChain = Promise.resolve();
// Cover the short interval before the offscreen document writes its first run row.
let pipelineLaunchUntil = 0;
function withWriter(work, blocked = { ok: false, reason: 'deletion-in-progress' }) {
  if (deletionInProgress) return Promise.resolve(blocked);
  const task = writerChain.then(() => deletionInProgress ? blocked : work());
  writerChain = task.catch(() => {});
  return task;
}

// ---- scoped Ollama origin rewrite -------------------------------------

// Registered dynamically so the rule can name this extension as the only
// permitted initiator. A static rule cannot: the id is not known until load,
// and an unscoped rule would let every page you visit launder its Origin past
// Ollama's local-only check.
async function installOllamaOriginRules() {
  try {
    const rules = CTOllamaRules.buildRules(chrome.runtime.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: CTOllamaRules.RULE_IDS,
      addRules: rules
    });
  } catch (error) {
    console.error('failed to install scoped Ollama origin rules', error);
  }
}

// ---- capture buffering (§2.4) -----------------------------------------

// Durability rules and their rationale live in lib/captureBuffer.js, which is
// unit-tested against a real (fake-indexeddb) store.
const captures = CTCaptureBuffer.createCaptureBuffer({ store });

const flushCaptures = () => captures.flush();
const sessions = CTSessions.createManager(store, {
  flush: flushCaptures,
  alarm: (name, info) => chrome.alarms.create(name, info),
  clearAlarm: name => chrome.alarms.clear(name),
  notify: (id, info) => chrome.notifications.create(id, info),
  clearNotification: id => chrome.notifications.clear(id)
});

async function handleCaptureUpdate(message, sender) {
  // Defense in depth: never store anything from incognito contexts.
  if (sender && sender.tab && sender.tab.incognito) return { ok: false, textStored: false };
  if (deletionInProgress) return { ok: false, textStored: false };
  await store.open();
  const incoming = message.capture;
  if (!incoming || !incoming.captureId || !Number.isFinite(incoming.startedAt)) return { ok: false, textStored: false };
  const settings = await store.getSettingsMap();
  if (CTPrivacy.isExcluded(incoming.url, settings.denylist) || CTPrivacy.isFilteredDomain(incoming.url)) return { ok: false, textStored: false };
  if (incoming.startedAt < (settings.historyImportAfter || 0) || CTPrivacy.inPauseInterval(incoming.startedAt, settings.pauseIntervals)) return { ok: false, textStored: false };
  const paused = (settings.pauseIntervals || []).find(i => i.end == null);
  if (paused && !message.final) return { ok: false, textStored: false };
  const safeUrl = CTText.sanitizeUrl(incoming.url);
  const cutoff = Math.min(Date.now(), paused?.start ?? Infinity);
  const capture = {
    ...incoming,
    url: safeUrl,
    normalizedUrl: CTText.normalizeUrl(safeUrl),
    domain: CTPrivacy.hostnameOf(safeUrl),
    source: CTPrivacy.sourceForUrl(safeUrl, settings.llmChatDomains),
    title: CTText.cleanTitle(incoming.title, incoming.url).slice(0, 1000),
    updatedAt: Math.min(Number(incoming.updatedAt) || cutoff, cutoff),
    activeMs: Math.max(0, Math.min(Number(incoming.activeMs) || 0, 30 * 60 * 1000, cutoff - incoming.startedAt))
  };
  if (Array.isArray(incoming.activityIntervals)) {
    capture.activityIntervals = CTTrails.cleanIntervals(incoming.activityIntervals.slice(0, 2048), incoming.startedAt, Math.min(cutoff, capture.updatedAt));
    capture.activeMs = CTTrails.intervalMs(capture.activityIntervals);
  }
  if (incoming.extractedText !== undefined) capture.extractedText = String(incoming.extractedText).slice(0, 8000);
  if (message.final) capture.endedAt = Math.min(Number(incoming.endedAt) || cutoff, cutoff);
  return captures.submit(capture, { final: !!message.final });
}

// ---- pause switch (§2.7) ----------------------------------------------

async function setCapturePaused(paused) {
  await store.open();
  await flushCaptures();
  const intervals = (await store.getSetting('pauseIntervals')) || [];
  const now = Date.now();
  if (paused) {
    if (!intervals.some(i => i.end == null)) intervals.push({ start: now, end: null });
  } else {
    for (const interval of intervals) {
      if (interval.end == null) interval.end = now;
    }
  }
  await store.setSetting('pauseIntervals', intervals);
  await chrome.storage.local.set({ ctPaused: paused });
  let endedSession = null;
  if (paused) {
    const active = (await sessions.all()).find(s => s.status === 'active');
    if (active) endedSession = await sessions.end(active.sessionId, 'capture-paused');
  }
  return { paused, endedSession };
}

async function mirrorSettingsForContentScripts() {
  try {
    await store.open();
    const settings = await store.getSettingsMap();
    const intervals = settings.pauseIntervals || [];
    await chrome.storage.local.set({
      ctPaused: intervals.some(i => i.end == null),
      ctDenylist: settings.denylist || [],
      ctLlmChatDomains: settings.llmChatDomains || []
    });
  } catch (error) {
    console.warn('settings mirror failed', error);
  }
}

// ---- Ollama health (condition 3) --------------------------------------

async function ollamaHealthy() {
  return (await ollamaHealth()).ready;
}

async function ollamaHealth() {
  let timer;
  try {
    await store.open();
    const settings = await store.getSettingsMap();
    const embedModel = settings.embeddingModel || CTOllama.DEFAULTS.embeddingModel;
    const chatModel = settings.chatModel || CTOllama.DEFAULTS.chatModel;
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: controller.signal });
    if (!response.ok) return { ready: false, reachable: true, originRejected: response.status === 403, models: [], missing: [], error: `HTTP ${response.status}` };
    const data = await response.json();
    const models = (data.models || []).map(m => m.name || m.model);
    const missing = [embedModel, chatModel].filter(name => !models.includes(name));
    return { ready: missing.length === 0, reachable: true, originRejected: false, models, missing, error: null };
  } catch (error) {
    return { ready: false, reachable: false, originRejected: false, models: [], missing: [], error: error.name === 'AbortError' ? 'Connection timed out' : 'Ollama is not reachable' };
  } finally {
    clearTimeout(timer);
  }
}

// ---- offscreen lifecycle (§1.2) ---------------------------------------

async function closeOffscreenDocument() {
  if (await offscreenExists()) await chrome.offscreen.closeDocument();
  if (await offscreenExists()) throw new Error('Analysis is still running; storage was not deleted.');
}

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function pipelineIsRunning() {
  await store.open();
  const runs = await store.getAll('runs');
  const now = Date.now();
  return runs.some(run => run.status === 'running' && now - (run.heartbeat || 0) < HEARTBEAT_FRESH_MS);
}

async function markAbandonedRuns() {
  try {
    await store.open();
    const runs = await store.getAll('runs');
    const now = Date.now();
    const stale = runs.filter(run => run.status === 'running' && now - (run.heartbeat || 0) > HEARTBEAT_ABANDONED_MS);
    for (const run of stale) {
      await store.put('runs', { ...run, status: 'abandoned', finishedAt: now });
    }
  } catch (error) {
    console.warn('abandoned-run sweep failed', error);
  }
}

async function startPipeline(trigger, force) {
  if (deletionInProgress) return { started: false, reason: 'deletion-in-progress' };
  // A service-worker restart does not fire onStartup, so sweep here too:
  // this is the moment a stale `running` row actually matters.
  await markAbandonedRuns();
  if (Date.now() < pipelineLaunchUntil || await pipelineIsRunning()) {
    await store.put('runs', {
      runId: `run-${Date.now().toString(36)}-skip`,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status: 'skipped',
      stage: null,
      error: 'another run is in progress',
      warnings: []
    });
    return { started: false, reason: 'already-running' };
  }
  if (!(await ollamaHealthy())) {
    return { started: false, reason: 'ollama-unavailable' };
  }
  const flushed = await flushCaptures();
  if (flushed.error) return { started: false, reason: 'capture-write-failed' };
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/analysis.html',
      reasons: ['WORKERS'],
      justification: 'Local analysis of browsing history with local Ollama models'
    });
  } catch (error) {
    // Document already exists: fine, message it instead.
    if (!(await offscreenExists())) throw error;
  }
  pipelineLaunchUntil = Date.now() + HEARTBEAT_FRESH_MS;
  try { await chrome.runtime.sendMessage({ type: 'RUN_PIPELINE', trigger, force: !!force }); }
  catch (error) { pipelineLaunchUntil = 0; throw error; }
  return { started: true };
}

// ---- scheduling policy (§1.3) -----------------------------------------

async function newVisitCountSinceWatermark() {
  await store.open();
  const watermark = (await store.getSetting('watermark')) || 0;
  if (!watermark) return Infinity; // first run: everything is new
  return new Promise(resolve => {
    chrome.history.search({ text: '', startTime: watermark, maxResults: RUN_NEW_VISIT_TRIGGER + 50 }, items => {
      resolve((items || []).filter(i => i && i.url && !CTPrivacy.isFilteredDomain(i.url)).length);
    });
  });
}

function queryIdleState(seconds) {
  return new Promise(resolve => chrome.idle.queryState(seconds, resolve));
}

async function dailyAlarmFired() {
  await store.open();
  // Housekeeping first, before any due-check can return early: the alarm is
  // the natural moment to notice that a previous run died without finishing.
  await markAbandonedRuns();
  const settings = await store.getSettingsMap();
  const runs = await store.getAll('runs');
  const lastOk = runs.filter(r => r.status === 'ok').sort((a, b) => b.startedAt - a.startedAt)[0];
  const now = Date.now();

  // Condition 1: enough new work.
  const dueByTime = !lastOk || now - lastOk.startedAt > RUN_MIN_INTERVAL_MS;
  let dueByVolume = false;
  if (!dueByTime) {
    // A bounded run can leave deliberate pending work. The next hourly idle
    // gate should drain it without waiting another 20 hours or spinning.
    const pages = await store.getAll('pages');
    dueByVolume = pages.some(page => page.needsEmbedding || page.needsClassification) ||
      (await newVisitCountSinceWatermark()) >= RUN_NEW_VISIT_TRIGGER;
  }
  if (!dueByTime && !dueByVolume) return;

  // Idle means Chrome reports idle/locked, at any hour. Never override an
  // enabled gate because the clock is late or a busy laptop stayed busy.
  const idleGating = settings.idleGatingEnabled !== false;
  const idleState = await queryIdleState(120);
  const machineIdle = idleState === 'idle' || idleState === 'locked';
  if (idleGating && !machineIdle) {
    if (!settings.runBlockedSince) await store.setSetting('runBlockedSince', now);
    return;
  }
  await store.setSetting('runBlockedSince', null);

  // Condition 3 (Ollama) is checked inside startPipeline.
  await startPipeline('alarm', false);
}

// ---- notifications (§5.4, off by default) ------------------------------

async function maybeNotify(brief) {
  try {
    await store.open();
    const settings = await store.getSettingsMap();
    if (!settings.notificationsEnabled) return;
    const items = (brief && brief.items) || [];
    const noteworthy = items.filter(i => ['revival', 'dormancy', 'convergence'].includes(i.kind));
    if (!noteworthy.length) return;
    const today = CTText.dayKeyFromMs(Date.now());
    if (settings.lastNotificationDay === today) return; // one per day at most
    await store.setSetting('lastNotificationDay', today);
    chrome.notifications.create(`ct-${today}`, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Cognitive Trails',
      message: noteworthy[0].text
    });
  } catch (error) {
    console.warn('notification failed', error);
  }
}

chrome.notifications?.onClicked.addListener(id => {
  const sessionId = id.startsWith(CTSessions.PREFIX) ? id.slice(CTSessions.PREFIX.length) : null;
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/newtab.html') + (sessionId ? `?session=${encodeURIComponent(sessionId)}` : '') });
});

// ---- wiring ------------------------------------------------------------

function ensureAlarms() {
  chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 60 });
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 2 });
  // Retention is a promise made in PRIVACY.md, so it cannot be a side effect
  // of a successful analysis run: text must age out even if Ollama is never
  // available again.
  chrome.alarms.create(RETENTION_ALARM, { periodInMinutes: 6 * 60 });
}

async function runRetention() {
  try {
    await store.open();
    const swept = await store.retentionSweep(Date.now());
    if (swept) console.info(`retention: cleared text from ${swept} capture(s)`);
    await store.setSetting('lastRetentionSweep', Date.now());
  } catch (error) {
    console.warn('retention sweep failed', error);
  }
}

function deleteEverything() {
  if (deletionPromise) return deletionPromise;
  deletionInProgress = true;
  deletionPromise = (async () => {
    // Stop sensors immediately; outstanding messages are rejected by the gate.
    await chrome.storage.local.set({ ctPaused: true });
    await writerChain;
    await captures.discardAndDrain();
    await closeOffscreenDocument();
    await store.open();
    await sessions.clear();
    await store.wipe();
    pipelineLaunchUntil = 0;
    const deletedAt = Date.now();
    // These are privacy controls, not retained browsing data. The cutoff
    // prevents a future history import from silently restoring deleted pages.
    await store.setSetting('historyImportAfter', deletedAt);
    await store.setSetting('pauseIntervals', [{ start: deletedAt, end: null }]);
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ ctPaused: true, ctDenylist: [], ctLlmChatDomains: [] });
    return { ok: true, paused: true, historyImportAfter: deletedAt };
  })().finally(() => {
    captures.resume();
    deletionInProgress = false;
    deletionPromise = null;
  });
  return deletionPromise;
}

function maintenance() {
  return withWriter(async () => {
    await markAbandonedRuns();
    await CTIntegrity.repair(store, { once: true });
    const settings = await store.getSettingsMap();
    if (!settings.laptopProfileVersion) {
      const rows = [{ key: 'laptopProfileVersion', value: 1 }];
      if (settings.chatModel === 'gemma3:12b') rows.push(
        { key: 'previousChatModel', value: settings.chatModel }, { key: 'chatModel', value: CTOllama.DEFAULTS.chatModel });
      if (Number(settings.maxNewPagesPerRun) > 200) rows.push({ key: 'maxNewPagesPerRun', value: 100 });
      await store.bulkPut('settings', rows);
    }
    await runRetention();
    await sessions.reconcile();
    await mirrorSettingsForContentScripts();
  });
}

chrome.runtime.onInstalled.addListener(() => {
  installOllamaOriginRules();
  ensureAlarms();
  maintenance();
});

chrome.runtime.onStartup.addListener(() => {
  installOllamaOriginRules();
  ensureAlarms();
  maintenance();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith(CTSessions.PREFIX)) withWriter(() => sessions.reconcile()).catch(error => console.warn('Session reconciliation failed', error));
  if (alarm.name === FLUSH_ALARM) withWriter(async () => { await flushCaptures(); await sessions.reconcile(); }).catch(error => console.warn(error));
  if (alarm.name === DAILY_ALARM) withWriter(dailyAlarmFired);
  if (alarm.name === RETENTION_ALARM) withWriter(runRetention);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message && message.type) {
    case 'CAPTURE_UPDATE':
      withWriter(() => handleCaptureUpdate(message, sender), { ok: false, textStored: false }).then(sendResponse, error => {
        console.warn('capture update failed', error);
        sendResponse({ ok: false, textStored: false });
      });
      return true;
    case 'RUN_PIPELINE_MANUAL':
      // Manual run bypasses freshness and idle gating, not the Ollama check.
      withWriter(() => startPipeline('manual', true), { started: false, reason: 'deletion-in-progress' }).then(sendResponse, error => sendResponse({ started: false, reason: String(error) }));
      return true;
    case 'RUN_COMPLETE':
      pipelineLaunchUntil = 0;
      withWriter(async () => {
        await flushCaptures();
        await maybeNotify(message.brief);
        return { ok: true };
      }).then(sendResponse, error => sendResponse({ ok: false, error: String(error) }));
      return true;
    case 'SET_CAPTURE_PAUSED':
      withWriter(() => setCapturePaused(!!message.paused)).then(sendResponse, error => sendResponse({ error: String(error) }));
      return true;
    case 'SETTINGS_UPDATED':
      withWriter(mirrorSettingsForContentScripts).then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: String(error) }));
      return true;
    case 'SAVE_TRAIL_METADATA':
      withWriter(async () => {
        const row = message.row;
        if (!row || row.kind !== 'trail_metadata' || typeof row.targetId !== 'string') throw new Error('Invalid trail note');
        await store.open();
        if (!await store.get('topics', row.targetId)) throw new Error('Trail no longer exists');
        const previous = await store.get('corrections', `trail:${row.targetId}`);
        await store.put('corrections', CTTrails.makeCorrection(row.targetId, row.value || {}, Date.now(), previous));
        return { ok: true };
      }).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
      return true;
    case 'START_TRAIL_SESSION':
    case 'END_TRAIL_SESSION':
    case 'GET_TRAIL_SESSION_STATUS':
    case 'GET_TRAIL_SESSION_RECAP':
    case 'MARK_TRAIL_SESSION_RECAP_SEEN':
      withWriter(async () => {
        await store.open();
        if (message.type === 'START_TRAIL_SESSION') return sessions.start(message);
        if (message.type === 'END_TRAIL_SESSION') return { ok: true, session: await sessions.end(message.sessionId) };
        if (message.type === 'MARK_TRAIL_SESSION_RECAP_SEEN') return sessions.seen(message.sessionId);
        const active = await sessions.reconcile();
        if (message.type === 'GET_TRAIL_SESSION_STATUS') return { ok: true, session: active };
        const session = await store.get('intent_sessions', message.sessionId);
        if (!session) throw new Error('Session no longer exists');
        const record = CTTrails.buildRecord(await CTTrails.loadData(store));
        return { ok: true, recap: CTDashboard.buildSessionRecap(record, session) };
      }).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
      return true;
    case 'SAVE_PAGE_MEMBERSHIP':
      withWriter(async () => {
        await store.open();
        const url = CTTrails.safeUrl(message.normalizedUrl);
        if (!url || CTText.normalizeUrl(url) !== message.normalizedUrl) throw new Error('Invalid page');
        const exists = await store.get('pages', url) || (await store.byIndex('captures', 'byNormUrl', url)).length || (await store.byIndex('visits', 'byNormUrl', url)).length;
        if (!exists) throw new Error('Page no longer exists');
        const topicId = message.topicId;
        if (topicId !== null && (typeof topicId !== 'string' || !await store.get('topics', topicId))) throw new Error('Trail no longer exists');
        const correction = { correctionId: `page:${url}`, kind: 'page_membership', targetId: url, value: { topicId }, updatedAt: Date.now() };
        await CTIntegrity.repair(store, { correction });
        return { ok: true };
      }).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
      return true;
    case 'AUDIT_EVIDENCE':
      withWriter(async () => { await store.open(); return { ok: true, audit: CTIntegrity.rebuild(await CTTrails.loadData(store)).audit }; })
        .then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
      return true;
    case 'REPAIR_EVIDENCE':
      withWriter(async () => { await store.open(); return { ok: true, audit: await CTIntegrity.repair(store) }; })
        .then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
      return true;
    case 'SAVE_PREFERENCES':
      withWriter(async () => {
        await store.open(); await store.saveEditableSettings(message.values);
        await mirrorSettingsForContentScripts(); return { ok: true };
      }).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
      return true;
    case 'GET_STATUS':
    case 'GET_CAPTURE_STATUS': {
      store.open()
        .then(async () => {
          const intervals = (await store.getSetting('pauseIntervals')) || [];
          const health = await ollamaHealth();
          const runs = await store.getAll('runs');
          const pages = await store.getAll('pages');
          sendResponse({
            paused: intervals.some(i => i.end == null),
            ollama: health.ready,
            health,
            buffered: captures.size,
            lastRun: runs.sort((a, b) => b.startedAt - a.startedAt)[0] || null,
            pending: pages.filter(page => page.needsEmbedding || page.needsClassification).length
          });
        })
        .catch(error => sendResponse({ error: String(error) }));
      return true;
    }
    case 'GET_IDLE_STATE':
      queryIdleState(120).then(state => sendResponse({ state }), error => sendResponse({ error: String(error) }));
      return true;
    case 'DELETE_EVERYTHING': {
      deleteEverything().then(sendResponse, error => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    case 'FLUSH_CAPTURES':
      withWriter(flushCaptures).then(result => sendResponse({ ok: !result?.error && result?.ok !== false }), error => sendResponse({ ok: false, error: String(error) }));
      return true;
    case 'HISTORY_SEARCH':
      // History proxy for the offscreen document (it cannot call
      // chrome.history itself); each message also keeps this SW alive.
      chrome.history.search(message.query || { text: '' }, items => sendResponse({ items: items || [] }));
      return true;
    case 'HISTORY_GET_VISITS':
      chrome.history.getVisits({ url: message.url }, visits => sendResponse({ visits: visits || [] }));
      return true;
    case 'TEST_FIRE_ALARM': {
      // Exposed only in test mode for the e2e suite (§7.7).
      withWriter(() => store.open()
        .then(() => store.getSetting('testMode'))
        .then(async testMode => {
          if (!testMode) return { ok: false, reason: 'not in test mode' };
          if (message.alarm === FLUSH_ALARM) await flushCaptures();
          else if (message.alarm === RETENTION_ALARM) await runRetention();
          else if (message.alarm.startsWith(CTSessions.PREFIX)) await sessions.reconcile();
          else await dailyAlarmFired();
          return { ok: true };
        }))
        .then(sendResponse, error => sendResponse({ ok: false, reason: String(error) }));
      return true;
    }
    case 'TEST_SET_SETTING': {
      // Test-only escape hatch, gated the same way (used to enable testMode
      // itself via an explicit key allowlist).
      const allowed = ['testMode', 'watermark', 'notificationsEnabled', 'idleGatingEnabled'];
      if (!allowed.includes(message.key)) {
        sendResponse({ ok: false, reason: 'key not allowed' });
        return false;
      }
      withWriter(() => store.open().then(() => store.setSetting(message.key, message.value)))
        .then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, reason: String(error) }));
      return true;
    }
    default:
      return false;
  }
});

chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL('ui/newtab.html');
  chrome.tabs.query({ url }, existingTabs => {
    if (existingTabs.length > 0) {
      chrome.tabs.update(existingTabs[0].id, { active: true });
      chrome.windows.update(existingTabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url, active: true });
    }
  });
});

// Persistent storage so Chrome does not evict the record under pressure.
navigator.storage?.persist?.().then(granted => {
  if (!granted) console.warn('navigator.storage.persist() not granted');
});
