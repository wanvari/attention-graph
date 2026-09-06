// Preferences never write pipeline internals. Setup checks are read-only;
// inference begins only from the explicit action or the idle scheduler.
(function() {
  'use strict';
  const DEFAULTS = { days: 28, maxNewPagesPerRun: 100, dutyCycle: 0.5, idleGatingEnabled: true, notificationsEnabled: false };
  const store = CTStore.createStore({});
  const list = value => String(value || '').split('\n').map(s => s.trim()).filter(Boolean);
  const call = (type, payload) => new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.id) { reject(new Error('These controls require the installed extension.')); return; }
    chrome.runtime.sendMessage({ type, ...payload }, reply => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!reply || reply.error || reply.ok === false) reject(new Error(reply?.error || 'No reply from the extension.'));
      else resolve(reply);
    });
  });
  document.addEventListener('DOMContentLoaded', async () => {
    const byId = id => document.getElementById(id);
    const status = text => { byId('status').textContent = text; };
    const form = byId('settings-form');
    let paused = false, checking = false, poll;
    const paintPause = () => { byId('pause-toggle').textContent = paused ? 'Resume capture' : 'Pause capture'; };
    function fill(settings) {
      for (const key of ['days', 'maxNewPagesPerRun', 'dutyCycle']) {
        const value = Number(settings[key]) || DEFAULTS[key];
        const select = form.elements[key];
        if (![...select.options].some(o => Number(o.value) === value)) {
          const option = document.createElement('option'); option.value = value; option.textContent = `Existing preference · ${value}`; select.appendChild(option);
        }
        select.value = String(value);
      }
      form.elements.idleGatingEnabled.checked = settings.idleGatingEnabled !== false;
      form.elements.notificationsEnabled.checked = !!settings.notificationsEnabled;
      form.elements.denylist.value = (settings.denylist?.length ? settings.denylist : CTPrivacy.DEFAULT_DENYLIST).join('\n');
      form.elements.llmChatDomains.value = (settings.llmChatDomains?.length ? settings.llmChatDomains : CTPrivacy.DEFAULT_LLM_CHAT_DOMAINS).join('\n');
      byId('embedding-model').textContent = settings.embeddingModel || CTOllama.DEFAULTS.embeddingModel;
      byId('chat-model').textContent = settings.chatModel || CTOllama.DEFAULTS.chatModel;
      paused = (settings.pauseIntervals || []).some(i => i.end == null); paintPause();
    }
    async function check() {
      if (checking) return;
      checking = true; byId('check-setup').disabled = true;
      try {
        const info = await call('GET_STATUS');
        paused = info.paused; paintPause();
        const health = info.health || {};
        byId('setup-instructions').hidden = !!info.ollama;
        byId('group-now').disabled = !info.ollama || paused;
        byId('setup-status').textContent = info.ollama
          ? `Local models are ready. ${info.pending || 0} pages waiting for grouping.${paused ? ' Capture is paused.' : ''}`
          : health.reachable ? `Local runtime found. Missing models: ${(health.missing || []).join(', ') || 'check the connection'}.`
            : 'Ollama is off or unavailable. Your captured pages remain searchable.';
        return info;
      } catch (error) {
        byId('setup-status').textContent = error.message;
        byId('group-now').disabled = true; byId('setup-instructions').hidden = false;
      } finally { checking = false; byId('check-setup').disabled = false; }
    }
    try { await store.open(); fill(await store.getSettingsMap()); await check(); }
    catch (error) { status(`Unable to read preferences: ${error.message}`); }
    byId('check-setup').addEventListener('click', check);
    byId('pause-toggle').addEventListener('click', async () => {
      const button = byId('pause-toggle'); button.disabled = true;
      try { const reply = await call('SET_CAPTURE_PAUSED', { paused: !paused }); paused = reply.paused; paintPause(); status(paused ? 'Capture is paused.' : 'Capture resumed.'); await check(); }
      catch (error) { status(`Could not change capture: ${error.message}`); }
      finally { button.disabled = false; }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = form.querySelector('[type=submit]'); submit.disabled = true;
      try {
        await call('SAVE_PREFERENCES', { values: { days: Number(form.elements.days.value), maxNewPagesPerRun: Number(form.elements.maxNewPagesPerRun.value), dutyCycle: Number(form.elements.dutyCycle.value),
          idleGatingEnabled: form.elements.idleGatingEnabled.checked, notificationsEnabled: form.elements.notificationsEnabled.checked,
          denylist: list(form.elements.denylist.value), llmChatDomains: list(form.elements.llmChatDomains.value) } });
        await call('SETTINGS_UPDATED'); status('Preferences saved. Capture changes apply to open tabs; analysis changes apply to the next run.');
      } catch (error) { status(`Could not apply preferences: ${error.message}`); }
      finally { submit.disabled = false; }
    });
    byId('reset-settings').addEventListener('click', async () => {
      try {
        await call('SAVE_PREFERENCES', { values: { ...DEFAULTS, denylist: CTPrivacy.DEFAULT_DENYLIST, llmChatDomains: CTPrivacy.DEFAULT_LLM_CHAT_DOMAINS } });
        await call('SETTINGS_UPDATED'); fill(await store.getSettingsMap()); status('Preferences reset. Your record and models are retained.');
      } catch (error) { status(error.message); }
    });
    byId('group-now').addEventListener('click', async () => {
      byId('group-now').disabled = true;
      try {
        const reply = await call('RUN_PIPELINE_MANUAL');
        if (!reply.started) { status(`Grouping has not started: ${reply.reason}.`); await check(); return; }
        status('Grouping locally. You can close this page; the work continues in the background.');
        clearInterval(poll);
        poll = setInterval(async () => {
          const runs = await store.getAll('runs'); const latest = runs.sort((a, b) => b.startedAt - a.startedAt)[0];
          if (latest && latest.status !== 'running') { clearInterval(poll); status(latest.status === 'ok' ? 'This run is complete. Remaining pages are queued for a later idle run.' : latest.error || `Run ${latest.status}.`); await check(); }
        }, 3000);
      } catch (error) { status(error.message); await check(); }
    });
    window.addEventListener('pagehide', () => clearInterval(poll), { once: true });
  });
})();
