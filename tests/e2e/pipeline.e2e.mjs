// Extension-level scheduling/lifetime suite (spec §7.7 last three bullets).
// Runs locally on the development machine with LIVE local Ollama:
//   node tests/e2e/pipeline.e2e.mjs
// The fresh Chrome profile's history is just the fixture pages this test
// visits, so the alarm-triggered run is a real, small end-to-end pipeline.
import { chromium } from 'playwright';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '..', '..');
const siteDir = path.join(__dirname, 'site');
const PORT = 8907;
const HOSTS = 'MAP news.fixture.test 127.0.0.1, MAP claude.ai 127.0.0.1';

function startServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(siteDir, path.basename(req.url.split('?')[0] || 'article.html'));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(PORT, () => resolve(server)));
}

async function extensionPage(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/ui/newtab.html`);
  return page;
}

const send = (page, message) => page.evaluate(
  m => new Promise(resolve => chrome.runtime.sendMessage(m, resolve)), message
);

const readStore = (page, storeName) => page.evaluate(name => new Promise((resolve, reject) => {
  const request = indexedDB.open('cognitive-trails', 4);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction(name, 'readonly');
    const all = tx.objectStore(name).getAll();
    all.onsuccess = () => { db.close(); resolve(all.result); };
    all.onerror = () => reject(all.error);
  };
  request.onerror = () => reject(request.error);
}), storeName);

const writeRun = (page, run) => page.evaluate(row => new Promise((resolve, reject) => {
  const request = indexedDB.open('cognitive-trails', 4);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction('runs', 'readwrite');
    tx.objectStore('runs').put(row);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
}), run);

async function main() {
  // Live Ollama is required for the real end-to-end run.
  const health = await fetch('http://localhost:11434/api/tags').then(r => r.json()).catch(() => null);
  if (!health || !health.models) {
    console.error('Live Ollama required for the pipeline e2e suite.');
    process.exit(1);
  }

  const server = await startServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-pipe-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${HOSTS}`
    ]
  });

  let failures = 0;
  const check = (name, fn) => Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch(error => { failures++; console.error(`FAIL ${name}\n  ${error.message}`); });

  try {
    // Build a little real history in this fresh profile.
    for (const target of ['article.html', 'longpage.html', 'chat.html', 'dense.html']) {
      const host = target === 'chat.html' ? 'claude.ai' : 'news.fixture.test';
      const page = await context.newPage();
      await page.goto(`http://${host}:${PORT}/${target}`);
      await page.mouse.move(100, 100);
      await page.waitForTimeout(1200);
      await page.close();
    }

    const ext = await extensionPage(context);
    await send(ext, { type: 'TEST_SET_SETTING', key: 'testMode', value: true });
    await send(ext, { type: 'TEST_SET_SETTING', key: 'idleGatingEnabled', value: false });
    await send(ext, { type: 'FLUSH_CAPTURES' });

    await check('alarm-triggered run completes; offscreen closes; data lands', async () => {
      const fired = await send(ext, { type: 'TEST_FIRE_ALARM', alarm: 'daily' });
      assert.ok(fired && fired.ok, `alarm fire refused: ${JSON.stringify(fired)}`);
      // Poll for the run to finish (live gemma labeling can take a minute).
      let runs = [];
      for (let i = 0; i < 90; i++) {
        await ext.waitForTimeout(2000);
        runs = await readStore(ext, 'runs');
        if (runs.some(r => r.status === 'ok')) break;
        const failed = runs.find(r => r.status === 'failed');
        assert.ok(!failed, `run failed at ${failed && failed.stage}: ${failed && failed.error}`);
      }
      const ok = runs.find(r => r.status === 'ok');
      assert.ok(ok, `no successful run after 3 min (statuses: ${runs.map(r => r.status)})`);

      const topics = await readStore(ext, 'topics');
      assert.ok(topics.length >= 1, 'registry has topics');
      const metrics = await readStore(ext, 'daily_metrics');
      assert.ok(metrics.length >= 1, 'daily metrics written');
      const briefs = await readStore(ext, 'briefs');
      assert.ok(briefs.length >= 1, 'brief written');

      // Offscreen document should have closed itself.
      await ext.waitForTimeout(2000);
      const contexts = await ext.evaluate(() =>
        chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
      );
      assert.strictEqual(contexts.length, 0, 'offscreen document closed after the run');
    });

    await check('stale running row marked abandoned after reload; rerun succeeds', async () => {
      await writeRun(ext, {
        runId: 'run-stale-test', startedAt: Date.now() - 30 * 60000, finishedAt: null,
        status: 'running', stage: 'embed', heartbeat: Date.now() - 15 * 60000,
        watermarkBefore: 0, counts: {}, timingsMs: {}, warnings: []
      });
      await ext.evaluate(() => chrome.runtime.reload());
      await ext.close().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 4000));
      const ext2 = await extensionPage(context);
      let stale = null;
      for (let i = 0; i < 10; i++) {
        await ext2.waitForTimeout(1000);
        const runs = await readStore(ext2, 'runs');
        stale = runs.find(r => r.runId === 'run-stale-test');
        if (stale && stale.status === 'abandoned') break;
      }
      assert.ok(stale, 'stale row still present');
      assert.strictEqual(stale.status, 'abandoned', `stale running row marked abandoned (got ${stale.status})`);
      await ext2.close();
    });

    await check('double alarm fire while running is skipped', async () => {
      const ext3 = await extensionPage(context);
      // A fresh-heartbeat running row simulates a run in progress.
      await writeRun(ext3, {
        runId: 'run-inflight-test', startedAt: Date.now(), finishedAt: null,
        status: 'running', stage: 'embed', heartbeat: Date.now(),
        watermarkBefore: 0, counts: {}, timingsMs: {}, warnings: []
      });
      await send(ext3, { type: 'TEST_SET_SETTING', key: 'testMode', value: true });
      await send(ext3, { type: 'TEST_SET_SETTING', key: 'idleGatingEnabled', value: false });
      await send(ext3, { type: 'TEST_SET_SETTING', key: 'watermark', value: 1 });
      const fired = await send(ext3, { type: 'TEST_FIRE_ALARM', alarm: 'daily' });
      assert.ok(fired && fired.ok, `alarm fire refused: ${JSON.stringify(fired)}`);
      await ext3.waitForTimeout(2000);
      const runs = await readStore(ext3, 'runs');
      assert.ok(runs.some(r => r.status === 'skipped'), 'second fire recorded as skipped');
      const inflight = runs.find(r => r.runId === 'run-inflight-test');
      assert.strictEqual(inflight.status, 'running', 'the in-flight run row is untouched');
      await ext3.close();
    });
  } finally {
    await context.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\n${failures} pipeline e2e checks failed`);
    process.exit(1);
  }
  console.log('\ne2e pipeline suite passed');
}

main().catch(error => { console.error(error); process.exit(1); });
