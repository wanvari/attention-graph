#!/usr/bin/env node
// Explicit release allowlist: no git data, dependencies, tests, or model cache.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const version = require('../manifest.json').version;
const destination = path.join(root, 'dist', 'cognitive-trails');
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const name of ['manifest.json', 'background.js', 'icon16.png', 'icon48.png', 'icon128.png', 'lib', 'ui', 'content', 'offscreen', 'vendor', 'README.md', 'ARCHITECTURE.md', 'PRIVACY.md']) {
  fs.cpSync(path.join(root, name), path.join(destination, name), { recursive: true, filter: source => path.basename(source) !== 'mockups.html' });
}
fs.mkdirSync(path.join(destination, 'fixtures/current'), { recursive: true });
fs.copyFileSync(path.join(root, 'fixtures/current/snapshot.json'), path.join(destination, 'fixtures/current/snapshot.json'));
fs.mkdirSync(path.join(destination, 'validation'), { recursive: true });
for (const name of ['index.json', require('../validation/index.json').latest]) fs.copyFileSync(path.join(root, 'validation', name), path.join(destination, 'validation', name));
const archive = path.join(root, 'dist', `cognitive-trails-v${version}.zip`);
fs.rmSync(archive, { force: true });
execFileSync('zip', ['-q', '-r', archive, 'cognitive-trails', '-x', '*.DS_Store'], { cwd: path.join(root, 'dist') });
console.log(`Load unpacked: ${destination}\nArchive: ${archive}`);
