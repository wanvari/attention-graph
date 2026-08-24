const DEFAULTS = AttentionAnalysis.DEFAULTS;

function setStatus(message) {
  document.getElementById('status').textContent = message;
}

function fillForm(form, settings) {
  form.elements.days.value = String(settings.days || DEFAULTS.days);
  form.elements.maxPagesForAi.value = String(settings.maxPagesForAi || DEFAULTS.maxPagesForAi);
  form.elements.embeddingModel.value = settings.embeddingModel || DEFAULTS.embeddingModel;
  form.elements.chatModel.value = settings.chatModel || DEFAULTS.chatModel;
}

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('settings-form');
  fillForm(form, await AttentionAnalysis.TrustStore.getSettings());

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    await AttentionAnalysis.TrustStore.saveSettings({
      days: Number(data.get('days')) || DEFAULTS.days,
      maxPagesForAi: Number(data.get('maxPagesForAi')) || DEFAULTS.maxPagesForAi,
      embeddingModel: data.get('embeddingModel').toString().trim() || DEFAULTS.embeddingModel,
      chatModel: data.get('chatModel').toString().trim() || DEFAULTS.chatModel
    });
    setStatus('Saved. Settings apply the next time you re-run the analysis.');
  });

  document.getElementById('reset-settings').addEventListener('click', async () => {
    await AttentionAnalysis.TrustStore.saveSettings({});
    fillForm(form, {});
    setStatus('Reset to defaults. They apply the next time you re-run the analysis.');
  });
});
