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
    const url = 'https://example.test/rust'; const at = Date.now() - 600000;
    await store.put('topics', { topicId: 'test-rust', label: 'Async Rust', state: 'active' });
    await store.put('pages', { normalizedUrl: url, url, title: 'Borrow checking in async Rust' });
    await store.put('memberships', { topicId: 'test-rust', normalizedUrl: url });
    await store.put('visits', { visitId: 'fixture-rust', url, normalizedUrl: url, title: 'Borrow checking in async Rust', visitTime: at, dwellMs: 300000 });
    await store.put('captures', { captureId: 'ungrouped', url: 'https://example.test/bread', normalizedUrl: 'https://example.test/bread', title: 'Sourdough hydration notes', startedAt: at, updatedAt: at + 40000, activeMs: 10000 });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Async Rust', exact: true }).click();
  await page.getByText('Add a note or name this trail', { exact: true }).click();
  await page.getByLabel('Your trail name').fill('Weekend Rust project');
  await page.getByLabel('Your note', { exact: true }).fill('Resume the borrow checker example.');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await page.locator('.nt-detail-heading').getByRole('heading', { name: 'Weekend Rust project' }).waitFor();
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
  // Literal signals expose their denominators and restore keyboard focus.
  const ring = page.getByRole('button', { name: /^Continuity .*Inspect evidence/ });
  await ring.click();
  await page.getByRole('dialog').getByText(/Same-trail transitions ÷/).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await ring.evaluate(el => document.activeElement === el), true);
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Weekend Rust project', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect page & grouping' }).first().click();
  await page.getByRole('dialog').getByText(/Entire trail.*across all recorded dates/).waitFor();
  await page.getByRole('button', { name: 'Remove from trail', exact: true }).click();
  await page.reload();
  const correction = await page.evaluate(async () => CTStore.createStore({}).get('corrections', 'page:https://example.test/rust'));
  assert.equal(correction.value.topicId, null, 'ungrouped choice persists');
  await page.getByRole('searchbox').fill('Borrow checking');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect page & grouping' }).click();
  await page.getByLabel('Page grouping', { exact: true }).selectOption('test-rust');
  await page.getByRole('button', { name: 'Save grouping', exact: true }).click();
  const send = message => page.evaluate(message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve)), message);
  await page.reload();
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByLabel('Duration').selectOption('25');
  await page.getByLabel('Next step (optional)').fill('Private next step');
  await page.getByRole('dialog').getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByText('Session in progress', { exact: true }).waitFor();
  let running = await send({ type: 'GET_TRAIL_SESSION_STATUS' });
  assert.equal(running.session.durationMinutes, 25);
  assert.equal((await send({ type: 'START_TRAIL_SESSION', topicId: 'test-rust', durationMinutes: 50 })).reason, 'session-active');
  await page.reload();
  await page.getByText('Private next step', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'View or end session' }).click();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await page.getByRole('heading', { name: 'Session recap', exact: true }).waitFor();
  await page.getByRole('dialog').getByText('Other grouped trails', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  // Delayed alarms use the planned end, and completion survives worker restart.
  running = await send({ type: 'START_TRAIL_SESSION', topicId: 'test-rust', durationMinutes: 25, note: 'Another private note' });
  await page.evaluate(async id => {
    const store = CTStore.createStore({}), session = await store.get('intent_sessions', id);
    await store.put('intent_sessions', { ...session, startedAt: Date.now() - 26 * 60000 });
  }, running.session.sessionId);
  await send({ type: 'TEST_SET_SETTING', key: 'testMode', value: true });
  assert.equal((await send({ type: 'TEST_FIRE_ALARM', alarm: `trail-session:${running.session.sessionId}` })).ok, true);
  const timed = await page.evaluate(async id => CTStore.createStore({}).get('intent_sessions', id), running.session.sessionId);
  assert.equal(timed.endReason, 'timer');
  assert.equal(timed.endedAt - timed.startedAt, 25 * 60000);
  assert.ok(timed.notifiedAt, 'generic completion notification was delivered to Chrome');
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.reload();
  assert.equal((await send({ type: 'GET_TRAIL_SESSION_STATUS' })).session, null);
  await page.goto(`${origin}/ui/newtab.html?session=${timed.sessionId}`);
  await page.getByRole('heading', { name: 'Session recap', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  running = await send({ type: 'START_TRAIL_SESSION', topicId: 'test-rust', durationMinutes: null });
  assert.equal(running.ok, true);
  await page.goto(`${origin}/ui/options.html`);
  await page.getByRole('button', { name: 'Check connection' }).waitFor();
  await page.getByRole('button', { name: 'Pause capture', exact: true }).click();
  await page.getByRole('button', { name: 'Resume capture', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.getByText(/Preferences saved/).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Resume capture', exact: true }).waitFor();
  assert.equal((await page.evaluate(async () => CTStore.createStore({}).getAll('intent_sessions'))).find(s => s.sessionId === running.session.sessionId).endReason, 'capture-paused');
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
  await page.goto(`${origin}/ui/audit.html`);
  await page.getByRole('button', { name: 'Recalculate evidence' }).click();
  await page.getByText(/Evidence recalculated. Original history/).waitFor();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloaded;
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.ok(exported.intent_sessions.length >= 3, 'exports preserve optional sessions');
  assert.ok(exported.captures.every(c => !('extractedText' in c)));
  await page.getByRole('link', { name: 'Inspect a page' }).click();
  await page.getByRole('searchbox', { name: 'Page URL or title' }).fill('example.test/rust');
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await page.getByText(/1 matching pages/).waitFor();
  assert.ok((await page.locator('#diagnostic-results').textContent()).includes('entireTrailEstimatedMs'));
  await page.goto(`${origin}/ui/audit.html`);
  assert.equal((await send({ type: 'DELETE_EVERYTHING' })).ok, true);
  assert.equal((await page.evaluate(async () => CTStore.createStore({}).getAll('intent_sessions'))).length, 0);
  assert.equal((await page.evaluate(() => chrome.alarms.getAll())).filter(a => a.name.startsWith('trail-session:')).length, 0);
  assert.equal(Object.keys(await page.evaluate(() => chrome.notifications.getAll())).filter(id => id.startsWith('trail-session:')).length, 0);
  assert.deepEqual(errors, [], 'no browser exceptions during the product flow');
  console.log('ok   capture-only search, trail notes, pins, persistence, responsive layout, setup, pause, preferences; signals, evidence, corrections, sessions, delayed alarms, worker restart, recap, deletion');
} finally {
  await context?.close(); fs.rmSync(profile, { recursive: true, force: true });
}
