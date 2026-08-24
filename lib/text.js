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

  // Canonical page identity: scheme + lowercased host (www. stripped, default
  // ports dropped by URL parsing) + path without trailing slash. Query and
  // fragment are removed. Anything that is not http(s) or does not parse is
  // returned unchanged so junk input stays inert instead of throwing.
  function normalizeUrl(url) {
    const raw = String(url || '');
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return raw;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return raw;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${host}${port}${path}`;
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
    tokenize,
    urlTokens,
    uuid
  };
});
