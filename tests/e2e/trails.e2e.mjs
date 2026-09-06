// Actual extension UI -> worker -> IndexedDB -> reload, in a disposable profile.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = process.env.CT_EXTENSION_PATH || path.resolve(import.meta.dirname, '../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-trails-test-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/ui/newtab.html`);
  await page.getByText('The next page is a place to begin.').waitFor();
  const status = await page.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_STATUS' }, resolve)));
  assert.equal(typeof status.paused, 'boolean', 'home and settings use the real worker status route');
  await page.evaluate(async () => {
    const store = CTStore.createStore({}); await store.open();
    const url = 'https://example.test/rust'; const at = Date.now() - 60000;
    await store.put('topics', { topicId: 'test-rust', label: 'Async Rust', state: 'active' });
    await store.put('memberships', { topicId: 'test-rust', normalizedUrl: url });
    await store.put('visits', { visitId: 'fixture-rust', url, normalizedUrl: url, title: 'Borrow checking in async Rust', visitTime: at, dwellMs: 50000 });
    await store.put('captures', { captureId: 'ungrouped', url: 'https://example.test/bread', normalizedUrl: 'https://example.test/bread', title: 'Sourdough hydration notes', startedAt: at, updatedAt: at + 40000, activeMs: 10000 });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Async Rust', exact: true }).click();
  await page.getByText('Add a note or name this trail', { exact: true }).click();
  await page.getByLabel('Your trail name').fill('Weekend Rust project');
  await page.getByLabel('Your note', { exact: true }).fill('Resume the borrow checker example.');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await page.getByRole('heading', { name: 'Weekend Rust project' }).waitFor();
  await page.getByRole('button', { name: 'Pin Weekend Rust project', exact: true }).click();
  await page.getByRole('button', { name: 'Unpin Weekend Rust project', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Pinned', exact: true }).click();
  await page.getByRole('button', { name: 'Weekend Rust project', exact: true }).waitFor();
  await page.getByRole('searchbox').fill('Sourdough');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('link', { name: 'Sourdough hydration notes' }).waitFor();
  assert.ok(await page.getByText('No topic yet', { exact: true }).isVisible());
  assert.equal(await page.evaluate(async () => (await CTStore.createStore({}).get('topics', 'test-rust')).label), 'Async Rust', 'personal name does not rewrite inferred registry');
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no overflow at ${width}`);
  }
  await page.goto(`${origin}/ui/options.html`);
  await page.getByRole('button', { name: 'Check connection' }).waitFor();
  await page.getByRole('button', { name: 'Pause capture', exact: true }).click();
  await page.getByRole('button', { name: 'Resume capture', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.getByText(/Preferences saved/).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Resume capture', exact: true }).waitFor();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const contrast = await page.getByRole('button', { name: 'Save preferences', exact: true }).evaluate(button => {
      const style = getComputedStyle(button);
      const luminance = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
        v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(style.color), b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert.ok(contrast >= 4.5, `${colorScheme} primary action text meets 4.5:1 contrast (got ${contrast})`);
  }
  assert.deepEqual(errors, [], 'no browser exceptions during the product flow');
  console.log('ok   capture-only search, trail notes, pins, persistence, responsive layout, setup, pause, preferences');
} finally {
  await context?.close(); fs.rmSync(profile, { recursive: true, force: true });
}
