// Privacy exclusions shared by the content script, service worker, and
// pipeline (spec §2.5, §2.7). Evaluated in the content script BEFORE anything
// is captured; excluded pages send nothing.
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CTPrivacy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // Default denylist (options page can extend it). Patterns: a leading `*.`
  // matches the domain and every subdomain; a leading `*` alone is a
  // substring match on the hostname; otherwise exact hostname match.
  const DEFAULT_DENYLIST = [
    // banks and finance
    '*.chase.com', '*.bankofamerica.com', '*.wellsfargo.com', '*.schwab.com',
    '*.fidelity.com', '*.vanguard.com', '*.paypal.com', '*.venmo.com', '*.coinbase.com',
    // health portals
    '*.mychart.org', '*mychart*',
    // password managers
    '*.1password.com', '*.lastpass.com', '*.bitwarden.com',
    // auth
    'accounts.google.com', 'login.*', 'auth.*', '*.okta.com', '*.auth0.com',
    // mail
    'mail.google.com', 'outlook.live.com', 'outlook.office.com'
  ];

  const SENSITIVE_PATH_PARTS = [
    '/checkout', '/payment', '/billing', '/login', '/signin', '/password', '/reset'
  ];

  const DEFAULT_LLM_CHAT_DOMAINS = [
    'claude.ai', 'chatgpt.com', 'chat.openai.com', 'gemini.google.com',
    'copilot.microsoft.com', 'perplexity.ai', 'chat.mistral.ai', 'poe.com',
    'chat.deepseek.com'
    // localhost:3000 / localhost:8080 local UIs are OFF by default (spec §2.5)
  ];

  // Domains dropped from ingest entirely (v3 list): search result pages and
  // local/extension noise. Captures and history must agree on what exists.
  const FILTERED_DOMAINS = [
    'google.com', 'bing.com', 'duckduckgo.com', 'localhost', '127.0.0.1', 'newtab'
  ];

  function hostnameOf(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function pathOf(url) {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return '';
    }
  }

  function domainMatches(hostname, pattern) {
    const p = String(pattern || '').toLowerCase().trim();
    if (!p) return false;
    if (p.startsWith('*.')) {
      const bare = p.slice(2);
      return hostname === bare || hostname.endsWith('.' + bare);
    }
    if (p.startsWith('*') || p.endsWith('*')) {
      const needle = p.replace(/\*/g, '');
      return needle ? hostname.includes(needle) : false;
    }
    if (p.endsWith('.*')) {
      // e.g. `login.*` — match the leftmost label
      const prefix = p.slice(0, -2);
      return hostname === prefix || hostname.startsWith(prefix + '.');
    }
    return hostname === p;
  }

  // True when the URL must never be captured or ingested.
  function isExcluded(url, denylist) {
    const hostname = hostnameOf(url);
    if (!hostname) return true;
    const list = Array.isArray(denylist) && denylist.length ? denylist : DEFAULT_DENYLIST;
    for (const pattern of list) {
      if (domainMatches(hostname, pattern)) return true;
    }
    const path = pathOf(url);
    for (const part of SENSITIVE_PATH_PARTS) {
      if (path.includes(part)) return true;
    }
    return false;
  }

  function isFilteredDomain(url) {
    return FILTERED_DOMAINS.includes(hostnameOf(url));
  }

  function sourceForUrl(url, llmChatDomains) {
    const hostname = hostnameOf(url);
    const list = Array.isArray(llmChatDomains) && llmChatDomains.length ? llmChatDomains : DEFAULT_LLM_CHAT_DOMAINS;
    for (const domain of list) {
      const d = String(domain).toLowerCase().trim();
      if (hostname === d || hostname.endsWith('.' + d)) return 'llm_chat';
    }
    return 'web';
  }

  // True when a timestamp falls inside any recorded pause interval.
  function inPauseInterval(timeMs, pauseIntervals) {
    for (const interval of pauseIntervals || []) {
      if (timeMs >= interval.start && timeMs < (interval.end ?? Infinity)) return true;
    }
    return false;
  }

  // Day keys fully covered by pause intervals (for dormancy subtraction).
  function fullyPausedDays(pauseIntervals, dayKeyFromMs) {
    const days = new Set();
    for (const interval of pauseIntervals || []) {
      if (!Number.isFinite(interval.end)) continue;
      let t = interval.start;
      while (t < interval.end) {
        const day = dayKeyFromMs(t);
        const dayStart = new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime();
        const dayEnd = dayStart + 24 * 3600 * 1000;
        if (interval.start <= dayStart && interval.end >= dayEnd) days.add(day);
        t = dayEnd;
      }
    }
    return days;
  }

  return {
    DEFAULT_DENYLIST,
    DEFAULT_LLM_CHAT_DOMAINS,
    FILTERED_DOMAINS,
    SENSITIVE_PATH_PARTS,
    domainMatches,
    fullyPausedDays,
    hostnameOf,
    inPauseInterval,
    isExcluded,
    isFilteredDomain,
    sourceForUrl
  };
});
