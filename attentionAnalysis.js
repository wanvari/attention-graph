(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AttentionAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const VERSION = 'topic-map-trust-audit-v2';
  const LATEST_ANALYSIS_KEY = 'latest-analysis';
  const DEFAULTS = {
    days: 7,
    maxResults: 2000,
    maxPagesForAi: 420,
    maxTopicCount: 30,
    topPagesPerTopic: 8,
    sessionBreakMs: 30 * 60 * 1000,
    dwellCapMs: 30 * 60 * 1000,
    sameTopicThreshold: 0.72,
    topicClusterThreshold: 0.62,
    topicMergeThreshold: 0.66,
    crossDomainWeakTokenThreshold: 0.08,
    crossDomainStrongTokenThreshold: 0.16,
    fallbackTopicClusterThreshold: 0.30,
    adjacentTopicThreshold: 0.58,
    embeddingBatchSize: 32,
    topicLabelBatchSize: 14,
    transitionLabelBatchSize: 20,
    visitExpandConcurrency: 8,
    chatTimeoutMs: 180000,
    embedTimeoutMs: 60000,
    ollamaBaseUrl: 'http://localhost:11434',
    embeddingModel: 'bge-m3:latest',
    chatModel: 'gemma3:12b-32k'
  };

  const TRANSITION_TYPES = {
    same_topic_flow: {
      label: 'Same-topic continuation',
      color: '#94a3b8',
      description: 'Consecutive visits stayed inside one topic.'
    },
    adjacent_topic_jump: {
      label: 'Related continuation',
      color: '#0d9488',
      description: 'Movement to a related topic that may be part of the same task.'
    },
    topic_switch: {
      label: 'Context switch',
      color: '#e8590c',
      description: 'Movement to a less-related topic or different task context.'
    }
  };

  const TOPIC_COLORS = [
    '#4c6ef5', '#7048e8', '#d6336c',
    '#748ffc', '#9775fa', '#f783ac',
    '#8e99a4', '#a5aeb8', '#b9c0c9'
  ];

  const ATTENTION_BANDS = {
    primary: {
      label: 'Primary attention',
      color: '#4c6ef5',
      description: 'One of the highest-time topics in the selected history window.'
    },
    secondary: {
      label: 'Secondary attention',
      color: '#9775fa',
      description: 'A meaningful topic, but not one of the dominant attention areas.'
    },
    long_tail: {
      label: 'Long-tail topic',
      color: '#a5aeb8',
      description: 'A smaller topic with limited estimated time or visit evidence.'
    }
  };

  const ATTENTION_BAND_COLORS = {
    primary: ['#4c6ef5', '#7048e8', '#d6336c'],
    secondary: ['#748ffc', '#9775fa', '#f783ac'],
    long_tail: ['#8e99a4', '#a5aeb8', '#b9c0c9']
  };

  const STOP_WORDS = new Set([
    'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been',
    'before', 'being', 'between', 'browse', 'com', 'from', 'has', 'have', 'how',
    'html', 'http', 'https', 'into', 'its', 'new', 'not', 'org', 'that',
    'the', 'their', 'them', 'then', 'there', 'this', 'through', 'to',
    'url', 'use', 'was', 'what', 'when', 'where', 'which', 'with', 'www',
    'your',
    'account', 'accounts', 'app', 'apps', 'dashboard', 'feed', 'home',
    'login', 'manage', 'management', 'online', 'page', 'play', 'portfolio',
    'profile', 'settings', 'sign'
  ]);

  const FILTERED_DOMAINS = new Set([
    'google.com',
    'www.google.com',
    'bing.com',
    'duckduckgo.com'
  ]);

  function nowIso() {
    return new Date().toISOString();
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function hashString(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function extractDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return String(url || '');
    }
  }

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return String(url || '');
    }
  }

  function cleanTitle(title, url) {
    const text = String(title || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.split('/').filter(Boolean).slice(-2).join(' ');
      return path || parsed.hostname;
    } catch {
      return String(url || 'Untitled page');
    }
  }

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[_-]/g, ' ')
      .split(/[^a-z0-9]+/)
      .map(t => t.trim())
      .filter(t => t.length > 2 && !STOP_WORDS.has(t));
  }

  function pageText(page) {
    return [
      page.title,
      page.domain,
      page.url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/[\/._-]/g, ' ')
    ].join(' ');
  }

  function pageImportanceScore(page) {
    return page.visitCount * 3 + msToMinutes(page.estimatedDwellMs);
  }

  function keywordSummary(items, limit) {
    const counts = new Map();
    for (const item of items) {
      for (const token of tokenize(item.title + ' ' + item.domain + ' ' + item.url)) {
        counts.set(token, (counts.get(token) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([token]) => token);
  }

  function jaccard(aTokens, bTokens) {
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    if (!a.size && !b.size) return 0;
    let overlap = 0;
    for (const token of a) if (b.has(token)) overlap++;
    return overlap / new Set([...a, ...b]).size;
  }

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0;
    let aNorm = 0;
    let bNorm = 0;
    for (let i = 0; i < a.length; i++) {
      const av = Number(a[i]) || 0;
      const bv = Number(b[i]) || 0;
      dot += av * bv;
      aNorm += av * av;
      bNorm += bv * bv;
    }
    const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
    return denom ? dot / denom : 0;
  }

  function averageVectors(vectors) {
    const valid = vectors.filter(v => Array.isArray(v) && v.length);
    if (!valid.length) return [];
    const dim = valid[0].length;
    const out = new Array(dim).fill(0);
    for (const vector of valid) {
      for (let i = 0; i < dim; i++) out[i] += Number(vector[i]) || 0;
    }
    for (let i = 0; i < dim; i++) out[i] /= valid.length;
    return out;
  }

  function msToMinutes(ms) {
    return Math.round((ms || 0) / 60000);
  }

  function formatUrlForPrompt(url) {
    return String(url || '').replace(/^https?:\/\//, '').slice(0, 120);
  }

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
        } catch {
          // Try the next candidate.
        }
      }
    }
    throw new Error('Ollama response was not parseable JSON');
  }

  async function fetchJson(url, options, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs || 20000) : null;
    const requestOptions = options || {};
    const method = String(requestOptions.method || 'GET').toUpperCase();
    const headers = { ...(requestOptions.headers || {}) };
    if (method !== 'GET' && requestOptions.body && !headers['Content-Type']) {
      // Ollama parses JSON bodies without the JSON content type. Using text/plain
      // keeps extension-origin requests out of CORS preflight, which Ollama rejects.
      headers['Content-Type'] = 'text/plain';
    }
    try {
      const response = await fetch(url, {
        ...requestOptions,
        signal: controller ? controller.signal : undefined,
        headers
      });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`.trim());
        error.status = response.status;
        error.statusText = response.statusText;
        error.url = url;
        throw error;
      }
      return await response.json();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function getExtensionOrigin() {
    if (typeof location === 'undefined' || !location.origin) return null;
    return location.origin.startsWith('chrome-extension://') ? location.origin : null;
  }

  async function checkOllamaHealth(config) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    try {
      const data = await fetchJson(`${cfg.ollamaBaseUrl}/api/tags`, { method: 'GET' }, 4000);
      const models = Array.isArray(data.models) ? data.models.map(m => m.name || m.model).filter(Boolean) : [];
      const hasEmbeddingModel = models.includes(cfg.embeddingModel);
      const hasChatModel = models.includes(cfg.chatModel);
      return {
        ok: hasEmbeddingModel && hasChatModel,
        reachable: true,
        models,
        embeddingModel: cfg.embeddingModel,
        chatModel: cfg.chatModel,
        missing: [
          hasEmbeddingModel ? null : cfg.embeddingModel,
          hasChatModel ? null : cfg.chatModel
        ].filter(Boolean)
      };
    } catch (error) {
      const origin = getExtensionOrigin();
      const originRejected = error && error.status === 403 && !!origin;
      return {
        ok: false,
        reachable: originRejected,
        originRejected,
        origin,
        models: [],
        embeddingModel: cfg.embeddingModel,
        chatModel: cfg.chatModel,
        missing: originRejected ? [] : [cfg.embeddingModel, cfg.chatModel],
        status: error.status || null,
        error: error.message || String(error)
      };
    }
  }

  function ollamaUnavailableMessage(health, config) {
    if (health && health.originRejected) {
      return `Ollama is running, but it rejected this Chrome extension origin (${health.origin}). Allow that origin in OLLAMA_ORIGINS, then restart Ollama.`;
    }
    if (health && health.reachable) {
      return `Ollama is reachable, but missing model(s): ${health.missing.join(', ')}.`;
    }
    return `Could not reach Ollama at ${config.ollamaBaseUrl}.`;
  }

  async function embedTexts(texts, config) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    const input = texts.map(t => String(t || '').slice(0, 2000));
    const embeddings = [];
    const batchSize = cfg.embeddingBatchSize;
    for (let i = 0; i < input.length; i += batchSize) {
      const batch = input.slice(i, i + batchSize);
      if (cfg.onProgress) cfg.onProgress(`Embedding pages ${i + 1}-${Math.min(i + batch.length, input.length)} of ${input.length}`);
      const data = await fetchJson(`${cfg.ollamaBaseUrl}/api/embed`, {
        method: 'POST',
        body: JSON.stringify({
          model: cfg.embeddingModel,
          input: batch
        })
      }, cfg.embedTimeoutMs);
      const values = data.embeddings || (data.embedding ? [data.embedding] : []);
      if (!Array.isArray(values) || values.length !== batch.length) {
        throw new Error('Embedding response did not match input batch');
      }
      embeddings.push(...values.map(v => Array.from(v)));
    }
    return embeddings;
  }

  function embeddingCacheKey(model, text) {
    return `${model}|${hashString(String(text || '').slice(0, 2000))}`;
  }

  async function embedTextsCached(texts, config) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    const keys = texts.map(text => embeddingCacheKey(cfg.embeddingModel, text));
    const cached = await TrustStore.getEmbeddings(keys);
    const results = keys.map((key, index) => cached[index] || null);
    const missingIndexes = [];
    results.forEach((value, index) => { if (!value) missingIndexes.push(index); });
    if (missingIndexes.length) {
      const fresh = await embedTexts(missingIndexes.map(index => texts[index]), cfg);
      const rows = [];
      missingIndexes.forEach((textIndex, freshIndex) => {
        results[textIndex] = fresh[freshIndex];
        rows.push({ key: keys[textIndex], value: fresh[freshIndex] });
      });
      await TrustStore.saveEmbeddings(rows);
    }
    return {
      embeddings: results,
      cachedCount: texts.length - missingIndexes.length,
      embeddedCount: missingIndexes.length
    };
  }

  async function chatJson(prompt, config) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    const data = await fetchJson(`${cfg.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: cfg.chatModel,
        stream: false,
        options: { temperature: 0 },
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
  }

  function getHistoryData(chromeApi, query) {
    return new Promise((resolve, reject) => {
      chromeApi.history.search(query, results => {
        const err = chromeApi.runtime && chromeApi.runtime.lastError;
        if (err) reject(new Error(err.message || 'Chrome history search failed'));
        else resolve(results || []);
      });
    });
  }

  function getVisitsForUrl(chromeApi, url) {
    return new Promise(resolve => {
      chromeApi.history.getVisits({ url }, results => {
        resolve(results || []);
      });
    });
  }

  async function loadHistoryEvents(options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const chromeApi = cfg.chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
    if (!chromeApi || !chromeApi.history) throw new Error('Chrome history API unavailable');
    const startTime = Date.now() - cfg.days * 24 * 60 * 60 * 1000;
    const historyItems = await getHistoryData(chromeApi, {
      text: '',
      maxResults: cfg.maxResults,
      startTime
    });
    const visitMap = {};
    const expandable = historyItems.filter(item => item && item.url && !FILTERED_DOMAINS.has(extractDomain(item.url)));
    let cursor = 0;
    let expanded = 0;
    const worker = async () => {
      while (cursor < expandable.length) {
        const item = expandable[cursor++];
        visitMap[item.url] = (await getVisitsForUrl(chromeApi, item.url))
          .filter(v => Number(v.visitTime) >= startTime);
        expanded++;
        if (cfg.onProgress && expanded % 80 === 0) cfg.onProgress(`Expanding visits ${expanded}/${expandable.length}`);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(cfg.visitExpandConcurrency, expandable.length)) }, worker)
    );
    return buildVisitEventsFromHistoryItems(historyItems, visitMap, cfg);
  }

  function buildVisitEventsFromHistoryItems(historyItems, visitMap, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const events = [];
    const byUrl = new Map();
    for (const item of historyItems || []) {
      if (!item || !item.url) continue;
      const domain = extractDomain(item.url);
      if (FILTERED_DOMAINS.has(domain)) continue;
      byUrl.set(item.url, item);
      const visits = visitMap && Array.isArray(visitMap[item.url]) && visitMap[item.url].length
        ? visitMap[item.url]
        : [{ visitId: `last-${hashString(item.url)}`, visitTime: item.lastVisitTime, transition: 'generated' }];
      for (const visit of visits) {
        if (!visit || !Number(visit.visitTime)) continue;
        events.push({
          id: String(visit.visitId || `${hashString(item.url)}-${visit.visitTime}`),
          url: item.url,
          normalizedUrl: normalizeUrl(item.url),
          title: cleanTitle(item.title, item.url),
          domain,
          visitTime: Number(visit.visitTime),
          transition: visit.transition || 'unknown'
        });
      }
    }
    events.sort((a, b) => a.visitTime - b.visitTime || a.url.localeCompare(b.url));
    let sessionId = 0;
    for (let i = 0; i < events.length; i++) {
      const current = events[i];
      const next = events[i + 1];
      current.sessionId = sessionId;
      if (!next) {
        current.dwellMs = 0;
        current.nextGapMs = 0;
        current.endsSession = true;
        continue;
      }
      const gap = Math.max(0, next.visitTime - current.visitTime);
      current.nextGapMs = gap;
      current.dwellMs = Math.min(gap, cfg.dwellCapMs);
      current.endsSession = gap > cfg.sessionBreakMs;
      if (current.endsSession) sessionId++;
    }
    return {
      historyItems: historyItems || [],
      events,
      coverage: summarizeCoverage(historyItems || [], events, cfg)
    };
  }

  function summarizeCoverage(historyItems, events, config) {
    const urls = new Set((historyItems || []).map(item => item.url).filter(Boolean));
    const expandedUrls = new Set(events.map(event => event.url));
    const start = events.length ? events[0].visitTime : null;
    const end = events.length ? events[events.length - 1].visitTime : null;
    const estimatedActiveMs = events.reduce((sum, event) => sum + (event.dwellMs || 0), 0);
    const sessionCount = events.length ? new Set(events.map(event => event.sessionId)).size : 0;
    return {
      urlsScanned: urls.size,
      urlsExpanded: expandedUrls.size,
      visitsExpanded: events.length,
      startTime: start,
      endTime: end,
      days: config.days,
      estimatedActiveMs,
      estimatedActiveMinutes: msToMinutes(estimatedActiveMs),
      sessionCount,
      dwellMethod: 'estimated from time until next visit, capped at 30 minutes'
    };
  }

  function summarizeCategorizedCoverage(allPages, categorizedPages, events) {
    const categorizedUrls = new Set((categorizedPages || []).map(page => page.normalizedUrl));
    const categorizedEvents = events.filter(event => categorizedUrls.has(event.normalizedUrl));
    const estimatedActiveMs = categorizedEvents.reduce((sum, event) => sum + (event.dwellMs || 0), 0);
    return {
      pagesAvailable: allPages.length,
      pagesAnalyzed: categorizedPages.length,
      visitsCategorized: categorizedEvents.length,
      estimatedActiveMs,
      estimatedActiveMinutes: msToMinutes(estimatedActiveMs),
      visitCoverage: events.length ? categorizedEvents.length / events.length : 0,
      activeTimeCoverage: events.length
        ? estimatedActiveMs / Math.max(events.reduce((sum, event) => sum + (event.dwellMs || 0), 0), 1)
        : 0
    };
  }

  function aggregatePages(events) {
    const pages = new Map();
    for (const event of events) {
      const key = event.normalizedUrl || normalizeUrl(event.url);
      if (!pages.has(key)) {
        pages.set(key, {
          id: `page-${hashString(key)}`,
          url: event.url,
          normalizedUrl: key,
          title: event.title,
          domain: event.domain,
          visitCount: 0,
          estimatedDwellMs: 0,
          firstVisitTime: event.visitTime,
          lastVisitTime: event.visitTime,
          tokens: tokenize(`${event.title} ${event.domain} ${event.url}`)
        });
      }
      const page = pages.get(key);
      page.visitCount++;
      page.estimatedDwellMs += event.dwellMs || 0;
      page.firstVisitTime = Math.min(page.firstVisitTime, event.visitTime);
      page.lastVisitTime = Math.max(page.lastVisitTime, event.visitTime);
    }
    return Array.from(pages.values()).sort((a, b) => {
      const scoreA = a.visitCount * 3 + msToMinutes(a.estimatedDwellMs);
      const scoreB = b.visitCount * 3 + msToMinutes(b.estimatedDwellMs);
      return scoreB - scoreA || a.title.localeCompare(b.title);
    });
  }

  function fallbackPageVector(page) {
    const tokens = page.tokens && page.tokens.length ? page.tokens : tokenize(pageText(page));
    const vector = new Array(96).fill(0);
    for (const token of tokens) {
      vector[parseInt(hashString(token), 36) % vector.length] += 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
    return vector.map(n => n / norm);
  }

  function crossDomainAdjustedScore(vectorScore, tokenScore, sameDomain, config) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    if (sameDomain) return vectorScore;
    if (tokenScore < cfg.crossDomainWeakTokenThreshold) return Math.min(vectorScore, cfg.topicClusterThreshold - 0.06);
    if (tokenScore < cfg.crossDomainStrongTokenThreshold) return Math.min(vectorScore, cfg.topicClusterThreshold - 0.01);
    return vectorScore;
  }

  function contentSimilarity(page, cluster, config) {
    const vectorScore = cosine(page.embedding, cluster.centroid);
    const tokenScore = jaccard(page.tokens, cluster.keywords || []);
    const sameDomain = cluster.domains.has(page.domain);
    const domainScore = sameDomain ? 0.04 : 0;
    const adjustedVectorScore = crossDomainAdjustedScore(vectorScore, tokenScore, sameDomain, config);
    return Math.max(adjustedVectorScore, tokenScore * 0.85 + domainScore);
  }

  function clusterSimilarity(left, right, config) {
    const vectorScore = cosine(left.centroid, right.centroid);
    const tokenScore = jaccard(left.keywords || [], right.keywords || []);
    let sameDomain = false;
    for (const domain of left.domains || []) {
      if (right.domains && right.domains.has(domain)) {
        sameDomain = true;
        break;
      }
    }
    const adjustedVectorScore = crossDomainAdjustedScore(vectorScore, tokenScore, sameDomain, config);
    return Math.max(adjustedVectorScore, tokenScore * 0.85 + (sameDomain ? 0.04 : 0));
  }

  function buildInitialClusters(pages, config) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    const clusters = [];
    for (const page of pages) {
      page.embedding = page.embedding || fallbackPageVector(page);
      let best = null;
      let bestScore = -Infinity;
      for (const cluster of clusters) {
        const score = contentSimilarity(page, cluster, cfg);
        if (score > bestScore) {
          bestScore = score;
          best = cluster;
        }
      }
      if (!best || bestScore < cfg.topicClusterThreshold || clusters.length < 1) {
        clusters.push({
          id: `topic-${clusters.length + 1}`,
          pages: [page],
          centroid: page.embedding,
          domains: new Set([page.domain]),
          keywords: page.tokens.slice(0, 20),
          cohesionSamples: []
        });
      } else {
        best.pages.push(page);
        best.domains.add(page.domain);
        best.centroid = averageVectors(best.pages.map(p => p.embedding));
        best.keywords = keywordSummary(best.pages, 24);
        best.cohesionSamples.push(bestScore);
      }
    }

    while (clusters.length > cfg.maxTopicCount) {
      let bestPair = null;
      let bestScore = -Infinity;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const score = clusterSimilarity(clusters[i], clusters[j], cfg);
          if (score > bestScore) {
            bestScore = score;
            bestPair = [i, j];
          }
        }
      }
      if (!bestPair || bestScore < cfg.topicMergeThreshold) break;
      const [targetIndex, sourceIndex] = bestPair;
      const target = clusters[targetIndex];
      const source = clusters[sourceIndex];
      target.pages.push(...source.pages);
      target.pages.sort((a, b) => pageImportanceScore(b) - pageImportanceScore(a) || a.title.localeCompare(b.title));
      for (const domain of source.domains) target.domains.add(domain);
      target.centroid = averageVectors(target.pages.map(p => p.embedding));
      target.keywords = keywordSummary(target.pages, 24);
      target.cohesionSamples.push(bestScore);
      clusters.splice(sourceIndex, 1);
    }

    return clusters.map((cluster, index) => finalizeClusterSkeleton(cluster, index));
  }

  function finalizeClusterSkeleton(cluster, index) {
    cluster.pages.sort((a, b) => pageImportanceScore(b) - pageImportanceScore(a) || a.title.localeCompare(b.title));
    const visitCount = cluster.pages.reduce((sum, page) => sum + page.visitCount, 0);
    const estimatedDwellMs = cluster.pages.reduce((sum, page) => sum + page.estimatedDwellMs, 0);
    const topDomains = Array.from(cluster.domains).map(domain => ({
      domain,
      visitCount: cluster.pages.filter(page => page.domain === domain).reduce((sum, page) => sum + page.visitCount, 0),
      estimatedDwellMs: cluster.pages.filter(page => page.domain === domain).reduce((sum, page) => sum + page.estimatedDwellMs, 0)
    })).sort((a, b) => b.visitCount - a.visitCount).slice(0, 5);
    const cohesion = cluster.cohesionSamples.length
      ? cluster.cohesionSamples.reduce((sum, n) => sum + n, 0) / cluster.cohesionSamples.length
      : 0.55;
    const dominantDomainVisits = topDomains[0] ? topDomains[0].visitCount : 0;
    const dominantDomainShare = visitCount ? dominantDomainVisits / visitCount : 0;
    const mixedDomainPenalty = topDomains.length >= 4 && dominantDomainShare < 0.55 ? 0.12 : 0;
    const thinEvidencePenalty = cluster.pages.length < 3 ? 0.08 : 0;
    const keywords = keywordSummary(cluster.pages, 10);
    return {
      id: `topic-${index + 1}`,
      label: labelFromKeywords(keywords, topDomains),
      confidence: clamp(
        0.40 + cohesion * 0.42 + Math.min(cluster.pages.length, 8) * 0.015 - mixedDomainPenalty - thinEvidencePenalty,
        0.25,
        0.9
      ),
      rationale: 'Initial local grouping based on page title, URL tokens, and embedding similarity.',
      keywords,
      topDomains,
      topPages: cluster.pages.slice(0, 8).map(pageEvidence),
      pageUrls: cluster.pages.map(page => page.normalizedUrl),
      pageIds: cluster.pages.map(page => page.id),
      visitCount,
      estimatedDwellMs,
      estimatedDwellMinutes: msToMinutes(estimatedDwellMs),
      centroid: cluster.centroid,
      color: TOPIC_COLORS[index % TOPIC_COLORS.length],
      llmLabeled: false
    };
  }

  function labelFromKeywords(keywords, topDomains) {
    if (keywords && keywords.length >= 2) {
      return keywords.slice(0, 2).map(capitalize).join(' ');
    }
    if (topDomains && topDomains[0]) return topDomains[0].domain;
    return 'Browsing topic';
  }

  function capitalize(text) {
    const value = String(text || '');
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function pageEvidence(page) {
    return {
      id: page.id,
      title: page.title,
      url: page.url,
      domain: page.domain,
      visitCount: page.visitCount,
      estimatedDwellMs: page.estimatedDwellMs,
      estimatedDwellMinutes: msToMinutes(page.estimatedDwellMs),
      firstVisitTime: page.firstVisitTime,
      lastVisitTime: page.lastVisitTime
    };
  }

  async function labelTopicsWithLlm(topics, config) {
    if (!topics.length) return topics;
    const cfg = { ...DEFAULTS, ...(config || {}) };
    const labels = [];
    for (let i = 0; i < topics.length; i += cfg.topicLabelBatchSize) {
      const batch = topics.slice(i, i + cfg.topicLabelBatchSize);
      const payload = batch.map(topic => ({
        id: topic.id,
        keywords: topic.keywords,
        top_domains: topic.topDomains.map(d => d.domain),
        visits: topic.visitCount,
        estimated_minutes: topic.estimatedDwellMinutes,
        pages: topic.topPages.slice(0, 6).map(page => ({
          title: page.title,
          url: formatUrlForPrompt(page.url),
          visits: page.visitCount
        }))
      }));
      const prompt = [
        'Label these browser-history topic clusters.',
        'Return JSON shaped as {"topics":[{"id":"topic-1","label":"short noun phrase","confidence":0.0-1.0,"rationale":"one sentence explaining why these pages belong together"}]}.',
        'Use specific labels. If a cluster is genuinely mixed, say so in the label and lower confidence instead of inventing a theme.',
        JSON.stringify(payload)
      ].join('\n\n');
      const data = await chatJson(prompt, cfg);
      labels.push(...(Array.isArray(data.topics) ? data.topics : []));
      if (cfg.onProgress) cfg.onProgress(`Labeling topics ${Math.min(i + cfg.topicLabelBatchSize, topics.length)} of ${topics.length}`);
    }
    const byId = new Map(labels.map(item => [item.id, item]));
    return topics.map(topic => {
      const label = byId.get(topic.id);
      if (!label) return topic;
      return {
        ...topic,
        label: String(label.label || topic.label).slice(0, 48),
        confidence: clamp(Number(label.confidence) || topic.confidence, 0, 1),
        rationale: String(label.rationale || topic.rationale).slice(0, 500),
        llmLabeled: true
      };
    });
  }

  function mapPagesToTopics(pages, topics) {
    const pageToTopic = new Map();
    for (const topic of topics) {
      for (const pageId of topic.pageIds) pageToTopic.set(pageId, topic.id);
    }
    const urlToPage = new Map(pages.map(page => [page.normalizedUrl, page]));
    return { pageToTopic, urlToPage };
  }

  function representativeVisit(from, to) {
    return {
      from: {
        title: from.title,
        url: from.url,
        domain: from.domain,
        visitTime: from.visitTime
      },
      to: {
        title: to.title,
        url: to.url,
        domain: to.domain,
        visitTime: to.visitTime
      },
      gapMs: to.visitTime - from.visitTime,
      estimatedGapMinutes: msToMinutes(to.visitTime - from.visitTime)
    };
  }

  function buildTopicTransitions(events, pages, topics, config) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    const { urlToPage } = mapPagesToTopics(pages, topics);
    const pageIdToTopic = new Map();
    for (const topic of topics) for (const pageId of topic.pageIds) pageIdToTopic.set(pageId, topic.id);
    const topicById = new Map(topics.map(topic => [topic.id, topic]));
    const transitions = new Map();
    for (let i = 0; i < events.length - 1; i++) {
      const from = events[i];
      const to = events[i + 1];
      if (from.endsSession) continue;
      const fromPage = urlToPage.get(from.normalizedUrl);
      const toPage = urlToPage.get(to.normalizedUrl);
      if (!fromPage || !toPage) continue;
      const sourceTopicId = pageIdToTopic.get(fromPage.id);
      const targetTopicId = pageIdToTopic.get(toPage.id);
      if (!sourceTopicId || !targetTopicId) continue;
      const key = `${sourceTopicId}->${targetTopicId}`;
      if (!transitions.has(key)) {
        const source = topicById.get(sourceTopicId);
        const target = topicById.get(targetTopicId);
        const similarity = sourceTopicId === targetTopicId ? 1 : cosine(source.centroid, target.centroid);
        const fallbackType = classifyTransitionType(sourceTopicId, targetTopicId, similarity, cfg);
        transitions.set(key, {
          id: `transition-${hashString(key)}`,
          sourceTopicId,
          targetTopicId,
          sourceLabel: source.label,
          targetLabel: target.label,
          similarity,
          type: fallbackType,
          label: TRANSITION_TYPES[fallbackType].label,
          color: TRANSITION_TYPES[fallbackType].color,
          confidence: fallbackType === 'same_topic_flow' ? 0.88 : clamp(0.45 + Math.abs(similarity - cfg.adjacentTopicThreshold) * 0.45, 0.35, 0.82),
          rationale: 'Initial transition estimate from topic similarity and observed consecutive visits.',
          visitCount: 0,
          estimatedGapMsTotal: 0,
          representativeVisits: [],
          llmLabeled: false
        });
      }
      const transition = transitions.get(key);
      transition.visitCount++;
      transition.estimatedGapMsTotal += Math.max(0, to.visitTime - from.visitTime);
      if (transition.representativeVisits.length < 4) transition.representativeVisits.push(representativeVisit(from, to));
    }
    return Array.from(transitions.values()).map(transition => ({
      ...transition,
      estimatedGapMs: transition.visitCount ? Math.round(transition.estimatedGapMsTotal / transition.visitCount) : 0,
      estimatedGapMinutes: transition.visitCount ? msToMinutes(transition.estimatedGapMsTotal / transition.visitCount) : 0
    })).sort((a, b) => b.visitCount - a.visitCount || b.confidence - a.confidence);
  }

  function classifyTransitionType(sourceTopicId, targetTopicId, similarity, config) {
    if (sourceTopicId === targetTopicId) return 'same_topic_flow';
    if (similarity >= config.adjacentTopicThreshold) return 'adjacent_topic_jump';
    return 'topic_switch';
  }

  function normalizeTransitionType(type) {
    const value = String(type || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (TRANSITION_TYPES[value]) return value;
    if (value.includes('adjacent')) return 'adjacent_topic_jump';
    if (value.includes('switch')) return 'topic_switch';
    return null;
  }

  async function labelTransitionsWithLlm(transitions, topics, config) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    const top = transitions.filter(t => t.sourceTopicId !== t.targetTopicId).slice(0, 40);
    if (!top.length) return transitions;
    const topicById = new Map(topics.map(topic => [topic.id, topic]));
    const labels = [];
    for (let i = 0; i < top.length; i += cfg.transitionLabelBatchSize) {
      const batch = top.slice(i, i + cfg.transitionLabelBatchSize);
      const payload = batch.map(transition => ({
        id: transition.id,
        source_topic: topicById.get(transition.sourceTopicId)?.label,
        target_topic: topicById.get(transition.targetTopicId)?.label,
        similarity: Number(transition.similarity.toFixed(3)),
        visit_count: transition.visitCount,
        examples: transition.representativeVisits.slice(0, 3).map(item => ({
          from: item.from.title,
          to: item.to.title,
          gap_minutes: item.estimatedGapMinutes
        }))
      }));
      const prompt = [
        'Classify these observed topic transitions from browser history.',
        'Allowed type values: adjacent_topic_jump, topic_switch.',
        'Return JSON shaped as {"transitions":[{"id":"transition-id","source_topic":"source label","target_topic":"target label","type":"adjacent_topic_jump|topic_switch","confidence":0.0-1.0,"rationale":"one sentence using the examples"}]}.',
        'Copy every id exactly from the input. Do not invent or shorten ids.',
        'Use adjacent_topic_jump only when the examples show the same task, project, venue, event, or research thread continuing across topics.',
        'Use topic_switch when the examples look like a real task/context change.',
        JSON.stringify(payload)
      ].join('\n\n');
      const data = await chatJson(prompt, cfg);
      labels.push(...(Array.isArray(data.transitions) ? data.transitions : []));
      if (cfg.onProgress) cfg.onProgress(`Auditing transitions ${Math.min(i + cfg.transitionLabelBatchSize, top.length)} of ${top.length}`);
    }
    const byId = new Map(labels.map(item => [String(item.id || item.transition_id || item.transitionId || ''), item]));
    const byRoute = new Map(labels.map(item => [
      `${String(item.source_topic || item.source || '').toLowerCase()}->${String(item.target_topic || item.target || '').toLowerCase()}`,
      item
    ]));
    return transitions.map(transition => {
      if (transition.sourceTopicId === transition.targetTopicId) return transition;
      const routeKey = `${String(transition.sourceLabel || '').toLowerCase()}->${String(transition.targetLabel || '').toLowerCase()}`;
      const label = byId.get(transition.id) || byRoute.get(routeKey);
      const normalizedType = normalizeTransitionType(label && label.type);
      if (!label || !TRANSITION_TYPES[normalizedType]) return transition;
      return {
        ...transition,
        type: normalizedType,
        label: TRANSITION_TYPES[normalizedType].label,
        color: TRANSITION_TYPES[normalizedType].color,
        confidence: clamp(Number(label.confidence) || transition.confidence, 0, 1),
        rationale: String(label.rationale || transition.rationale).slice(0, 500),
        llmLabeled: true
      };
    });
  }

  function buildMetrics(events, topics, transitions, coverage) {
    const activeHours = Math.max(coverage.estimatedActiveMs / 3600000, 0.01);
    const sameTopicTransitions = transitions.filter(t => t.sourceTopicId === t.targetTopicId);
    const crossTopicTransitions = transitions.filter(t => t.sourceTopicId !== t.targetTopicId);
    const topicSwitchTransitions = crossTopicTransitions.filter(t => t.type === 'topic_switch');
    const adjacentTransitions = crossTopicTransitions.filter(t => t.type === 'adjacent_topic_jump');
    const sameTopicCount = sameTopicTransitions.reduce((sum, t) => sum + t.visitCount, 0);
    const switchCount = topicSwitchTransitions.reduce((sum, t) => sum + t.visitCount, 0);
    const adjacentJumpCount = adjacentTransitions.reduce((sum, t) => sum + t.visitCount, 0);
    const switchBurdenPerActiveHour = switchCount / activeHours;
    const runs = buildFocusedRuns(events, topics);
    const topRuns = runs.slice()
      .sort((a, b) => b.estimatedDwellMs - a.estimatedDwellMs || b.visitCount - a.visitCount)
      .slice(0, 10);
    const recentRuns = runs.slice(-12).reverse();
    const sortedDurations = runs.map(run => run.estimatedDwellMs).sort((a, b) => a - b);
    const medianRun = sortedDurations.length ? sortedDurations[Math.floor(sortedDurations.length / 2)] : 0;
    const longestRun = runs.reduce((best, run) => run.estimatedDwellMs > (best?.estimatedDwellMs || 0) ? run : best, null);
    const totalObservedTransitions = sameTopicCount + adjacentJumpCount + switchCount;
    return {
      dataCoverage: coverage,
      topicTimeShare: topics.map(topic => ({
        topicId: topic.id,
        label: topic.label,
        confidence: topic.confidence,
        visitCount: topic.visitCount,
        estimatedDwellMs: topic.estimatedDwellMs,
        estimatedDwellMinutes: topic.estimatedDwellMinutes,
        share: coverage.estimatedActiveMs ? topic.estimatedDwellMs / coverage.estimatedActiveMs : 0,
        rank: topic.attentionRank,
        band: topic.attentionBand,
        bandLabel: topic.attentionBandLabel,
        color: topic.color,
        topDomains: topic.topDomains
      })).sort((a, b) => b.estimatedDwellMs - a.estimatedDwellMs),
      transitionMix: {
        totalObservedTransitions,
        items: [
          {
            type: 'same_topic_flow',
            label: TRANSITION_TYPES.same_topic_flow.label,
            count: sameTopicCount,
            share: totalObservedTransitions ? sameTopicCount / totalObservedTransitions : 0,
            color: TRANSITION_TYPES.same_topic_flow.color,
            description: TRANSITION_TYPES.same_topic_flow.description
          },
          {
            type: 'adjacent_topic_jump',
            label: TRANSITION_TYPES.adjacent_topic_jump.label,
            count: adjacentJumpCount,
            share: totalObservedTransitions ? adjacentJumpCount / totalObservedTransitions : 0,
            color: TRANSITION_TYPES.adjacent_topic_jump.color,
            description: TRANSITION_TYPES.adjacent_topic_jump.description
          },
          {
            type: 'topic_switch',
            label: TRANSITION_TYPES.topic_switch.label,
            count: switchCount,
            share: totalObservedTransitions ? switchCount / totalObservedTransitions : 0,
            color: TRANSITION_TYPES.topic_switch.color,
            description: TRANSITION_TYPES.topic_switch.description
          }
        ]
      },
      switchBurden: {
        switchCount,
        adjacentJumpCount,
        sameTopicCount,
        crossTopicMovementCount: switchCount + adjacentJumpCount,
        activeHours: Number(activeHours.toFixed(2)),
        switchesPerActiveHour: Number(switchBurdenPerActiveHour.toFixed(2)),
        representativeTransitions: topicSwitchTransitions.slice(0, 5),
        adjacentExamples: adjacentTransitions.slice(0, 5)
      },
      focusedRuns: {
        longestRun,
        medianEstimatedDwellMs: medianRun,
        medianEstimatedDwellMinutes: msToMinutes(medianRun),
        runCount: runs.length,
        topRuns,
        recentRuns
      }
    };
  }

  function buildFocusedRuns(events, topics) {
    const topicForUrl = new Map();
    for (const topic of topics) for (const url of topic.pageUrls || []) topicForUrl.set(url, topic);
    const runs = [];
    let current = null;
    for (const event of events) {
      const topic = topicForUrl.get(event.normalizedUrl);
      if (!topic) continue;
      if (!current || current.topicId !== topic.id || current.lastEvent?.endsSession) {
        if (current) runs.push(current);
        current = {
          topicId: topic.id,
          label: topic.label,
          visitCount: 0,
          estimatedDwellMs: 0,
          startTime: event.visitTime,
          endTime: event.visitTime,
          pages: [],
          lastEvent: null
        };
      }
      current.visitCount++;
      current.estimatedDwellMs += event.dwellMs || 0;
      current.endTime = event.visitTime;
      current.pages.push({ title: event.title, url: event.url, domain: event.domain });
      current.lastEvent = event;
    }
    if (current) runs.push(current);
    return runs.map(run => ({
      ...run,
      estimatedDwellMinutes: msToMinutes(run.estimatedDwellMs),
      pages: run.pages.slice(0, 6),
      lastEvent: undefined
    }));
  }

  function buildValidationQueue(topics, transitions) {
    const queue = [];
    for (const topic of topics) {
      if (topic.confidence < 0.68 || !topic.llmLabeled) {
        queue.push({
          id: `validate-${topic.id}`,
          kind: 'topic',
          targetId: topic.id,
          title: topic.label,
          confidence: topic.confidence,
          reason: topic.llmLabeled ? 'Low topic confidence' : 'Topic did not receive an LLM label',
          evidence: topic.topPages.slice(0, 4)
        });
      }
    }
    for (const transition of transitions) {
      const borderline = transition.sourceTopicId !== transition.targetTopicId &&
        (!transition.llmLabeled || transition.confidence < 0.7 || Math.abs(transition.similarity - DEFAULTS.adjacentTopicThreshold) < 0.08);
      if (borderline) {
        queue.push({
          id: `validate-${transition.id}`,
          kind: 'transition',
          targetId: transition.id,
          title: `${transition.sourceLabel} -> ${transition.targetLabel}`,
          confidence: transition.confidence,
          reason: transition.llmLabeled
            ? 'Transition label is low confidence or near the boundary'
            : 'Transition did not receive an LLM audit label',
          evidence: transition.representativeVisits.slice(0, 3)
        });
      }
    }
    return queue.sort((a, b) => a.confidence - b.confidence).slice(0, 40);
  }

  function assignTopicVisuals(topics, coverage) {
    const totalMs = Math.max(coverage && coverage.estimatedActiveMs ? coverage.estimatedActiveMs : 0, 1);
    const ranked = topics.slice().sort((a, b) =>
      b.estimatedDwellMs - a.estimatedDwellMs || b.visitCount - a.visitCount || a.label.localeCompare(b.label)
    );
    const rankById = new Map(ranked.map((topic, index) => [
      topic.id,
      {
        rank: index + 1,
        share: topic.estimatedDwellMs / totalMs
      }
    ]));
    return topics.map(topic => {
      const rankedTopic = rankById.get(topic.id) || { rank: topics.indexOf(topic) + 1, share: 0 };
      const band = rankedTopic.rank <= 3
        ? 'primary'
        : rankedTopic.rank <= 10 || rankedTopic.share >= 0.035
          ? 'secondary'
          : 'long_tail';
      const palette = ATTENTION_BAND_COLORS[band];
      return {
        ...topic,
        attentionRank: rankedTopic.rank,
        attentionShare: rankedTopic.share,
        attentionBand: band,
        attentionBandLabel: ATTENTION_BANDS[band].label,
        color: palette[(rankedTopic.rank - 1) % palette.length]
      };
    });
  }

  async function analyzeVisitEvents(events, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    if (!events || !events.length) {
      const emptyCoverage = summarizeCoverage([], [], cfg);
      return emptyAnalysis(emptyCoverage, cfg, 'No visits were available in this time range.');
    }
    const coverage = summarizeCoverage(
      Array.from(new Map(events.map(event => [event.url, { url: event.url }])).values()),
      events,
      cfg
    );
    const allPages = aggregatePages(events);
    const pagesForAi = allPages.slice(0, cfg.maxPagesForAi);
    const categorizedCoverage = summarizeCategorizedCoverage(allPages, pagesForAi, events);
    const usingOllama = cfg.useOllama !== false;
    if (usingOllama) {
      const texts = pagesForAi.map(pageText);
      const { embeddings, cachedCount, embeddedCount } = await embedTextsCached(texts, cfg);
      if (cfg.onProgress && cachedCount) cfg.onProgress(`Reused ${cachedCount} cached embeddings, computed ${embeddedCount} new`);
      pagesForAi.forEach((page, index) => { page.embedding = embeddings[index]; });
    }
    const pages = pagesForAi.map(page => ({ ...page, embedding: page.embedding || fallbackPageVector(page) }));
    const clusterConfig = usingOllama ? cfg : { ...cfg, topicClusterThreshold: cfg.fallbackTopicClusterThreshold };
    let topics = buildInitialClusters(pages, clusterConfig);
    if (usingOllama) topics = await labelTopicsWithLlm(topics, cfg);
    topics = assignTopicVisuals(topics, coverage);
    const transitions = usingOllama
      ? await labelTransitionsWithLlm(buildTopicTransitions(events, pages, topics, cfg), topics, cfg)
      : buildTopicTransitions(events, pages, topics, cfg);
    const metrics = buildMetrics(events, topics, transitions, coverage);
    const validationQueue = buildValidationQueue(topics, transitions);
    return {
      ok: true,
      version: VERSION,
      generatedAt: nowIso(),
      source: usingOllama ? 'local-ollama' : 'local-test',
      models: {
        embedding: usingOllama ? cfg.embeddingModel : 'fallback-test-vector',
        chat: usingOllama ? cfg.chatModel : 'none'
      },
      coverage,
      categorizedCoverage,
      topics,
      transitions,
      pages: pages.map(pageEvidence),
      metrics,
      validationQueue,
      warnings: [
        'Dwell time is estimated from browser history gaps and is capped at 30 minutes.',
        categorizedCoverage.pagesAnalyzed < categorizedCoverage.pagesAvailable
          ? `Topic metrics categorize the top ${categorizedCoverage.pagesAnalyzed} pages, covering ${Math.round(categorizedCoverage.activeTimeCoverage * 100)}% of estimated active time and ${Math.round(categorizedCoverage.visitCoverage * 100)}% of visits.`
          : null,
        usingOllama ? null : 'Synthetic/local fallback labels are for tests and demos only.'
      ].filter(Boolean)
    };
  }

  function emptyAnalysis(coverage, config, message) {
    return {
      ok: false,
      version: VERSION,
      generatedAt: nowIso(),
      source: 'none',
      models: {
        embedding: config.embeddingModel,
        chat: config.chatModel
      },
      coverage,
      categorizedCoverage: summarizeCategorizedCoverage([], [], []),
      topics: [],
      transitions: [],
      pages: [],
      metrics: buildMetrics([], [], [], coverage),
      validationQueue: [],
      warnings: [message]
    };
  }

  async function getStoredAnalysis() {
    const cached = await TrustStore.getAnalysis(LATEST_ANALYSIS_KEY);
    if (!cached || !cached.ok || cached.version !== VERSION) return null;
    const corrections = await TrustStore.getCorrections();
    return { ...applyCorrections(cached, corrections), fromCache: true };
  }

  async function saveLatestAnalysis(analysis) {
    await TrustStore.saveAnalysis(LATEST_ANALYSIS_KEY, analysis);
  }

  async function runAnalysis(options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    const onProgress = cfg.onProgress || function() {};
    // The stored analysis is served until the user explicitly re-runs, so opening
    // the map never triggers history expansion or Ollama work by itself.
    if (!cfg.forceRefresh) {
      const stored = await getStoredAnalysis();
      if (stored) return stored;
    }
    onProgress('Checking local Ollama models...');
    const health = await checkOllamaHealth(cfg);
    if (!health.ok) {
      return {
        ok: false,
        errorCode: 'OLLAMA_UNAVAILABLE',
        message: ollamaUnavailableMessage(health, cfg),
        health,
        version: VERSION,
        generatedAt: nowIso(),
        topics: [],
        transitions: [],
        validationQueue: [],
        warnings: [
          health.originRejected
            ? 'Ollama rejected the Chrome extension origin. Configure OLLAMA_ORIGINS for this extension before analyzing real browser history.'
            : 'Start Ollama and install the required local models before analyzing real browser history.'
        ]
      };
    }
    onProgress('Loading browser history...');
    const loaded = await loadHistoryEvents({ ...cfg, onProgress });
    onProgress(`Analyzing ${loaded.events.length} visits with local Ollama...`);
    const analysis = await analyzeVisitEvents(loaded.events, { ...cfg, useOllama: true });
    analysis.coverage = loaded.coverage;
    analysis.health = health;
    analysis.fingerprint = analysisFingerprint(loaded.events, cfg);
    applyCorrections(analysis, await TrustStore.getCorrections());
    await saveLatestAnalysis(analysis);
    return analysis;
  }

  function applyCorrections(analysis, corrections) {
    if (!analysis || !Array.isArray(corrections) || !corrections.length) return analysis;
    const topicById = new Map((analysis.topics || []).map(topic => [topic.id, topic]));
    for (const correction of corrections) {
      if (correction.kind === 'topic' && correction.label && topicById.has(correction.targetId)) {
        topicById.get(correction.targetId).label = correction.label;
        topicById.get(correction.targetId).userCorrected = true;
      }
      if (correction.kind === 'transition' && correction.type && TRANSITION_TYPES[correction.type]) {
        const transition = (analysis.transitions || []).find(item => item.id === correction.targetId);
        if (transition) {
          transition.type = correction.type;
          transition.label = TRANSITION_TYPES[correction.type].label;
          transition.color = TRANSITION_TYPES[correction.type].color;
          transition.userCorrected = true;
        }
      }
    }
    for (const transition of analysis.transitions || []) {
      if (topicById.has(transition.sourceTopicId)) transition.sourceLabel = topicById.get(transition.sourceTopicId).label;
      if (topicById.has(transition.targetTopicId)) transition.targetLabel = topicById.get(transition.targetTopicId).label;
    }
    if (analysis.metrics && Array.isArray(analysis.metrics.topicTimeShare)) {
      for (const item of analysis.metrics.topicTimeShare) {
        if (topicById.has(item.topicId)) item.label = topicById.get(item.topicId).label;
      }
      const longest = analysis.metrics.focusedRuns && analysis.metrics.focusedRuns.longestRun;
      if (longest && topicById.has(longest.topicId)) longest.label = topicById.get(longest.topicId).label;
    }
    analysis.userCorrectionsApplied = corrections.length;
    return analysis;
  }

  function analysisFingerprint(events, config) {
    const eventText = events.map(event => `${event.normalizedUrl}|${event.visitTime}`).join('\n');
    return hashString(`${VERSION}|${config.days}|${config.embeddingModel}|${config.chatModel}|${eventText}`);
  }

  function openDb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('attentionGraphTrustAudit', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('analyses')) db.createObjectStore('analyses', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('corrections')) db.createObjectStore('corrections', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('embeddings')) db.createObjectStore('embeddings', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const memoryStore = { analyses: new Map(), corrections: new Map(), embeddings: new Map() };

  const TrustStore = {
    async getAnalysis(key) {
      const db = await openDb();
      if (!db) return memoryStore.analyses.get(key) || null;
      return txGet(db, 'analyses', key).then(row => row ? row.value : null);
    },
    async saveAnalysis(key, value) {
      const row = { key, value, updatedAt: Date.now() };
      const db = await openDb();
      if (!db) {
        memoryStore.analyses.set(key, value);
        return;
      }
      return txPut(db, 'analyses', row);
    },
    async getCorrections() {
      const db = await openDb();
      if (!db) return Array.from(memoryStore.corrections.values());
      return txAll(db, 'corrections');
    },
    async saveCorrection(correction) {
      const key = correction.key || `${correction.kind}:${correction.targetId}`;
      const row = { ...correction, key, updatedAt: Date.now() };
      const db = await openDb();
      if (!db) {
        memoryStore.corrections.set(key, row);
        return row;
      }
      await txPut(db, 'corrections', row);
      return row;
    },
    async getEmbeddings(keys) {
      const db = await openDb();
      if (!db) return keys.map(key => memoryStore.embeddings.get(key) || null);
      return new Promise((resolve, reject) => {
        const tx = db.transaction('embeddings', 'readonly');
        const store = tx.objectStore('embeddings');
        const results = new Array(keys.length).fill(null);
        keys.forEach((key, index) => {
          const request = store.get(key);
          request.onsuccess = () => { results[index] = request.result ? request.result.value : null; };
        });
        tx.oncomplete = () => resolve(results);
        tx.onerror = () => reject(tx.error);
      });
    },
    async saveEmbeddings(rows) {
      const db = await openDb();
      if (!db) {
        for (const row of rows) memoryStore.embeddings.set(row.key, row.value);
        return;
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction('embeddings', 'readwrite');
        const store = tx.objectStore('embeddings');
        for (const row of rows) store.put({ ...row, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  };

  function txGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function txPut(db, storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function txAll(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  function createDemoAnalysis() {
    const base = Date.now() - 3 * 60 * 60 * 1000;
    const items = [
      { url: 'https://github.com/facebook/react/issues', title: 'React issue useEffect rerender' },
      { url: 'https://react.dev/reference/react/useEffect', title: 'React useEffect documentation' },
      { url: 'https://stackoverflow.com/questions/react-effect-loop', title: 'React effect loop question' },
      { url: 'https://nytimes.com/2026/05/02/business/markets.html', title: 'Markets and inflation update' },
      { url: 'https://wsj.com/finance/stocks', title: 'Stock market news' },
      { url: 'https://youtube.com/watch?v=abcd', title: 'Interview with startup founder' },
      { url: 'https://linear.app/project/roadmap', title: 'Product roadmap planning' },
      { url: 'https://notion.so/product-strategy', title: 'Product strategy notes' }
    ].map((item, index) => ({ ...item, lastVisitTime: base + index * 7 * 60000 }));
    const visits = {};
    items.forEach((item, index) => {
      visits[item.url] = [{ visitId: `demo-${index}`, visitTime: item.lastVisitTime, transition: 'typed' }];
    });
    const loaded = buildVisitEventsFromHistoryItems(items, visits, DEFAULTS);
    return analyzeVisitEvents(loaded.events, { useOllama: false });
  }

  return {
    VERSION,
    DEFAULTS,
    TRANSITION_TYPES,
    TOPIC_COLORS,
    ATTENTION_BANDS,
    TrustStore,
    aggregatePages,
    analyzeVisitEvents,
    analysisFingerprint,
    applyCorrections,
    assignTopicVisuals,
    buildInitialClusters,
    buildTopicTransitions,
    buildValidationQueue,
    buildVisitEventsFromHistoryItems,
    checkOllamaHealth,
    cosine,
    createDemoAnalysis,
    embedTexts,
    embedTextsCached,
    extractDomain,
    fallbackPageVector,
    getStoredAnalysis,
    hashString,
    loadHistoryEvents,
    msToMinutes,
    normalizeUrl,
    parseOllamaJson,
    runAnalysis,
    saveLatestAnalysis,
    tokenize
  };
});
