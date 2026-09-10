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

let cachedExtensionId = null;
async function extensionId(context) {
  if (cachedExtensionId) return cachedExtensionId;
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  cachedExtensionId = new URL(worker.url()).host;
  return cachedExtensionId;
}

async function extensionPage(context) {
  const id = await extensionId(context);
  // An extension that is mid-reload refuses navigation with
  // ERR_BLOCKED_BY_CLIENT, so retry until it is serving again.
  let lastError = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const page = await context.newPage();
    try {
      await page.goto(`chrome-extension://${id}/ui/newtab.html`, { timeout: 5000 });
      return page;
    } catch (error) {
      lastError = error;
      await page.close().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

const send = (page, message) => page.evaluate(
  m => new Promise(resolve => chrome.runtime.sendMessage(m, resolve)), message
);

const readStore = (page, storeName) => page.evaluate(name => new Promise((resolve, reject) => {
  const request = indexedDB.open('cognitive-trails');
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
  const request = indexedDB.open('cognitive-trails');
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
      // Poll for the run to finish (live local labeling can take a minute).
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

      // The four fixture pages are viewed for about a second each, which is
      // thin evidence by design — the honest outcome is metrics plus an
      // exclusion, not a topic conjured from four seconds of browsing.
      const metrics = await readStore(ext, 'daily_metrics');
      assert.ok(metrics.length >= 1, 'daily metrics written');
      const briefs = await readStore(ext, 'briefs');
      assert.ok(briefs.length >= 1, 'brief written');
      const visits = await readStore(ext, 'visits');
      assert.ok(visits.length >= 3, `history was ingested (got ${visits.length} visits)`);
      const pages = await readStore(ext, 'pages');
      assert.ok(pages.length >= 3, 'page aggregates written');
      const topics = await readStore(ext, 'topics');
      const uncategorized = await readStore(ext, 'uncategorized');
      assert.ok(topics.length + uncategorized.length >= 1,
        'every ingested page is either in a topic or accounted for as uncategorized');
      const embeddings = await readStore(ext, 'embeddings');
      assert.equal(embeddings.length, 0, 'one-off brief pages are excluded before consuming local embedding work');

      // Offscreen document should have closed itself.
      await ext.waitForTimeout(2000);
      const contexts = await ext.evaluate(() =>
        chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
      );
      assert.strictEqual(contexts.length, 0, 'offscreen document closed after the run');
    });

    await check('revisited pages reach live inference through the offscreen host', async () => {
      for (const target of ['article.html', 'longpage.html', 'chat.html']) {
        const host = target === 'chat.html' ? 'claude.ai' : 'news.fixture.test';
        const page = await context.newPage();
        await page.goto(`http://${host}:${PORT}/${target}`); await page.mouse.move(100, 100);
        await page.waitForTimeout(1200); await page.close();
      }
      await send(ext, { type: 'FLUSH_CAPTURES' });
      const before = new Set((await readStore(ext, 'runs')).map(r => r.runId));
      assert.equal((await send(ext, { type: 'RUN_PIPELINE_MANUAL' })).started, true);
      let run;
      for (let i = 0; i < 90; i++) {
        await ext.waitForTimeout(2000);
        run = (await readStore(ext, 'runs')).find(r => !before.has(r.runId) && r.status !== 'running');
        if (run) break;
      }
      assert.equal(run?.status, 'ok', run?.error || 'live repeated-page run did not finish');
      assert.ok((await readStore(ext, 'embeddings')).length >= 3, `supported pages embed through real Ollama: ${JSON.stringify({counts:run.counts,pages:(await readStore(ext, 'pages')).map(p=>({url:p.url,n:p.visitCount,reason:p.classificationReason,pending:p.needsClassification}))})}`);
      // Two model-unload requests each have a 10s transport timeout, followed
      // by a 5s worker acknowledgement deadline. Allow 5s for browser overhead.
      const cleanupStarted = Date.now();
      let remaining;
      for (let i = 0; i < 150; i++) {
        remaining = await ext.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
        if (!remaining.length) break;
        await ext.waitForTimeout(200);
      }
      assert.equal(remaining.length, 0, `offscreen host closes within its cleanup budget (${Date.now() - cleanupStarted}ms observed)`);
      console.log(`     offscreen cleanup observed after durable result: ${Date.now() - cleanupStarted}ms`);
    });

    await check('stale running row is marked abandoned and does not block a rerun', async () => {
      // chrome.runtime.reload() cannot be used here: an extension loaded with
      // --load-extension never comes back in a Playwright context. The
      // mechanism under test is the sweep that runs whenever a run is
      // considered, which is what a real service-worker restart triggers.
      await writeRun(ext, {
        runId: 'run-stale-test', startedAt: Date.now() - 30 * 60000, finishedAt: null,
        status: 'running', stage: 'embed', heartbeat: Date.now() - 15 * 60000,
        watermarkBefore: 0, counts: {}, timingsMs: {}, warnings: []
      });
      await send(ext, { type: 'TEST_SET_SETTING', key: 'watermark', value: 1 });
      const fired = await send(ext, { type: 'TEST_FIRE_ALARM', alarm: 'daily' });
      assert.ok(fired && fired.ok, `alarm fire refused: ${JSON.stringify(fired)}`);

      let stale = null;
      for (let i = 0; i < 15; i++) {
        await ext.waitForTimeout(1000);
        const runs = await readStore(ext, 'runs');
        stale = runs.find(r => r.runId === 'run-stale-test');
        if (stale && stale.status === 'abandoned') break;
      }
      assert.ok(stale, 'the stale row is still present');
      assert.strictEqual(stale.status, 'abandoned',
        `a run whose heartbeat is 15 min old must be marked abandoned (got ${stale.status})`);
      assert.ok(stale.finishedAt, 'the abandoned run is closed out');

      // And a fresh run is not blocked by the stale row.
      const started = await send(ext, { type: 'RUN_PIPELINE_MANUAL' });
      assert.strictEqual(started.started, true,
        `a stale row must not block a new run (refused: ${started.reason})`);
      let laterRun = null;
      for (let i = 0; i < 90; i++) {
        await ext.waitForTimeout(2000);
        const runs = await readStore(ext, 'runs');
        laterRun = runs.find(r => r.runId !== 'run-stale-test' && r.startedAt > stale.startedAt);
        if (laterRun && laterRun.status !== 'running') break;
      }
      assert.ok(laterRun, 'a new run row appeared');
      assert.strictEqual(laterRun.status, 'ok', `the rerun failed: ${laterRun && laterRun.error}`);
    });

    await check('double alarm fire while running is skipped', async () => {
      // A fresh-heartbeat running row stands in for a run in flight.
      await writeRun(ext, {
        runId: 'run-inflight-test', startedAt: Date.now(), finishedAt: null,
        status: 'running', stage: 'embed', heartbeat: Date.now(),
        watermarkBefore: 0, counts: {}, timingsMs: {}, warnings: []
      });
      const started = await send(ext, { type: 'RUN_PIPELINE_MANUAL' });
      assert.strictEqual(started.started, false, 'a manual run is refused while one is in flight');
      assert.strictEqual(started.reason, 'already-running');
      await ext.waitForTimeout(2000);
      const runs = await readStore(ext, 'runs');
      assert.ok(runs.some(r => r.status === 'skipped'),
        `the second fire is recorded as skipped (statuses: ${runs.map(r => r.status).join(',')})`);
      const inflight = runs.find(r => r.runId === 'run-inflight-test');
      assert.strictEqual(inflight.status, 'running', 'the in-flight run row is left untouched');
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
