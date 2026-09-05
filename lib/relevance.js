// Utility-page detection (§4.1a).
//
// Some pages are mechanisms, not subjects. You pass through a Zoom SSO screen
// to get into a meeting; you open a vendor's download page to get a file. The
// visit happened and the record should say so, but the page is not something
// attention was *on*, and letting it into the clustering produces topics like
// "Workplace Zoom Authentication" that describe plumbing rather than interest.
//
// This is a factual classification -- is this page a destination or a step? --
// not a judgement about whether the time was well spent. Nothing here scores,
// ranks, or recommends. Detected pages are excluded from topics and reported
// in the uncategorized bucket with their reason, exactly like every other
// exclusion, so the coverage numbers stay honest about what was left out.
//
// Deliberately conservative: a page that is merely *boring* is still a page
// the user chose to look at. Only unambiguous plumbing is matched here.
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./text.js'));
  } else {
    root.CTRelevance = factory(root.CTText);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CTText) {
  'use strict';

  // Matched as whole path segments, never as substrings: /authorize is auth,
  // /author is not, and /downloads is a download page while
  // /downloadable-content is not.
  const AUTH_SEGMENTS = new Set([
    'login', 'log-in', 'logon', 'signin', 'sign-in', 'signon', 'sign-on',
    'signup', 'sign-up', 'register', 'registration',
    'auth', 'authenticate', 'authentication', 'authorize', 'authorization',
    'oauth', 'oauth2', 'openid', 'sso', 'saml', 'idp', 'callback',
    'logout', 'log-out', 'signout', 'sign-out',
    'mfa', '2fa', 'otp', 'verify', 'verification', 'consent', 'challenge',
    'password', 'reset-password', 'forgot-password', 'recover-password'
  ]);

  const TRANSACTIONAL_SEGMENTS = new Set([
    'download', 'downloads',
    'thank-you', 'thankyou', 'thanks',
    'confirmation', 'unsubscribe',
    'redirect', 'redirecting', 'interstitial'
  ]);

  const ERROR_SEGMENTS = new Set([
    '404', '403', '500', '502', '503',
    'error', 'errors', 'not-found', 'notfound', 'maintenance', 'unavailable'
  ]);

  // When one of these appears earlier in the path, everything after it is a
  // document name rather than a route: /wiki/Authorization is an encyclopedia
  // article about authorization, not an authorization endpoint. Without this
  // guard the segment lists below quietly swallow real reading.
  const CONTENT_CONTAINERS = new Set([
    'wiki', 'wikis', 'article', 'articles', 'blog', 'blogs', 'post', 'posts',
    'news', 'story', 'stories', 'question', 'questions', 'answer', 'answers',
    'doc', 'docs', 'documentation', 'guide', 'guides', 'tutorial', 'tutorials',
    'topic', 'topics', 'tag', 'tags', 'category', 'categories',
    'reference', 'glossary', 'encyclopedia', 'definition', 'dictionary',
    'course', 'courses', 'lesson', 'lessons', 'book', 'books',
    'paper', 'papers', 'abs', 'pdf', 'watch', 'video', 'videos', 'thread'
  ]);

  // A hostname whose first label is one of these is an identity endpoint
  // regardless of path -- login.microsoftonline.com, sso.acme.com, and every
  // company's own <tenant> auth host.
  const AUTH_HOST_LABELS = new Set([
    'login', 'signin', 'sign-in', 'logon', 'auth', 'authentication',
    'sso', 'idp', 'oauth', 'accounts', 'account'
  ]);

  // Full-host and suffix matches for identity providers that do not follow the
  // label convention above.
  const AUTH_HOSTS = [
    'appleid.apple.com', 'id.atlassian.com', 'login.live.com',
    'secure.login.gov', 'auth0.com', 'okta.com', 'oktapreview.com',
    'duosecurity.com', 'onelogin.com', 'pingidentity.com'
  ];

  // Titles are the weakest signal here, so a generic phrase has to be
  // essentially the *whole* title to count. "Thank You For The Music,
  // reviewed" and "Loading Dock Design" are articles that happen to start with
  // a status word; only anchored, self-contained phrases are plumbing.
  // `TAIL` allows the site-name suffix browsers put after a separator.
  const TAIL = '(?:\\s*[|\\u2013\\u2014\\-\\u00b7:]\\s*.{0,40})?';
  const whole = body => new RegExp(`^\\s*${body}[\\s.!\u2026]*${TAIL}\\s*$`, 'i');

  const TITLE_PATTERNS = [
    // Self-contained status messages.
    whole('redirecting'),
    whole('authenticating'),
    whole('loading'),
    whole('one moment'),
    whole('(?:please\\s+)?(?:wait|hold on)'),
    whole('thank you'),
    whole('thanks'),
    whole('(?:page\\s+)?not found'),
    whole('404'),
    whole('403'),
    whole('error(?:\\s+\\d{3})?'),
    whole('\\d{3}\\s+error'),
    whole('(?:sign|log)\\s*-?\\s*(?:in|out)'),
    whole('sign\\s*-?\\s*(?:in|up)\\s+or\\s+sign\\s*-?\\s*(?:in|up)'),
    whole('download'),

    // Phrases that are unambiguous wherever they appear.
    /\bsign in to (?:your |continue|access)/i,
    /^just a moment/i,
    /^checking your browser\b/i,
    /\bverify (?:you are|you're) (?:a )?human\b/i,
    /\bare you a robot\b/i,
    /^access denied\b/i,
    /\bthank you for your (?:order|purchase|submission|payment|request)\b/i
  ];

  function pathSegments(url) {
    try {
      const parsed = new URL(url);
      return parsed.pathname
        .toLowerCase()
        .split('/')
        .filter(Boolean)
        // Strip a trailing extension so /login.html and /404.php still match.
        .map(segment => segment.replace(/\.(html?|php|aspx?|jsp)$/, ''));
    } catch {
      return [];
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  // Returns null when the page looks like a real destination, or
  // { reason, rule } describing why it is plumbing.
  function classify(page, options) {
    const opts = options || {};
    const url = String((page && page.url) || '');
    if (!url) return null;
    const title = String((page && page.title) || '');
    const host = hostOf(url);
    const segments = pathSegments(url);

    const extra = opts.extraSegments instanceof Set
      ? opts.extraSegments
      : new Set((opts.extraSegments || []).map(s => String(s).toLowerCase()));

    if (host) {
      const firstLabel = host.split('.')[0];
      if (AUTH_HOST_LABELS.has(firstLabel)) {
        return { reason: 'utility_page', rule: `auth host: ${host}` };
      }
      for (const candidate of AUTH_HOSTS) {
        if (host === candidate || host.endsWith(`.${candidate}`)) {
          return { reason: 'utility_page', rule: `identity provider: ${host}` };
        }
      }
    }

    for (const segment of segments) {
      // Everything past a content container is a document name.
      if (CONTENT_CONTAINERS.has(segment)) break;
      if (AUTH_SEGMENTS.has(segment)) {
        return { reason: 'utility_page', rule: `auth path: /${segment}` };
      }
      if (TRANSACTIONAL_SEGMENTS.has(segment)) {
        return { reason: 'utility_page', rule: `transactional path: /${segment}` };
      }
      if (ERROR_SEGMENTS.has(segment)) {
        return { reason: 'utility_page', rule: `error path: /${segment}` };
      }
      if (extra.has(segment)) {
        return { reason: 'utility_page', rule: `user pattern: /${segment}` };
      }
    }

    const trimmedTitle = title.trim();
    if (trimmedTitle) {
      for (const pattern of TITLE_PATTERNS) {
        if (pattern.test(trimmedTitle)) {
          return { reason: 'utility_page', rule: `title: ${pattern}` };
        }
      }
    }

    return null;
  }

  function isUtilityPage(page, options) {
    return classify(page, options) !== null;
  }

  return {
    AUTH_HOSTS, AUTH_HOST_LABELS, AUTH_SEGMENTS, CONTENT_CONTAINERS, ERROR_SEGMENTS,
    TITLE_PATTERNS, TRANSACTIONAL_SEGMENTS,
    classify, isUtilityPage
  };
});
