'use strict';
const assert = require('assert');
const CTPrivacy = require('../../lib/privacy.js');
const CTText = require('../../lib/text.js');

// denylist domain patterns
assert.strictEqual(CTPrivacy.isExcluded('https://www.chase.com/account-overview'), true, '*.chase.com matches www');
assert.strictEqual(CTPrivacy.isExcluded('https://secure.chase.com/x'), true, 'subdomain matches');
assert.strictEqual(CTPrivacy.isExcluded('https://chase.com/x'), true, 'bare domain matches *.pattern');
assert.strictEqual(CTPrivacy.isExcluded('https://notchase.com/x'), false, 'suffix similarity is not a match');
assert.strictEqual(CTPrivacy.isExcluded('https://patient.mychart-hospital.example/portal'), true, '*mychart* substring matches');
assert.strictEqual(CTPrivacy.isExcluded('https://accounts.google.com/signin'), true);
assert.strictEqual(CTPrivacy.isExcluded('https://login.example-app.com/'), true, 'login.* leftmost label matches');
assert.strictEqual(CTPrivacy.isExcluded('https://auth.internal.example/x'), true);
assert.strictEqual(CTPrivacy.isExcluded('https://mail.google.com/mail/u/0'), true);
assert.strictEqual(CTPrivacy.isExcluded('https://example.com/article'), false);

// sensitive paths
for (const path of ['/checkout', '/payment/confirm', '/billing', '/login', '/signin/oauth', '/password', '/reset']) {
  assert.strictEqual(CTPrivacy.isExcluded(`https://shop.example.com${path}`), true, `${path} is sensitive`);
}
assert.strictEqual(CTPrivacy.isExcluded('https://shop.example.com/products'), false);
for (const path of ['/%6cogin', '/%256cogin', '/#/login?token=FAKE', '/#!/billing', '/?route=%2Fcheckout', '/?next=%252Fpassword', '/?access_token=FAKE', '/#access_token=FAKE']) {
  assert.strictEqual(CTPrivacy.isExcluded(`https://example.com${path}`), true, `${path} is denied before sanitization`);
}
assert.strictEqual(CTPrivacy.isExcluded('https://user:secret@example.com/article'), true, 'credentialed URLs excluded');
assert.strictEqual(CTPrivacy.isExcluded('ftp://example.com/article'), true, 'only http(s) capture is permitted');
assert.strictEqual(CTPrivacy.isExcluded('https://catalogin.example.com/article'), false, 'auth hostname pattern matches a label, not an interior substring');
assert.strictEqual(CTPrivacy.isExcluded('https://example.com/article?id=42'), false);
assert.strictEqual(CTPrivacy.isExcluded('https://example.com/#/article/42'), false);

// custom denylist replaces the default
assert.strictEqual(CTPrivacy.isExcluded('https://custom.example.com/x', ['custom.example.com']), true);

// malformed URLs are excluded (fail closed)
assert.strictEqual(CTPrivacy.isExcluded('not a url'), true);

// source tagging
assert.strictEqual(CTPrivacy.sourceForUrl('https://claude.ai/chat/abc'), 'llm_chat');
assert.strictEqual(CTPrivacy.sourceForUrl('https://chatgpt.com/c/xyz'), 'llm_chat');
assert.strictEqual(CTPrivacy.sourceForUrl('https://gemini.google.com/app'), 'llm_chat');
assert.strictEqual(CTPrivacy.sourceForUrl('https://example.com/x'), 'web');
assert.strictEqual(CTPrivacy.sourceForUrl('http://localhost:3000/chat'), 'web', 'local UIs are OFF by default');
assert.strictEqual(CTPrivacy.sourceForUrl('http://localhost:3000/chat', ['localhost']), 'llm_chat', 'but can be enabled');

// filtered domains
assert.strictEqual(CTPrivacy.isFilteredDomain('https://www.google.com/search?q=x'), true);
assert.strictEqual(CTPrivacy.isFilteredDomain('http://localhost:8080/x'), true);
assert.strictEqual(CTPrivacy.isFilteredDomain('https://example.com/'), false);

// pause intervals
const intervals = [{ start: 1000, end: 2000 }, { start: 5000, end: null }];
assert.strictEqual(CTPrivacy.inPauseInterval(1500, intervals), true);
assert.strictEqual(CTPrivacy.inPauseInterval(2000, intervals), false, 'end is exclusive');
assert.strictEqual(CTPrivacy.inPauseInterval(3000, intervals), false);
assert.strictEqual(CTPrivacy.inPauseInterval(9999999, intervals), true, 'open interval covers forward');

// fully paused days
{
  const dayStart = new Date(2026, 2, 10, 0, 0, 0).getTime();
  const fullDay = { start: dayStart - 3600000, end: dayStart + 25 * 3600000 };
  const partial = { start: new Date(2026, 2, 12, 9, 0).getTime(), end: new Date(2026, 2, 12, 17, 0).getTime() };
  const days = CTPrivacy.fullyPausedDays([fullDay, partial], CTText.dayKeyFromMs);
  assert.ok(days.has('2026-03-10'), 'fully covered day counts');
  assert.ok(!days.has('2026-03-12'), 'partially covered day does not');
}

console.log('privacy tests passed');
