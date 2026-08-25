// Service worker: message routing, capture buffering, alarms, offscreen
// lifecycle (spec §1.2-§1.3, §2.4). The pipeline NEVER runs here — the SW is
// killed after ~30 s idle; all analysis happens in the offscreen document.
importScripts('lib/text.js', 'lib/privacy.js', 'lib/store.js', 'lib/ollamaRules.js', 'lib/captureBuffer.js');

const store = CTStore.createStore({});

const FLUSH_ALARM = 'flush';
const DAILY_ALARM = 'daily';
const RUN_MIN_INTERVAL_MS = 20 * 3600 * 1000;   // condition 1a
const RUN_NEW_VISIT_TRIGGER = 150;              // condition 1b
const IDLE_STARVATION_MS = 36 * 3600 * 1000;    // never starve a busy machine
const HEARTBEAT_FRESH_MS = 60 * 1000;
const HEARTBEAT_ABANDONED_MS = 10 * 60 * 1000;
const OLLAMA_BASE = 'http://localhost:11434';

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

async function handleCaptureUpdate(message, sender) {
  // Defense in depth: never store anything from incognito contexts.
  if (sender && sender.tab && sender.tab.incognito) return { ok: false, textStored: false };
  await store.open();
  return captures.submit(message.capture);
}

// ---- pause switch (§2.7) ----------------------------------------------

async function setCapturePaused(paused) {
  await store.open();
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
  return { paused };
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
  try {
    await store.open();
    const settings = await store.getSettingsMap();
    const embedModel = settings.embeddingModel || 'bge-m3:latest';
    const chatModel = settings.chatModel || 'gemma3:12b';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const data = await response.json();
    const models = (data.models || []).map(m => m.name || m.model);
    return models.includes(embedModel) && models.includes(chatModel);
  } catch {
    return false;
  }
}

// ---- offscreen lifecycle (§1.2) ---------------------------------------

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
  // A service-worker restart does not fire onStartup, so sweep here too:
  // this is the moment a stale `running` row actually matters.
  await markAbandonedRuns();
  if (await pipelineIsRunning()) {
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
  await chrome.runtime.sendMessage({ type: 'RUN_PIPELINE', trigger, force: !!force });
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
    dueByVolume = (await newVisitCountSinceWatermark()) >= RUN_NEW_VISIT_TRIGGER;
  }
  if (!dueByTime && !dueByVolume) return;

  // Condition 2: user idle, or the quiet overnight window, unless disabled or starved.
  const idleGating = settings.idleGatingEnabled !== false;
  const hour = new Date().getHours();
  const nightWindow = hour >= 2 && hour < 5;
  const idleState = await queryIdleState(120);
  const machineIdle = idleState === 'idle' || idleState === 'locked';
  if (idleGating && !machineIdle && !nightWindow) {
    const blockedSince = settings.runBlockedSince || now;
    if (!settings.runBlockedSince) await store.setSetting('runBlockedSince', now);
    if (now - blockedSince < IDLE_STARVATION_MS) return;
    console.warn('idle gating starved for >36h; running anyway');
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

chrome.notifications?.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/newtab.html') });
});

// ---- wiring ------------------------------------------------------------

function ensureAlarms() {
  chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 60 });
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 2 });
}

chrome.runtime.onInstalled.addListener(() => {
  installOllamaOriginRules();
  ensureAlarms();
  markAbandonedRuns();
  mirrorSettingsForContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  installOllamaOriginRules();
  ensureAlarms();
  markAbandonedRuns();
  mirrorSettingsForContentScripts();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === FLUSH_ALARM) flushCaptures();
  if (alarm.name === DAILY_ALARM) dailyAlarmFired();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message && message.type) {
    case 'CAPTURE_UPDATE':
      handleCaptureUpdate(message, sender).then(sendResponse, error => {
        console.warn('capture update failed', error);
        sendResponse({ ok: false, textStored: false });
      });
      return true;
    case 'RUN_PIPELINE_MANUAL':
      // Manual run bypasses freshness and idle gating, not the Ollama check.
      startPipeline('manual', true).then(sendResponse, error => sendResponse({ started: false, reason: String(error) }));
      return true;
    case 'RUN_COMPLETE':
      flushCaptures();
      maybeNotify(message.brief);
      sendResponse({ ok: true });
      return false;
    case 'SET_CAPTURE_PAUSED':
      setCapturePaused(!!message.paused).then(sendResponse, error => sendResponse({ error: String(error) }));
      return true;
    case 'SETTINGS_UPDATED':
      mirrorSettingsForContentScripts().then(() => sendResponse({ ok: true }));
      return true;
    case 'GET_CAPTURE_STATUS': {
      store.open()
        .then(async () => {
          const intervals = (await store.getSetting('pauseIntervals')) || [];
          const healthy = await ollamaHealthy();
          sendResponse({
            paused: intervals.some(i => i.end == null),
            ollama: healthy,
            buffered: captures.size
          });
        })
        .catch(error => sendResponse({ error: String(error) }));
      return true;
    }
    case 'FLUSH_CAPTURES':
      flushCaptures().then(() => sendResponse({ ok: true }));
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
      store.open()
        .then(() => store.getSetting('testMode'))
        .then(testMode => {
          if (!testMode) return sendResponse({ ok: false, reason: 'not in test mode' });
          if (message.alarm === FLUSH_ALARM) return flushCaptures().then(() => sendResponse({ ok: true }));
          return dailyAlarmFired().then(() => sendResponse({ ok: true }));
        })
        .catch(error => sendResponse({ ok: false, reason: String(error) }));
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
      store.open().then(() => store.setSetting(message.key, message.value))
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
