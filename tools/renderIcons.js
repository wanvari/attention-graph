#!/usr/bin/env node
// Rasterizes icon.svg to icon16/48/128.png using headless Chrome, which is the
// only rasterizer this project can assume is present on a dev machine.
//
//   node tools/renderIcons.js
//
// Chrome is required only for this; nothing at runtime depends on it.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SIZES = [16, 48, 128];
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set CHROME_PATH to override.`);
  process.exit(1);
}

const svg = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-icons-'));

for (const size of SIZES) {
  const sized = svg
    .replace(/width="\d+"/, `width="${size}"`)
    .replace(/height="\d+"/, `height="${size}"`);
  const page = path.join(tmp, `icon-${size}.html`);
  fs.writeFileSync(page, `<!DOCTYPE html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${sized}`);
  const out = path.join(root, `icon${size}.png`);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--window-size=${size},${size}`,
    `--screenshot=${out}`,
    '--virtual-time-budget=1500',
    `file://${page}`
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`wrote icon${size}.png`);
}
fs.rmSync(tmp, { recursive: true, force: true });
