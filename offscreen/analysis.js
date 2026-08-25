// Offscreen pipeline entry (spec §1.2). Woken by the SW with RUN_PIPELINE,
// runs one pipeline execution, reports back, and closes itself. It proxies
// chrome.history through the SW because offscreen documents cannot call the
// history API directly; each proxy message also keeps the SW alive.
(function() {
  'use strict';

  let running = false;

  function swCall(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (response && response.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  }

  const historyProvider = {
    async search(query) {
      const response = await swCall('HISTORY_SEARCH', { query });
      return response.items || [];
    },
    async getVisits(url) {
      const response = await swCall('HISTORY_GET_VISITS', { url });
      return response.visits || [];
    }
  };

  async function runPipeline(trigger, force) {
    if (running) return;
    running = true;
    try {
      const store = CTStore.createStore({});
      await store.open();
      const settings = await store.getSettingsMap();
      const ollama = CTOllama.createClient({
        embeddingModel: settings.embeddingModel || 'bge-m3:latest',
        chatModel: settings.chatModel || 'gemma3:12b',
        // How hard the local model is allowed to work (see lib/ollama.js).
        dutyCycle: Number(settings.dutyCycle) || 1,
        numThread: settings.numThread || null
      });
      const pipeline = CTPipeline.createPipeline({
        store,
        historyProvider,
        ollama,
        settings
      });
      const result = await pipeline.run({ trigger, force });
      try {
        await swCall('RUN_COMPLETE', { result, brief: result.brief || null });
      } catch { /* SW may have been recycled; the run row is already stored */ }
    } catch (error) {
      console.error('pipeline failed', error);
    } finally {
      running = false;
      window.close(); // release the offscreen document
    }
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message && message.type === 'RUN_PIPELINE') {
      runPipeline(message.trigger, message.force);
    }
  });
})();
