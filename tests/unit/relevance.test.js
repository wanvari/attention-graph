// Utility-page detection. The risk in a filter like this is not missing a
// login page, it is quietly swallowing a real one, so the negative cases
// matter more than the positive ones and are listed first.
'use strict';
const assert = require('assert');
const CTRelevance = require('../../lib/relevance.js');

const keep = (url, title, why) => {
  const verdict = CTRelevance.classify({ url, title });
  assert.strictEqual(verdict, null,
    `${url} ("${title}") was wrongly treated as plumbing${verdict ? ` via ${verdict.rule}` : ''} — ${why}`);
};
const plumbing = (url, title, why) => {
  const verdict = CTRelevance.classify({ url, title });
  assert.ok(verdict, `${url} ("${title}") should be plumbing — ${why}`);
  assert.strictEqual(verdict.reason, 'utility_page');
};

// ---- real pages that must survive ---------------------------------------
keep('https://en.wikipedia.org/wiki/Author', 'Author - Wikipedia',
  'segments match whole path parts, not substrings, so /wiki/Author is not /auth');
keep('https://en.wikipedia.org/wiki/Authorization', 'Authorization - Wikipedia',
  'an article *about* authorization is still an article');
keep('https://example.com/downloadable-content', 'Downloadable content guide',
  '"downloadable-content" is not "download"');
keep('https://docs.rs/tokio/latest/tokio/', 'tokio - Rust', 'library docs are a destination');
keep('https://www.kingarthurbaking.com/recipes/sourdough', 'Sourdough Bread Recipe', 'a recipe');
keep('https://arxiv.org/abs/2401.00001', 'Attention Is All You Need', 'a paper');
keep('https://news.ycombinator.com/', 'Hacker News', 'a front page');
keep('https://github.com/rust-lang/rust', 'rust-lang/rust: Empowering everyone', 'a repo');
keep('https://example.com/blog/thank-you-for-the-music', 'Thank You For The Music, reviewed',
  'the segment is "thank-you-for-the-music", not "thank-you"');
keep('https://myaccount.example.com/dashboard', 'Dashboard',
  'the host label is "myaccount", not "account"');
keep('https://example.com/', 'Error Prone - static analysis',
  'the title starts with "Error Prone", a product name, not an error page');

// ---- plumbing ------------------------------------------------------------
plumbing('https://acme.zoom.us/saml/login', 'Sign in - Zoom', 'SSO screen');
plumbing('https://zoom.us/download', 'Download Center - Zoom', 'vendor download page');
plumbing('https://accounts.google.com/o/oauth2/v2/auth', 'Sign in - Google Accounts', 'identity host');
plumbing('https://login.microsoftonline.com/common/oauth2/authorize', 'Sign in to your account', 'identity host');
plumbing('https://github.com/login/oauth/authorize', 'Authorize application', 'oauth grant');
plumbing('https://tenant.okta.com/app/whatever', 'Okta', 'identity provider suffix');
plumbing('https://example.com/404', 'Page not found', 'error page');
plumbing('https://example.com/login.html', 'Acme', 'extension is stripped before matching');
plumbing('https://example.com/anything', 'Just a moment...', 'Cloudflare interstitial by title');
plumbing('https://example.com/x', 'Redirecting…', 'interstitial by title');
plumbing('https://example.com/account/reset-password', 'Reset your password', 'credential flow');

// ---- title matching is anchored, not substring ---------------------------
keep('https://example.com/a', 'How I learned to stop worrying and sign in less',
  'the title mentions signing in but is not a sign-in page');

// ---- user-supplied extra segments ----------------------------------------
{
  const url = 'https://intranet.example.com/timesheet/entry';
  keep(url, 'Timesheet', 'not plumbing by default');
  const verdict = CTRelevance.classify({ url, title: 'Timesheet' }, { extraSegments: ['timesheet'] });
  assert.ok(verdict, 'a user-supplied segment should match');
  assert.match(verdict.rule, /user pattern/);
}

// ---- degenerate input ----------------------------------------------------
assert.strictEqual(CTRelevance.classify(null), null);
assert.strictEqual(CTRelevance.classify({ url: '' }), null);
assert.strictEqual(CTRelevance.classify({ url: 'not a url', title: 'x' }), null,
  'an unparseable URL is not evidence of plumbing');
assert.strictEqual(CTRelevance.isUtilityPage({ url: 'https://zoom.us/download', title: '' }), true);

console.log('relevance tests passed');
