'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), zlib = require('node:zlib'), path = require('node:path');
const E = require('../../tools/contextExperiment');
const recording = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, '../../fixtures/context/recording.json.gz'))));
assert.equal(recording.complete, true, 'a partial experiment is not a passing fixture');
assert.equal(recording.results.length, 3);
assert.ok(recording.calls.every(c => c.kind !== 'embed' || c.request.truncate === false), 'quality comparison never silently truncates');
E.run({ replay: true }).catch(error => { console.error(error); process.exitCode = 1; });
