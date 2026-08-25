// Extension-level capture suite (spec §7.7, first six bullets). Runs locally
// on the development machine, not in CI:  node tests/e2e/capture.e2e.mjs
// Requires: npx playwright install chromium
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

// Fake hostnames aliased to 127.0.0.1 so pages are not on a filtered domain.
const HOSTS = 'MAP news.fixture.test 127.0.0.1, MAP claude.ai 127.0.0.1, MAP secure.chase.com 127.0.0.1';

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    // /login serves the login page regardless of host; /spa/* serves spa.html
    let file = urlPath === '/' ? 'article.html' : urlPath.replace(/^\//, '');
    if (urlPath.startsWith('/login')) file = 'login.html';
    if (urlPath.startsWith('/spa')) file = 'spa.html';
    const full = path.join(siteDir, path.basename(file));
    if (!fs.existsSync(full)) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(full));
  });
  return new Promise(resolve => server.listen(PORT, () => resolve(server)));
}

async function getExtensionId(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return new URL(worker.url()).host;
}

async function openExtensionPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/ui/newtab.html`);
  return page;
}

async function flushAndReadCaptures(extPage) {
  await extPage.evaluate(() => new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'FLUSH_CAPTURES' }, resolve)
  ));
  return extPage.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('cognitive-trails', 4);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('captures', 'readonly');
      const all = tx.objectStore('captures').getAll();
      all.onsuccess = () => { db.close(); resolve(all.result); };
      all.onerror = () => reject(all.error);
    };
    request.onerror = () => reject(request.error);
  }));
}

async function setPaused(extPage, paused) {
  await extPage.evaluate(p => new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'SET_CAPTURE_PAUSED', paused: p }, resolve)
  ), paused);
}

async function main() {
  const server = await startServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-'));
  // Headed on purpose: document.hasFocus() — part of the active-time gate —
  // is unreliable in headless Chromium, and this suite runs locally anyway.
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
    const extensionId = await getExtensionId(context);
    const extPage = await openExtensionPage(context, extensionId);

    // --- 1. basic capture: activeMs, scroll depth, source tagging ---------
    const article = await context.newPage();
    await article.goto(`http://news.fixture.test:${PORT}/article.html`);
    await article.bringToFront();
    for (let i = 0; i < 10; i++) {
      await article.mouse.move(100 + i * 10, 200 + i * 5);
      await article.waitForTimeout(500);
    }

    const longpage = await context.newPage();
    await longpage.goto(`http://news.fixture.test:${PORT}/longpage.html`);
    await longpage.bringToFront();
    await longpage.mouse.move(50, 50);
    await longpage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await longpage.waitForTimeout(1500);

    const chat = await context.newPage();
    await chat.goto(`http://claude.ai:${PORT}/chat.html`);
    await chat.bringToFront();
    await chat.mouse.move(60, 60);
    await chat.waitForTimeout(1500);

    // pagehide finalizes each capture; close before reading.
    await article.close();
    await longpage.close();
    await chat.close();
    await extPage.bringToFront();
    await extPage.waitForTimeout(500);

    await check('activeMs within tolerance on a focused page', async () => {
      const captures = await flushAndReadCaptures(extPage);
      const row = captures.find(c => c.url.includes('article.html'));
      assert.ok(row, 'article capture exists');
      // ~5s of visible+focused+input time; allow generous ±2s plus setup slack
      assert.ok(row.activeMs >= 2000 && row.activeMs <= 9000,
        `activeMs ${row.activeMs} outside expected window`);
    });

    await check('extractedText captures main content, skips nav/footer', async () => {
      const captures = await flushAndReadCaptures(extPage);
      const row = captures.find(c => c.url.includes('article.html'));
      assert.ok(row.extractedText.includes('coil folds'), 'main content present');
      assert.ok(!row.extractedText.includes('NAVTEXT'), 'nav excluded');
      assert.ok(!row.extractedText.includes('FOOTERTEXT'), 'footer excluded');
    });

    await check('form field values are never captured', async () => {
      const captures = await flushAndReadCaptures(extPage);
      const row = captures.find(c => c.url.includes('article.html'));
      assert.ok(!row.extractedText.includes('SECRETINPUTVALUE123'), 'input value excluded');
      assert.ok(!row.extractedText.includes('SECRETTEXTAREA456'), 'textarea excluded');
    });

    await check('maxScrollDepth recorded on scrolled page', async () => {
      const captures = await flushAndReadCaptures(extPage);
      const row = captures.find(c => c.url.includes('longpage.html'));
      assert.ok(row, 'longpage capture exists');
      assert.ok(row.maxScrollDepth > 0.9, `scrolled to bottom, got ${row.maxScrollDepth}`);
    });

    await check('claude.ai page tagged source=llm_chat', async () => {
      const captures = await flushAndReadCaptures(extPage);
      const row = captures.find(c => c.url.includes('chat.html'));
      assert.ok(row, 'chat capture exists');
      assert.strictEqual(row.source, 'llm_chat');
      const webRow = captures.find(c => c.url.includes('article.html'));
      assert.strictEqual(webRow.source, 'web');
    });

    // --- 1b. the Ollama origin rewrite is scoped to this extension -------
    await check('origin rewrite applies only to this extension, not to web pages', async () => {
      const outcome = await extPage.evaluate(async () => {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        const probe = async initiator => {
          const result = await chrome.declarativeNetRequest.testMatchOutcome({
            url: 'http://localhost:11434/api/delete',
            initiator,
            type: 'xmlhttprequest',
            method: 'post'
          });
          return result.matchedRules.length;
        };
        return {
          ruleCount: rules.length,
          allScoped: rules.every(r => Array.isArray(r.condition.initiatorDomains) && r.condition.initiatorDomains.length),
          fromSelf: await probe(location.origin),
          fromWebPage: await probe('https://evil.example.com'),
          fromOtherExtension: await probe('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        };
      });
      assert.strictEqual(outcome.ruleCount, 2, 'both local-host rules are registered');
      assert.strictEqual(outcome.allScoped, true, 'every rule carries an initiatorDomains scope');
      assert.ok(outcome.fromSelf >= 1, 'the extension itself still gets the rewrite it needs');
      // The security property: without this, any page could launder its Origin
      // past Ollama's local-only check and reach side-effecting endpoints.
      assert.strictEqual(outcome.fromWebPage, 0, 'a web page must never get the rewrite');
      assert.strictEqual(outcome.fromOtherExtension, 0, 'nor another extension');
    });

    // --- 2. denylist and sensitive paths ---------------------------------
    await check('denylisted domain and /login path capture nothing', async () => {
      const bank = await context.newPage();
      await bank.goto(`http://secure.chase.com:${PORT}/article.html`);
      await bank.waitForTimeout(1200);
      const login = await context.newPage();
      await login.goto(`http://news.fixture.test:${PORT}/login`);
      await login.waitForTimeout(1200);
      const captures = await flushAndReadCaptures(extPage);
      assert.ok(!captures.some(c => c.domain.includes('chase.com')), 'no bank capture');
      assert.ok(!captures.some(c => c.url.includes('/login')), 'no login-path capture');
      await bank.close(); await login.close();
    });

    // --- 3. SPA navigation ------------------------------------------------
    await check('pushState produces a second capture with isSpaNavigation', async () => {
      const spa = await context.newPage();
      await spa.goto(`http://news.fixture.test:${PORT}/spa.html`);
      await spa.bringToFront();
      await spa.mouse.move(80, 80);
      await spa.waitForTimeout(1500);
      await spa.click('#nav-btn');
      await spa.waitForTimeout(2500); // poll interval detects the URL change
      const captures = await flushAndReadCaptures(extPage);
      const spaRows = captures.filter(c => c.url.includes('/spa'));
      assert.ok(spaRows.length >= 2, `expected 2 spa captures, got ${spaRows.length}`);
      const second = spaRows.find(c => c.url.includes('second-view'));
      assert.ok(second, 'second-view capture exists');
      assert.strictEqual(second.isSpaNavigation, true);
      const first = spaRows.find(c => !c.url.includes('second-view'));
      assert.strictEqual(first.isSpaNavigation, false);
      assert.ok(first.endedAt, 'first capture finalized');
      await spa.close();
    });

    // --- 4. extraction performance on a dense DOM -------------------------
    await check('5,000-node page extracts in < 50 ms', async () => {
      const dense = await context.newPage();
      await dense.goto(`http://news.fixture.test:${PORT}/dense.html`);
      await dense.waitForTimeout(1500);
      const captures = await flushAndReadCaptures(extPage);
      const row = captures.find(c => c.url.includes('dense.html'));
      assert.ok(row, 'dense capture exists');
      assert.ok(row.extractionMs < 50, `extraction took ${row.extractionMs} ms`);
      await dense.close();
    });

    // --- 4b. SPA navigation into a sensitive route is not captured -------
    await check('SPA navigation into /login is excluded, not captured', async () => {
      const spa = await context.newPage();
      await spa.goto(`http://news.fixture.test:${PORT}/spa.html`);
      await spa.bringToFront();
      await spa.mouse.move(70, 70);
      await spa.waitForTimeout(1500);
      await spa.click('#nav-login');
      await spa.waitForTimeout(2500);
      await spa.close();
      const captures = await flushAndReadCaptures(extPage);
      const sensitive = captures.filter(c => c.url.includes('/spa/login'));
      assert.strictEqual(sensitive.length, 0,
        'a client-side route into /login must get the same check a page load would');
      assert.ok(!captures.some(c => (c.extractedText || '').includes('please sign in with your password')),
        'and none of its text is stored anywhere');
    });

    // --- 4c. pause reaches tabs that are already open --------------------
    await check('pausing stops an already-open tab mid-capture', async () => {
      const open = await context.newPage();
      await open.goto(`http://news.fixture.test:${PORT}/article.html?already-open=1`);
      await open.bringToFront();
      await open.mouse.move(90, 90);
      await open.waitForTimeout(1500);

      await setPaused(extPage, true);
      await open.bringToFront();
      await open.waitForTimeout(500);
      const atPause = await flushAndReadCaptures(extPage);
      const before = atPause.find(c => c.url.includes('already-open'));
      assert.ok(before, 'the tab was capturing before the pause');

      // Keep the tab active for several seconds while paused.
      for (let i = 0; i < 6; i++) {
        await open.mouse.move(100 + i * 5, 100 + i * 5);
        await open.waitForTimeout(500);
      }
      const afterPause = await flushAndReadCaptures(extPage);
      const after = afterPause.find(c => c.url.includes('already-open'));
      assert.strictEqual(after.activeMs, before.activeMs,
        `an open tab must stop accruing active time when capture is paused (${before.activeMs} -> ${after.activeMs})`);

      await setPaused(extPage, false);
      await open.close();
    });

    // --- 5. pause toggle --------------------------------------------------
    await check('pause stops captures; unpause resumes', async () => {
      await setPaused(extPage, true);
      const before = (await flushAndReadCaptures(extPage)).length;
      const paused = await context.newPage();
      await paused.goto(`http://news.fixture.test:${PORT}/chat.html?while-paused=1`);
      await paused.waitForTimeout(1500);
      await paused.close();
      const during = await flushAndReadCaptures(extPage);
      assert.strictEqual(during.length, before, 'no new captures while paused');

      await setPaused(extPage, false);
      const resumed = await context.newPage();
      await resumed.goto(`http://news.fixture.test:${PORT}/longpage.html?after-pause=1`);
      await resumed.bringToFront();
      await resumed.waitForTimeout(1500);
      const after = await flushAndReadCaptures(extPage);
      assert.ok(after.some(c => c.url.includes('after-pause')), 'captures resume after unpause');
      await resumed.close();
    });

  } finally {
    await context.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\n${failures} e2e capture checks failed`);
    process.exit(1);
  }
  console.log('\ne2e capture suite passed');
}

main().catch(error => { console.error(error); process.exit(1); });
