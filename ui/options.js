// Settings page (spec §5.2). Only keys in the store's EDITABLE_SETTINGS
// allowlist persist, so a form can never shadow pipeline internals such as
// the watermark or the fixed Ollama endpoint.
const DEFAULTS = {
  days: 28,
  maxNewPagesPerRun: 300,
  dutyCycle: 1,
  embeddingModel: 'bge-m3:latest',
  chatModel: 'gemma3:12b',
  idleGatingEnabled: true,
  notificationsEnabled: false
};

const store = CTStore.createStore({});

function setStatus(message) {
  document.getElementById('status').textContent = message;
}

function linesToList(value) {
  return String(value || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function fillForm(form, settings) {
  form.elements.days.value = String(settings.days || DEFAULTS.days);
  form.elements.maxNewPagesPerRun.value = String(settings.maxNewPagesPerRun || DEFAULTS.maxNewPagesPerRun);
  form.elements.dutyCycle.value = String(settings.dutyCycle || DEFAULTS.dutyCycle);
  form.elements.embeddingModel.value = settings.embeddingModel || DEFAULTS.embeddingModel;
  form.elements.chatModel.value = settings.chatModel || DEFAULTS.chatModel;
  form.elements.idleGatingEnabled.checked = settings.idleGatingEnabled !== false;
  form.elements.notificationsEnabled.checked = !!settings.notificationsEnabled;
  form.elements.denylist.value = (settings.denylist && settings.denylist.length
    ? settings.denylist
    : CTPrivacy.DEFAULT_DENYLIST).join('\n');
  form.elements.llmChatDomains.value = (settings.llmChatDomains && settings.llmChatDomains.length
    ? settings.llmChatDomains
    : CTPrivacy.DEFAULT_LLM_CHAT_DOMAINS).join('\n');
}

document.addEventListener('DOMContentLoaded', async () => {
  await store.open();
  const form = document.getElementById('settings-form');
  const settings = await store.getSettingsMap();
  fillForm(form, settings);

  const pauseButton = document.getElementById('pause-toggle');
  const intervals = settings.pauseIntervals || [];
  let paused = intervals.some(interval => interval.end == null);
  const paintPause = () => {
    pauseButton.textContent = paused ? 'Resume capture' : 'Pause capture';
  };
  paintPause();
  pauseButton.addEventListener('click', () => {
    const next = !paused;
    chrome.runtime.sendMessage({ type: 'SET_CAPTURE_PAUSED', paused: next }, () => {
      paused = next;
      paintPause();
      setStatus(next
        ? 'Capture paused. History from this interval is excluded from analysis too.'
        : 'Capture resumed.');
    });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    await store.saveEditableSettings({
      days: Number(data.get('days')) || DEFAULTS.days,
      maxNewPagesPerRun: Number(data.get('maxNewPagesPerRun')) || DEFAULTS.maxNewPagesPerRun,
      dutyCycle: Number(data.get('dutyCycle')) || DEFAULTS.dutyCycle,
      embeddingModel: String(data.get('embeddingModel') || '').trim() || DEFAULTS.embeddingModel,
      chatModel: String(data.get('chatModel') || '').trim() || DEFAULTS.chatModel,
      denylist: linesToList(data.get('denylist')),
      llmChatDomains: linesToList(data.get('llmChatDomains')),
      idleGatingEnabled: form.elements.idleGatingEnabled.checked,
      notificationsEnabled: form.elements.notificationsEnabled.checked
    });
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' }, () => {});
    setStatus(form.elements.idleGatingEnabled.checked
      ? 'Saved. Capture settings apply to newly loaded pages; analysis settings apply to the next run.'
      : 'Saved. With idle gating off, a run of roughly one to four minutes of local GPU work can start while you are working.');
  });

  document.getElementById('reset-settings').addEventListener('click', async () => {
    await store.saveEditableSettings({
      ...DEFAULTS,
      denylist: CTPrivacy.DEFAULT_DENYLIST,
      llmChatDomains: CTPrivacy.DEFAULT_LLM_CHAT_DOMAINS
    });
    fillForm(form, {});
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' }, () => {});
    setStatus('Reset to defaults.');
  });
});
