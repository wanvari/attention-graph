# Code review response

Nine findings from an external review, all verified against the code before
being acted on. All nine were real. Fixed in the order requested: Ollama
scoping and capture durability first, then pause/delete/retention, then the
backlog and incremental correctness, then map metrics and accessibility.

## 1. Local-CSRF surface through the origin rewrite — **fixed**
`rules_ollama.json` set `Origin` for any request to `localhost:11434` with no
`initiatorDomains`, and Chrome applies such a rule to requests from *every*
initiator. Ollama's defence against a webpage driving it is exactly that
origin check, so the rule handed the bypass to every page the user visits: a
page could `POST /api/delete` with `no-cors`, never read the response, and
Ollama would still execute it.

Rules are now built by `lib/ollamaRules.js` and registered dynamically once
the extension knows its own id, scoped with `initiatorDomains: [id]`. The
static rule file is gone. Verified with Chrome's own matcher
(`declarativeNetRequest.testMatchOutcome`): **self 1 match, web page 0, other
extension 0** — asserted in `tests/e2e/capture.e2e.mjs`.

## 2. Captures acknowledged before durable — **fixed**
The buffer was cleared before the IndexedDB write resolved, write failures
were swallowed, and the message was acknowledged immediately — while the
content script stopped resending the extracted text on that acknowledgement.
A worker teardown or a failed write lost the text permanently.

Buffering moved to `lib/captureBuffer.js`: flushes are serialized, rows stay
queued until the write resolves, and `textStored` is only reported once the
text is actually in IndexedDB. The content script keeps resending until it
hears that. Eight unit tests cover the failure paths, including an update
arriving mid-write.

## 3. Pause and denylist did not protect open tabs — **fixed**
Settings were read once at content-script load, so an already-open tab kept
capturing after a pause and a tab opened while paused never resumed. SPA
navigation also built a new capture without re-running the exclusion checks,
so an allowed route could client-side navigate into `/login` or `/payment`
and be captured.

Settings now propagate through `chrome.storage.onChanged`, and every SPA
navigation re-checks the destination. Two e2e tests: a client-side route into
`/login` produces no capture and none of its text, and pausing stops an
already-open tab's active time from advancing.

## 4. Deletion and retention were not lifecycle-safe — **fixed**
Delete-everything wiped storage from the audit page while the capture buffer
and any in-flight pipeline kept writing. The worker now owns deletion: refuse
new work, drop the buffer, close the offscreen document, then wipe.

Retention ran only after a successful Ollama run, so page text could sit
indefinitely whenever Ollama was unavailable — a privacy guarantee made
conditional on a dependency it should not depend on. It now runs on its own
6-hourly alarm and at startup. (Also fixed a falsy-zero bug where
`retentionSweep(now, 0)` silently used the 30-day default.)

## 5. Deferred work permanently dropped — **fixed**
Reproduced exactly as reported: with a cap of 1, two runs embedded 2 of 53
pages and abandoned the rest, because embed candidates were selected by the
time window alone. Once a deferred page fell out of the window it was never
reconsidered — contradicting the settings copy.

The backlog is now a property of the page row (`needsEmbedding`), so it
survives the window moving and is retried until done. A test drives a tiny
budget and asserts the queue fully drains.

## 6. Incremental runs corrupted historical state — **fixed**
Three separate defects:
- Page aggregates were rebuilt from the overlap window's captures only,
  shrinking a page's lifetime `activeMs` on every incremental run. They now
  read every capture for the URL.
- A revisit with no fresh capture text recomputed a title-only embedding over
  an existing content one. Text ages out after 30 days by design, so an
  existing content vector is now kept rather than downgraded.
- `dayCommit` replaced a whole day's exclusion records with the partial set a
  run happened to produce, erasing records it never examined. Exclusions are
  upserted, and cleared only for pages the run positively categorized.

`tests/protocol/incremental.test.js` covers all four properties.

## 7. Vector-space and registry invariants — **fixed**
- `embed()` now validates every vector: non-empty, consistent dimension,
  finite values, non-zero norm. Counting vectors was not enough; a malformed
  one is silently blended into a centroid.
- Because model names are user-editable, the pipeline records the embedding
  model that produced the registry and **refuses to run** if it changes while
  topics exist, rather than blending two vector spaces into meaningless
  cosines. The error names the previous model and the way out.
- Retired topics could silently reactivate through the revisited-page path,
  contradicting the rule that retired topics are not matched against. That
  path now skips them.
- The user-confirmed merge copied memberships without deleting the absorbed
  topic's originals, membershipping pages twice. `registryCommit` gained
  `removeMemberships`, and the merge moves rather than copies.

## 8. Map windows were not windowed — **fixed**
Membership rows carry a page's lifetime dwell and visit totals, so a 7-day
window reported months of attention as if it happened that week. Window
figures now come from the visits actually inside the window; memberships only
say which topic a page belongs to. `visitCoverage` was a copy of the
active-time ratio under a different name and is now computed from visit
counts. The map's "Re-run analysis" affordance only re-read IndexedDB, so it
is replaced with a link to the Audit page, which can actually start a run.

## 9. Product and accessibility details — **fixed**
- The transition prompt asked the model to infer the reader's "task, project…
  or research thread". The adjacent/switch classification itself is sanctioned
  by the spec (§10 keeps it explicitly), but the wording asked for intent.
  It now asks only whether the subject matter continues, and says plainly:
  *do not infer the reader's intent, task, or purpose.*
- Clickable metric rows had no keyboard semantics. They are now
  `role="button"`, focusable, `aria-expanded`/`aria-controls`-wired, operable
  with Enter and Space, and have a visible focus ring.
- The band badges measured **2.30:1** and **2.79:1** in light mode against a
  4.5:1 AA requirement. They now carry explicit background and text colours
  per theme, measuring 5.9–8.4:1 in both, still within one neutral hue and
  still free of valence. A contrast test computes the ratios and fails the
  build below AA.

## Testing
18 Node test files (up from 15), plus both Playwright suites and the extension
page-load check, all green. Three new suites: `captureBuffer`, `ollamaRules`,
`incremental`.

The golden replay was also strengthened. Transition labelling treats a failed
model call as best-effort, so a drifted prompt was being swallowed rather than
failing the replay — the test now asserts zero unmatched prompts, which
immediately caught the prompt rewording in finding 9. Golden and snapshot
re-recorded against live `gemma3:12b`.
