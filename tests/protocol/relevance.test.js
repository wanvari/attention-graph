// Utility pages must never reach the registry, and any that got in before the
// filter existed must be evicted. Drives the real pipeline over the committed
// fixtures with an extra SSO page spliced into the browsing history.
'use strict';
const assert = require('assert');
const { makeEnv } = require('../helpers/pipelineHarness.js');

// Deliberately not a /login URL: the privacy denylist already refuses those
// outright, so they never reach the record. The gap this filter closes is the
// auth and utility traffic that is *not* privacy-sensitive -- SAML/OAuth
// hand-offs, vendor download pages, interstitials.
const SSO_URL = 'https://acme.zoom.us/saml/authorize?RelayState=xyz';

function spliceUtilityVisits(env) {
  const anchor = env.fixtures.visitData.anchorDay1;
  const base = new Date(anchor);
  const at = (dayOffset, hour) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0).getTime();
  const added = [
    { visitId: 'u-sso-1', url: SSO_URL, title: 'Sign in - Zoom', visitTime: at(0, 9), transition: 'link' },
    { visitId: 'u-sso-2', url: SSO_URL, title: 'Sign in - Zoom', visitTime: at(1, 9), transition: 'link' },
    { visitId: 'u-dl-1', url: 'https://zoom.us/download', title: 'Download Center - Zoom', visitTime: at(0, 10), transition: 'link' }
  ];
  env.fixtures.visitData.visits.push(...added);
  env.fixtures.visitData.visits.sort((a, b) => a.visitTime - b.visitTime);
  return added;
}

(async () => {
  // ---- never enters the registry ----------------------------------------
  {
    const env = await makeEnv();
    spliceUtilityVisits(env);
    const result = await env.runThroughDay(2);
    assert.strictEqual(result.ok, true, `run failed: ${result.error}`);

    const CTText = require('../../lib/text.js');
    const ssoUrl = CTText.normalizeUrl(SSO_URL);
    const dlUrl = CTText.normalizeUrl('https://zoom.us/download');

    // The visits are still on the record — this is an exclusion from topics,
    // not from history.
    const visits = await env.store.getAll('visits');
    assert.ok(visits.some(v => v.normalizedUrl === ssoUrl), 'the SSO visit was dropped from the record entirely');

    const memberships = await env.store.getAll('memberships');
    for (const url of [ssoUrl, dlUrl]) {
      assert.ok(!memberships.some(m => m.normalizedUrl === url),
        `${url} was given a topic despite being plumbing`);
    }

    const uncategorized = await env.store.getAll('uncategorized');
    const reasons = new Map(uncategorized.map(u => [u.normalizedUrl, u.reason]));
    assert.strictEqual(reasons.get(ssoUrl), 'utility_page', 'the SSO page is not reported as a utility page');
    assert.strictEqual(reasons.get(dlUrl), 'utility_page', 'the download page is not reported as a utility page');
    assert.ok(result.counts.utilityPagesExcluded >= 2,
      `expected at least 2 utility exclusions, got ${result.counts.utilityPagesExcluded}`);

    // No embed budget was spent on them.
    const embedded = await env.store.getAll('pages');
    const ssoPage = embedded.find(p => p.normalizedUrl === ssoUrl);
    assert.ok(ssoPage, 'the page row should still exist for coverage accounting');
    assert.ok(!ssoPage.embeddingKey, 'a utility page must never be embedded');
  }

  // ---- evicts a membership written before the filter existed -------------
  {
    const env = await makeEnv();
    const first = await env.runThroughDay(1);
    assert.strictEqual(first.ok, true);

    const CTText = require('../../lib/text.js');
    const ssoUrl = CTText.normalizeUrl(SSO_URL);
    const topics = await env.store.getAll('topics');
    assert.ok(topics.length, 'fixture should have produced topics on day 1');
    const victim = topics[0];

    // Exactly the state a pre-filter record is in: an SSO page sitting inside
    // a real topic, contributing its dwell to it.
    await env.store.put('memberships', {
      topicId: victim.topicId,
      normalizedUrl: ssoUrl,
      assignedRunId: first.runId,
      similarity: 0.79,
      dwellMs: 28 * 60 * 1000,
      visitCount: 2,
      firstDay: null,
      lastDay: null
    });
    assert.ok((await env.store.getAll('memberships')).some(m => m.normalizedUrl === ssoUrl),
      'seeding the stale membership failed');

    spliceUtilityVisits(env);
    const second = await env.runThroughDay(2);
    assert.strictEqual(second.ok, true, `second run failed: ${second.error}`);

    const after = await env.store.getAll('memberships');
    assert.ok(!after.some(m => m.normalizedUrl === ssoUrl),
      'the stale utility membership survived — the topic keeps its bogus evidence');
    assert.ok(second.counts.utilityMembershipsRemoved >= 1,
      'the run did not report removing any utility membership');
  }

  console.log('relevance protocol tests passed');
})().catch(error => { console.error(error); process.exit(1); });
