'use strict';
const assert = require('assert');
const CTText = require('../../lib/text.js');

// normalizeUrl (spec §0.3, §7.1)
assert.strictEqual(CTText.normalizeUrl('https://Example.com/Path/?q=1#frag'), 'https://example.com/Path');
assert.strictEqual(CTText.normalizeUrl('https://www.example.com/a/'), 'https://example.com/a');
assert.strictEqual(CTText.normalizeUrl('https://example.com/'), 'https://example.com/');
assert.strictEqual(CTText.normalizeUrl('https://example.com'), 'https://example.com/');
assert.strictEqual(CTText.normalizeUrl('http://example.com:8080/x'), 'http://example.com:8080/x');
assert.strictEqual(CTText.normalizeUrl('https://example.com:443/x'), 'https://example.com/x', 'default port dropped by URL parsing');
// IDN normalizes to punycode
assert.ok(CTText.normalizeUrl('https://münchen.example/straße').includes('xn--'));
// non-http(s) and malformed input returned unchanged
assert.strictEqual(CTText.normalizeUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
assert.strictEqual(CTText.normalizeUrl('data:text/plain,hello'), 'data:text/plain,hello');
assert.strictEqual(CTText.normalizeUrl('not a url at all'), 'not a url at all');
assert.strictEqual(CTText.normalizeUrl(''), '');
assert.strictEqual(CTText.normalizeUrl(null), '');
// normalization is idempotent
const once = CTText.normalizeUrl('https://WWW.Example.com/a/b/?x=1');
assert.strictEqual(CTText.normalizeUrl(once), once);

// tokenize
assert.deepStrictEqual(CTText.tokenize('The Rust async runtime'), ['rust', 'async', 'runtime']);
assert.deepStrictEqual(CTText.tokenize('snake_case-and-dashes'), ['snake', 'case', 'dashes']);
assert.deepStrictEqual(CTText.tokenize(''), []);

// cleanTitle
assert.strictEqual(CTText.cleanTitle('  A   Title  ', 'https://x.com/y'), 'A Title');
assert.strictEqual(CTText.cleanTitle('', 'https://example.com/docs/guide'), 'docs guide');
assert.strictEqual(CTText.cleanTitle('https://example.com/p', 'https://example.com/p'), 'p', 'title equal to URL falls back to path');
assert.strictEqual(CTText.cleanTitle('', 'https://example.com/'), 'example.com');

// hash stability
assert.strictEqual(CTText.hashString('hello world'), CTText.hashString('hello world'));
assert.notStrictEqual(CTText.hashString('hello world'), CTText.hashString('hello worlds'));
assert.strictEqual(typeof CTText.hashString(''), 'string');

// day-key arithmetic, DST-safe
assert.strictEqual(CTText.addDays('2026-03-07', 1), '2026-03-08');
assert.strictEqual(CTText.addDays('2026-03-08', 1), '2026-03-09', 'spring-forward day still advances by one');
assert.strictEqual(CTText.addDays('2026-03-01', -1), '2026-02-28');
assert.strictEqual(CTText.diffDays('2026-03-01', '2026-03-15'), 14);
assert.strictEqual(CTText.diffDays('2026-03-07', '2026-03-09'), 2, 'diff across DST is whole days');
assert.strictEqual(CTText.diffDays('2026-03-10', '2026-03-10'), 0);

// dayKeyFromMs uses the local calendar
const noon = new Date(2026, 2, 8, 12, 0, 0).getTime();
assert.strictEqual(CTText.dayKeyFromMs(noon), '2026-03-08');

console.log('text tests passed');
