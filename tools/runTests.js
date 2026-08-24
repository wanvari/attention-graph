#!/usr/bin/env node
// Runs every tests/**/*.test.js file in its own Node process, sequentially.
// Each test file is self-contained (node:assert, exits non-zero on failure).
// The e2e directory is excluded: those are Playwright suites run manually on
// the development machine (they need a real Chrome and, for some, Ollama).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function collect(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'e2e' || entry.name === 'node_modules') continue;
      out.push(...collect(full));
    } else if (entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

const files = collect(path.join(root, 'tests'));
if (!files.length) {
  console.error('No test files found under tests/');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  try {
    execFileSync(process.execPath, [file], { stdio: 'inherit', cwd: root });
    console.log(`ok   ${rel}`);
  } catch {
    console.error(`FAIL ${rel}`);
    failed++;
  }
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
