// Real Chromium schema-5 upgrade + raw/metadata read comparison. Disposable DB/profile only.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-storage-e2e-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/ui/options.html`);
  const result = await page.evaluate(async () => {
    const dbName = 'ct-projection-migration-test', count = 3000, body = 'Retained synthetic article text. '.repeat(260).slice(0, 8000);
    const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || Error('aborted')); });
    const old = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 5);
      req.onupgradeneeded = () => { for (const [name, def] of Object.entries(CTStore.SCHEMA)) {
        const s = req.result.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
        for (const [index, key] of Object.entries(def.indexes)) s.createIndex(index, key);
      }};
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const seed = old.transaction(['captures', 'topics', 'settings'], 'readwrite');
    for (let i = 0; i < count; i++) seed.objectStore('captures').put({ captureId: `c${i}`, url: `https://synthetic.example.test/${i}`, normalizedUrl: `https://synthetic.example.test/${i}`, startedAt: 10000 + i * 1000, activeMs: 1000, extractedText: body });
    seed.objectStore('topics').put({ topicId: 'preserved', label: 'Preserved', centroid: new Float32Array([0.3, 0.7]).buffer });
    for (const [key, value] of [['v3MigrationDone', true], ['urlIdentityVersion', 2]]) seed.objectStore('settings').put({ key, value });
    await done(seed); old.close();
    const reader = CTStore.createStore({ dbName }), writer = CTStore.createStore({ dbName });
    const start = performance.now(); await reader.open(); const upgradeMs = performance.now() - start;
    await writer.open();
    const original = await reader.get('captures', 'c0');
    if (original.extractedText !== body || await reader.count('captures') !== count) throw Error('Source text/records lost in migration');
    const vector = new Float32Array((await reader.get('topics', 'preserved')).centroid);
    if (vector[0] !== Math.fround(0.3) || vector[1] !== Math.fround(0.7)) throw Error('Vector changed');
    const tables = ['captures', 'topics'];
    const rawDb = await new Promise(resolve => { const req = indexedDB.open(dbName); req.onsuccess = () => resolve(req.result); });
    const baseline = async () => { const tx = rawDb.transaction(tables, 'readonly'), finished = done(tx), out = {};
      for (const n of tables) { const r = tx.objectStore(n).getAll(); r.onsuccess = () => { out[n] = r.result.map(({ extractedText, centroid, vector, ...row }) => row); }; }
      await finished; return out;
    };
    const samples = { rawThenStrip: [], metadata: [], unchanged: [] };
    const expected = JSON.stringify(await baseline());
    for (let round = 0; round < 5; round++) {
      for (const kind of round % 2 ? ['metadata', 'rawThenStrip'] : ['rawThenStrip', 'metadata']) {
        const start = performance.now(), snapshot = kind === 'metadata' ? await reader.readSnapshot(tables) : await baseline();
        samples[kind].push(performance.now() - start);
        if (JSON.stringify(snapshot) !== expected) throw Error('Metadata is not equivalent');
      }
    }
    const cached = await reader.readSnapshot(tables, { reuseUnchanged: true });
    reader.resetStats();
    for (let i = 0; i < 5; i++) { const start = performance.now(); const next = await reader.readSnapshot(tables, { reuseUnchanged: true });
      samples.unchanged.push(performance.now() - start); if (next !== cached) throw Error('Unchanged snapshot not reused'); }
    if (reader.stats.snapshotTableReads !== 0) throw Error('Unchanged refresh read data tables');
    await writer.put('captures', { ...original, activeMs: 1234 });
    if ((await reader.readSnapshot(tables, { reuseUnchanged: true })).captures.find(c => c.captureId === 'c0').activeMs !== 1234) throw Error('Stale cross-page result');
    await writer.wipe();
    if ((await reader.readSnapshot(tables, { reuseUnchanged: true })).captures.length) throw Error('Deletion reused stale snapshot');
    rawDb.close(); await reader.close(); await writer.close();
    await new Promise(resolve => { indexedDB.deleteDatabase(dbName).onsuccess = resolve; });
    return { captures: count, textCharsPerCapture: body.length, upgradeMs, samples, medianMs: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, values.slice().sort((a, b) => a - b)[2]])),
      checks: ['schema 5 upgrade preserves raw text and vectors', 'metadata equals original projection', 'unchanged refresh reads zero data tables', 'cross-page invalidation', 'deletion invalidation'] };
  });
  assert.equal(result.checks.length, 5);
  const report = { generatedAt: new Date().toISOString(), browser: context.browser()?.version(), cpu: os.cpus()[0].model,
    scope: 'Real Chromium, synthetic 3000-capture database, 24 million retained text characters. Timings exclude DOM/inference. Disposable profile; no installed user data.', ...result };
  fs.writeFileSync(path.join(root, 'validation/storage-2026-09-11.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await context?.close(); fs.rmSync(profile, { recursive: true, force: true }); }
