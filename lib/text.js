// Text utilities shared by the sensor, pipeline, and UI.
// UMD: loadable via <script> in extension pages and require() in Node tests.
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

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

  function hashString(str) {
    let hash = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  const URL_IDENTITY_VERSION = 2;
  const TRACKING_PARAM = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|si|ref_src|ref_url)$/i;
  const SECRET_PARAM = /^(?:.*(?:token|password|passwd|secret|credential|authorization|session|api[_-]?key).*|code|auth|key|jwt|email|e-mail|phone|signature|sig|samlresponse|samlrequest|relaystate)$/i;

  function safeQuery(search) {
    const entries = [...new URLSearchParams(search)].filter(([key, value]) =>
      !TRACKING_PARAM.test(key) && !SECRET_PARAM.test(key) &&
      key.length <= 100 && value.length <= 1000);
    entries.sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
    return new URLSearchParams(entries).toString();
  }

  // Stored/reopenable URLs never include credentials, credential parameters,
  // or plain fragments (which can contain OAuth tokens). Preserve content
  // parameters and explicit SPA routes: dropping them collapses distinct
  // videos, articles and conversations into the same page.
  function sanitizeUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      parsed.username = '';
      parsed.password = '';
      parsed.search = safeQuery(parsed.search);
      const route = parsed.hash.slice(1).replace(/^!\//, '/');
      parsed.hash = '';
      if (route.startsWith('/')) {
        const [path, ...query] = route.split('?');
        const clean = safeQuery(query.join('?'));
        parsed.hash = path + (clean ? '?' + clean : '');
      }
      return parsed.href;
    } catch {
      return '';
    }
  }

  // Identity is distinct from the safe reopen URL. Ordinary anchors and
  // tracking variants deduplicate, while content query/hash routes do not.
  function normalizeUrl(url) {
    const raw = String(url || '');
    let parsed;
    try {
      parsed = new URL(sanitizeUrl(raw));
    } catch {
      return raw;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return raw;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${host}${port}${path}${parsed.search}${parsed.hash}`;
  }

  function extractDomain(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return String(url || '');
    }
  }

  function cleanTitle(title, url) {
    const text = String(title || '').replace(/\s+/g, ' ').trim();
    if (text && text !== String(url || '')) return text;
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

  function urlTokens(url) {
    return String(url || '')
      .replace(/^https?:\/\//, '')
      .replace(/[?#].*$/, '')
      .replace(/[\/._-]/g, ' ');
  }

  function keywordSummary(items, limit) {
    const counts = new Map();
    for (const item of items) {
      const text = [item.title, item.domain, item.url].filter(Boolean).join(' ');
      for (const token of tokenize(text)) {
        counts.set(token, (counts.get(token) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([token]) => token);
  }

  // Local-calendar day key in the machine's current zone.
  function dayKeyFromMs(ms) {
    const d = new Date(Number(ms));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Day-key arithmetic pinned to noon so DST transitions cannot shift the date.
  function dayKeyToNoonMs(dayKey) {
    const [y, m, d] = String(dayKey).split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
  }

  function addDays(dayKey, n) {
    return dayKeyFromMs(dayKeyToNoonMs(dayKey) + n * 24 * 3600 * 1000);
  }

  // Whole calendar days from a to b (positive when b is later).
  function diffDays(a, b) {
    return Math.round((dayKeyToNoonMs(b) - dayKeyToNoonMs(a)) / (24 * 3600 * 1000));
  }

  function msToMinutes(ms) {
    return Math.round((ms || 0) / 60000);
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  return {
    STOP_WORDS,
    URL_IDENTITY_VERSION,
    addDays,
    clamp,
    cleanTitle,
    dayKeyFromMs,
    dayKeyToNoonMs,
    diffDays,
    extractDomain,
    hashString,
    keywordSummary,
    msToMinutes,
    normalizeUrl,
    sanitizeUrl,
    tokenize,
    urlTokens,
    uuid
  };
});
