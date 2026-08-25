// Local Ollama client (spec §4.2, §6). Endpoint is fixed to localhost — the
// extension never calls hosted APIs. The transport is injectable so protocol
// tests and the golden replay can script responses without a live model.
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTOllama = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const BASE_URL = 'http://localhost:11434';

  const DEFAULTS = {
    embeddingModel: 'bge-m3:latest',
    chatModel: 'gemma3:12b',
    embedBatchSize: 32,
    embedTimeoutMs: 60000,
    chatTimeoutMs: 180000,
    chatContextTokens: 16384,
    embedKeepAlive: '5m',
    chatKeepAlive: '10m'
  };

  function stripCodeFence(text) {
    const trimmed = String(text || '').trim();
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fence ? fence[1].trim() : trimmed;
  }

  function parseOllamaJson(text) {
    const stripped = stripCodeFence(text);
    try {
      return JSON.parse(stripped);
    } catch {
      const firstObject = stripped.indexOf('{');
      const lastObject = stripped.lastIndexOf('}');
      const firstArray = stripped.indexOf('[');
      const lastArray = stripped.lastIndexOf(']');
      const candidates = [];
      if (firstObject !== -1 && lastObject > firstObject) candidates.push(stripped.slice(firstObject, lastObject + 1));
      if (firstArray !== -1 && lastArray > firstArray) candidates.push(stripped.slice(firstArray, lastArray + 1));
      for (const candidate of candidates) {
        try {
          return JSON.parse(candidate);
        } catch { /* next candidate */ }
      }
    }
    const error = new Error('Ollama response was not parseable JSON');
    error.code = 'parse'; // parse failures are tolerated per-batch; transport failures are not
    throw error;
  }

  // Default transport: fetch with timeout. text/plain body keeps extension
  // requests out of CORS preflight, which Ollama rejects.
  async function fetchTransport(url, options, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || 20000) : null;
    try {
      const headers = { ...(options.headers || {}) };
      if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'text/plain';
      const response = await fetch(url, { ...options, headers, signal: controller ? controller.signal : undefined });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`.trim());
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function createClient(options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const transport = cfg.transport || fetchTransport;
    const stats = { embedCalls: 0, chatCalls: 0, errors: 0 };

    return {
      cfg,
      stats,

      async health() {
        try {
          const data = await transport(`${BASE_URL}/api/tags`, { method: 'GET' }, 4000);
          const models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
          const missing = [cfg.embeddingModel, cfg.chatModel].filter(m => !models.includes(m));
          return { ok: missing.length === 0, reachable: true, models, missing };
        } catch (error) {
          return {
            ok: false,
            reachable: error && error.status === 403,
            originRejected: error && error.status === 403,
            missing: [cfg.embeddingModel, cfg.chatModel],
            error: String(error && error.message || error)
          };
        }
      },

      // Embed a list of texts; batches of 32; one retry per batch.
      async embed(texts, opts) {
        const out = [];
        for (let i = 0; i < texts.length; i += cfg.embedBatchSize) {
          const batch = texts.slice(i, i + cfg.embedBatchSize).map(t => String(t || '').slice(0, 2000));
          const body = JSON.stringify({
            model: cfg.embeddingModel,
            input: batch,
            keep_alive: (opts && opts.keepAlive) ?? cfg.embedKeepAlive
          });
          const attempt = async () => {
            stats.embedCalls++;
            const data = await transport(`${BASE_URL}/api/embed`, {
              method: 'POST', body, headers: { 'x-prompt-kind': 'embed' }
            }, cfg.embedTimeoutMs);
            const values = data.embeddings || (data.embedding ? [data.embedding] : []);
            if (!Array.isArray(values) || values.length !== batch.length) {
              throw new Error('Embedding response did not match input batch');
            }
            return values;
          };
          try {
            out.push(...await attempt());
          } catch (firstError) {
            stats.errors++;
            out.push(...await attempt()); // single retry; second failure propagates
          }
          if (opts && opts.onProgress) opts.onProgress(Math.min(i + cfg.embedBatchSize, texts.length), texts.length);
        }
        return out;
      },

      // Ask Ollama to drop the embed model from memory before chat loads
      // (spec §6: both models never resident longer than needed).
      async unloadEmbedModel() {
        try {
          await transport(`${BASE_URL}/api/embed`, {
            method: 'POST',
            body: JSON.stringify({ model: cfg.embeddingModel, input: 'x', keep_alive: 0 }),
            headers: { 'x-prompt-kind': 'unload' }
          }, 10000);
        } catch { /* best effort */ }
      },

      // One JSON-returning chat call. promptKind identifies the call for the
      // scripted test transport and the golden recorder.
      async chatJson(prompt, promptKind, opts) {
        stats.chatCalls++;
        const data = await transport(`${BASE_URL}/api/chat`, {
          method: 'POST',
          headers: { 'x-prompt-kind': promptKind || 'chat' },
          body: JSON.stringify({
            model: cfg.chatModel,
            stream: false,
            keep_alive: (opts && opts.keepAlive) ?? cfg.chatKeepAlive,
            options: { temperature: 0, num_ctx: cfg.chatContextTokens },
            messages: [
              {
                role: 'system',
                content: 'You label browser history topics. Return valid JSON only. Do not include Markdown except if unavoidable.'
              },
              { role: 'user', content: prompt }
            ]
          })
        }, cfg.chatTimeoutMs);
        const content = data && data.message ? data.message.content : '';
        return parseOllamaJson(content);
      },

      async runningModels() {
        try {
          const data = await transport(`${BASE_URL}/api/ps`, { method: 'GET' }, 4000);
          return (data.models || []).map(m => ({ name: m.name || m.model, sizeVram: m.size_vram, size: m.size }));
        } catch {
          return null;
        }
      }
    };
  }

  return { BASE_URL, DEFAULTS, createClient, fetchTransport, parseOllamaJson, stripCodeFence };
});
