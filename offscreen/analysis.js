// Offscreen pipeline entry (spec §1.2). Woken by the SW with RUN_PIPELINE,
// runs one pipeline execution, reports back, and closes itself. It proxies
// chrome.history through the SW because offscreen documents cannot call the
// history API directly; each proxy message also keeps the SW alive.
(function() {
  'use strict';

  let running = false;

  function swCall(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => reject(new Error(`${type} acknowledgement timed out`)), timeoutMs) : null;
      chrome.runtime.sendMessage({ type, ...payload }, response => {
        if (timer) clearTimeout(timer);
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
    let ollama, result;
    try {
      const store = CTStore.createStore({});
      await store.open();
      const settings = await store.getSettingsMap();
      const deadline = Date.now() + 3 * 60000;
      ollama = CTOllama.createClient({
        embeddingModel: settings.embeddingModel || CTOllama.DEFAULTS.embeddingModel,
        chatModel: settings.chatModel || CTOllama.DEFAULTS.chatModel,
        // How hard the local model is allowed to work (see lib/ollama.js).
        dutyCycle: Number(settings.dutyCycle) || CTOllama.DEFAULTS.dutyCycle,
        numThread: settings.numThread || CTOllama.DEFAULTS.numThread,
        beforeCall: async () => {
          const current = await store.getSettingsMap();
          const paused = (current.pauseIntervals || []).some(i => i.end == null);
          const idle = trigger === 'alarm' && settings.idleGatingEnabled !== false
            ? await swCall('GET_IDLE_STATE', {}) : null;
          if (Date.now() >= deadline || paused || (idle && !['idle', 'locked'].includes(idle.state))) {
            const error = new Error(paused ? 'Capture is paused; remaining work is saved.' : 'Remaining grouping work is saved for the next idle run.');
            error.code = 'deferred';
            throw error;
          }
        }
      });
      const pipeline = CTPipeline.createPipeline({
        store,
        historyProvider,
        ollama,
        settings
      });
      result = await pipeline.run({ trigger, force });
    } catch (error) {
      console.error('pipeline failed', error);
      result = { ok: false, error: error.message || String(error) };
    } finally {
      if (ollama) {
        try { await ollama.unloadEmbedModel(); } catch { /* short residency is the fallback */ }
        try { await ollama.unloadChatModel(); } catch { /* attempt both models independently */ }
      }
      try {
        await swCall('RUN_COMPLETE', { result, brief: result?.brief || null }, 5000);
      } catch { /* durable result survives a recycled or unresponsive worker */ }
      running = false;
      window.close(); // release the offscreen document
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'RUN_PIPELINE') {
      if (running) { sendResponse({ started: false, reason: 'already-running' }); return; }
      runPipeline(message.trigger, message.force);
      sendResponse({ started: true });
    }
  });
})();
