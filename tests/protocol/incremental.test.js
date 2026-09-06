// Incremental-run correctness (review findings 5 and 6). An incremental run
// sees only a slice of history; it must never let that slice overwrite what
// the record already knows.
'use strict';
const assert = require('assert');
const { makeEnv } = require('../helpers/pipelineHarness.js');

(async () => {
  // --- deferred work is retried until it is done, never dropped ----------
  {
    const env = await makeEnv({ settings: { maxNewPagesPerRun: 1 } });
    await env.runThroughDay(2);
    const afterFirst = await env.store.getAll('pages');
    const backlog = afterFirst.filter(p => p.needsEmbedding).length;
    assert.ok(backlog > 0, 'a tiny budget defers work');
    assert.ok(afterFirst.some(p => p.embeddingKey), 'and does some of it');

    // Keep re-running the SAME day. Nothing new arrives, so if the backlog is
    // real the queue drains; if candidates were selected purely by the time
    // window, these pages would have been abandoned.
    let drained = false;
    for (let i = 0; i < 60; i++) {
      const result = await env.runThroughDay(2);
      assert.strictEqual(result.ok, true, result.error);
      const pages = await env.store.getAll('pages');
      if (!pages.some(p => p.needsEmbedding || p.needsClassification)) { drained = true; break; }
    }
    assert.ok(drained, 'the backlog drains across runs');
    const pages = await env.store.getAll('pages');
    const unembedded = pages.filter(p => !p.embeddingKey && p.hadTitle);
    assert.strictEqual(unembedded.length, 0,
      `every page with something to embed eventually gets embedded (${unembedded.length} left)`);
    const memberships = new Set((await env.store.getAll('memberships')).map(m => m.normalizedUrl));
    const excluded = new Set((await env.store.getAll('uncategorized')).map(m => m.normalizedUrl));
    assert.ok(pages.every(p => memberships.has(p.normalizedUrl) || excluded.has(p.normalizedUrl)),
      'queue exhaustion means every page is deliberately classified or excluded, not merely embedded');
    assert.ok((await env.store.get('daily_metrics', '2026-03-01')).categorizedShare > 0.5,
      'old days are repaired when classification finishes outside the overlap');
  }

  // --- an incremental run must not shrink a page's lifetime active time ---
  {
    const env = await makeEnv();
    const anchor = new Date(env.fixtures.visitData.anchorDay1);
    const at = (day, hour, minute) =>
      new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + (day - 1), hour, minute).getTime();

    await env.runThroughDay(2);
    const before = await env.store.getAll('pages');
    const withActive = before.filter(p => p.activeMs > 0);
    assert.ok(withActive.length > 0, 'pages carry measured active time');
    const totalBefore = withActive.reduce((sum, p) => sum + p.activeMs, 0);

    // A later run whose overlap window contains only a fraction of the
    // captures. Page aggregates are rebuilt during ingest, and rebuilding
    // them from the window alone would erase the rest.
    env.clock.now = at(3, 12, 0);
    assert.strictEqual((await env.pipeline.run({ trigger: 'manual' })).ok, true);

    const after = await env.store.getAll('pages');
    const byUrl = new Map(after.map(p => [p.normalizedUrl, p]));
    for (const page of withActive) {
      const now = byUrl.get(page.normalizedUrl);
      assert.ok(now.activeMs >= page.activeMs,
        `${page.normalizedUrl}: active time must never shrink (${page.activeMs} -> ${now.activeMs})`);
    }
    const totalAfter = after.reduce((sum, p) => sum + p.activeMs, 0);
    assert.ok(totalAfter >= totalBefore, 'lifetime active time is monotonic across incremental runs');
  }

  // --- a content embedding is never downgraded to title-only -------------
  {
    const env = await makeEnv();
    await env.runThroughDay(2);
    const before = (await env.store.getAll('pages')).filter(p => p.embeddingVariant === 'content');
    assert.ok(before.length > 0, 'pages were embedded from captured content');

    // Retention deletes page text after 30 days; simulate that, then re-run.
    // The page must keep the vector it already has rather than recompute a
    // worse one from its title.
    const swept = await env.store.retentionSweep(env.clock.now + 1000, 0);
    assert.ok(swept > 0, 'text was cleared');
    await env.runThroughDay(3);

    const after = new Map((await env.store.getAll('pages')).map(p => [p.normalizedUrl, p]));
    for (const page of before) {
      const now = after.get(page.normalizedUrl);
      assert.strictEqual(now.embeddingVariant, 'content',
        `${page.normalizedUrl}: a content embedding must survive the text ageing out`);
      assert.strictEqual(now.embeddingKey, page.embeddingKey, 'and keep the same vector');
    }
  }

  // --- an incremental run must not erase exclusions it never examined -----
  {
    const env = await makeEnv();
    // Far enough in to have met the fixture's junk and thin-evidence pages.
    await env.runThroughDay(7);
    const before = await env.store.getAll('uncategorized');
    assert.ok(before.length > 0, `the first run recorded exclusions (got ${before.length})`);
    const beforeByDay = new Map();
    for (const row of before) beforeByDay.set(`${row.day}|${row.normalizedUrl}`, row.reason);

    // A later run touches a different slice of days. dayCommit used to
    // replace a whole day's exclusions with only the rows this run produced,
    // erasing records for pages it never looked at.
    await env.runThroughDay(9);

    const after = await env.store.getAll('uncategorized');
    const afterKeys = new Set(after.map(row => `${row.day}|${row.normalizedUrl}`));
    const lost = [...beforeByDay.keys()].filter(key => !afterKeys.has(key));
    assert.deepStrictEqual(lost, [],
      `exclusion records must survive a later incremental run (lost ${lost.length})`);
    assert.ok(after.length >= before.length, 'and the record only grows');
  }

  // --- a page that becomes categorized loses its stale exclusion ----------
  {
    const env = await makeEnv({ settings: { maxNewTopicsPerRun: 1 } });
    assert.strictEqual((await env.runThroughDay(2)).ok, true);
    const beyond = (await env.store.getAll('uncategorized')).filter(r => r.reason === 'beyond_budget');
    assert.ok(beyond.length > 0, 'fixture really reaches topic budget deferral');
    env.pipeline.cfg.maxNewTopicsPerRun = 20;
    assert.strictEqual((await env.runThroughDay(2)).ok, true);
    const memberships = new Set((await env.store.getAll('memberships')).map(m => m.normalizedUrl));
    const after = await env.store.getAll('uncategorized');
    assert.ok(beyond.some(r => memberships.has(r.normalizedUrl)), 'old deferred pages actually receive memberships');
    assert.ok(!after.some(r => memberships.has(r.normalizedUrl)), 'all stale per-day exclusions are cleared');
    assert.ok(!(await env.store.getAll('pages')).some(p => p.needsClassification), 'classification queue drains');
  }

  console.log('incremental tests passed');
})().catch(error => { console.error(error); process.exit(1); });
