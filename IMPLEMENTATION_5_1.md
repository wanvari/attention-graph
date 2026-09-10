# Cognitive Trails 5.1 implementation and resume checklist

Branch: `main` → `origin/main` (GitHub: wanvari/attention-graph). The user requested promotion to main on September 8, 2026. The verified release through `73fda68` was fast-forwarded from `v4`, preserving all commits. Push subsequent verified milestones to main. Baseline: `396929f`; pre-rebuild checkpoint: `58cf412`.

## Resume here

Status: September 10 code review, new regressions and retesting **complete** for **5.1.1**. Implementation is committed/pushed to GitHub main as `ddb60d0`; this validation checkpoint adds fresh recordings, measurements and the finished report. Repair version 3 updates stored accounting on startup. Full suite **36/36**, capture E2E (16 checks), expanded Home/session/Audit E2E, all four live pipeline checks, and packaged-product E2E pass. Fresh M3 Pro check: two processing passes, **133.062s** combined including **65.665s** pacing; **3.592 GiB** peak sampled model residency, no model overlap, zero pending work. Exact fresh-recording replay passes. Package: `dist/cognitive-trails-v5.1.1.zip` (0.344 MiB), 51 runtime files matched to source and no private/development artifacts. See `validation/report-2026-09-10.md` for findings, tests and limits. No pending implementation/testing step for this request; no installed user history was accessed or extension reloaded. Reload the installed extension to use 5.1.1. Further work should begin with the documented pilot limitations rather than repeat this completed pass.

Previous release: 5.1.0 is installed; database schema 5 and evidence-repair version 2 applied. The actual Claude Status record is repaired: 35s recorded interaction, 211 navigation entries preserved, 129 unknown-duration entries explicitly labeled, no automatic membership. Preserve that checkpoint and the documented pilot limitations.

### September 10 review checklist

- [x] Inspect development contract, branch, prior checklist and test inventory; run baseline tests.
- [x] Review core accounting, privacy/capture, durable sessions, storage/pipeline and UI integration.
- [x] Add deterministic map fixtures and meaningful regressions for confirmed defects; fix failures.
- [x] Run all unit/protocol/UI tests and relevant browser E2E suites; record actual results and limitations.
- [x] Commit/push implementation to main, verify remote commit, and record the completed validation checkpoint.

Review evidence: `tests/unit/evidenceBoundaries.test.js` covers overlap precedence, 100 deterministic allocation-oracle/permutation cases, pause boundaries, simultaneous visits, and Map/recap consistency. `tests/unit/sessionRecovery.test.js` covers open/closed pauses on restart, deadline ordering, alarm failure, notification cleanup and idempotent completion. Existing capture/worker/integrity suites now cover back/forward cache, hidden gaps, 31 minutes of observed interaction, concurrent starts, malformed intervals, late paused captures and the version-3 repair gate. Browser session tests include a worker restart after a partially persisted pause. Logs are ignored `.tmp/review-2026-09-10-*.log`; do not reuse September 7 results as current validation.

## Accepted product decisions

- Home order: search, Today dashboard, continuation card, recent/pinned trails. Time headline plus three literal rings: Continuity (same-trail / classified within-session transitions), Top trail (largest trail / grouped estimated minutes), Return (minutes in trails first observed before that day / grouped minutes). No composite or cognitive/productivity score.
- Compare today through the current local clock time against up to 28 preceding calendar days with usable evidence. Median and Tukey Q1/Q3, minimum 7 eligible days; continuity eligibility 3 classified transitions, minute ratios 10 grouped minutes. Below/within/above labels with ochre/slate-blue/plum colors; insufficient evidence gray. Explicit denominators, evidence drawers, grouped and timing coverage.
- Passive first. Optional selected-trail sessions: 25/50/90 minutes or untimed, next-step note, one active session, durable restart-safe timer, generic end notification, factual recap (target/other/ungrouped time, evidence). No drift nudges or model calls from dashboard/session actions. Pausing ends a session; deletion clears sessions, alarms, notifications.
- Fix brief Claude Status visit reported as a cross-site connection and 805 minutes. Diagnose raw evidence and aggregation, conservative status-page grouping, stronger member-supported assignment, explicit visit/page/trail time scopes, repeated map links, durable move/remove/keep-ungrouped corrections, repair existing derived data.
- Preserve local privacy, raw history, corrections and laptop inference budgets. Version 5.1.0, IndexedDB schema 5. Home/map/recaps must share corrected evidence accounting. Unknown historical duration must remain unknown, not invented or claimed repaired.

## Milestones

- [x] Confirm baseline checkpoint, clean branch, GitHub upstream.
- [x] 1. Evidence integrity: reproduce brief status-page case; shared bounded interval accounting; one-to-one capture/history reconciliation; explicit timing provenance; raw-vs-derived audit and idempotent repair. Diagnose installed data if accessible without changing user history.
- [x] 2. Grouping integrity: status/operational evidence rules; evidence floor on direct attachment; member support and runner-up margin; durable membership overrides; retryable repair of stale grouping; repeated map connections.
- [x] 3. Daily analysis: pure daily signals, same-clock comparisons and quartiles, minimum evidence, coverage/evidence, deterministic continuation.
- [x] 4. Sessions/backend: schema migration, serial worker messages, durable start/end/reconciliation, alarms, generic notifications, deletion/pause integration, recap.
- [x] 5. UI: dashboard/rings/comparisons/drawers; precise time scopes and corrections; session controls/recap; responsive and keyboard access; sample record.
- [x] 6. Validation/release: full unit/protocol/UI tests, extension E2E, inference/laptop checks, performance, visual QA, documentation/version/package, final commit/push.

## Verification ledger

- Baseline `396929f`: previously reported 29 suites and extension E2E passing; prior M3 Pro synthetic-month benchmark 132 seconds / 3 passes, peak Ollama residency ~3.59 GiB. These are prior results, not verification of 5.1.
- Current turn: `git status` clean, `v4...origin/v4` at baseline.

## Investigation notes / limitations

- Source investigation found status.claude.com not treated specially; direct assignment only tests centroid cosine >= .78 and bypasses singleton evidence floor. These are verified code behaviors, not a confirmed root cause of the installed 805-minute value.
- The exact ~805-minute instance was inspected on September 7 using a copy of the installed schema-4 database. Its 211 history entries sum to ~805 minutes; capture totals are 35 seconds. Repeated entries are consistent with background refresh but do not establish visible browsing time. Current calculations exclude unmeasured operational-page gaps and require measured evidence for operational grouping. The installed extension was reloaded to 5.1.0 and live schema-5 diagnostics confirm the repair.
- All work is local. User data or browser records must not be committed. Use synthetic/minimized regressions; private diagnostic output goes under ignored `.tmp/` only if necessary.

### Foundation checkpoint

- Shared global interval allocation and timestamped capture intervals implemented. Finished sub-two-second captures are observed; initial zero remains unknown. Legacy history gaps are explicitly estimates. Raw gap estimates are retained separately from replaceable derived dwell.
- Atomic evidence repair, duplicate-owner abstention, status/evidence gating, member-supported direct/cluster assignment and runner-up margin implemented. Worker override messages and registry commit protection implemented. Map integration and correction UI remain.
- Database schema 5 and durable session manager/messages implemented, including delayed alarms, pause/deletion, generic notification retry, untimed sessions and seen recaps. UI integration/E2E remain.
- `npm test`: **32/32 passing** (including fresh exact current-profile replay, synthetic 805-minute regression, atomic corrections, daily comparisons/DST and session lifecycle).
- Live `node tools/laptopCheck.js`: completed in **2 passes**, ~130.8 seconds total; fresh full requests/vectors/snapshot saved under fixtures/current. No model overlap. The prior replay intentionally failed after evidence inputs changed, then passed against new live recordings.
- Changes to fixture expectations: brief one-off pages no longer automatically group; 2-day scripted fixture now forms 7 supported topics. Excluded pages need not consume embedding work. Existing durability, drift, lifecycle and privacy assertions continue passing.

### Dashboard and investigation checkpoint (September 7)

- Three literal rings, comparison ranges, formulas, contributing records, continuation, session forms/countdown/recap and durable correction controls implemented. Removing a last page retains the ability to assign it back. Map uses the same allocated time and draws only repeated sequences; corrected edge examples and zero-coverage rendering.
- Read-only legacy diagnostics added, avoiding a schema upgrade; Audit now shares Home/Map accounting and exposes explicit recalculation. Session records are included in metadata exports. Blocked schema upgrades now fail with a recovery instruction and can retry without leaking connections.
- Actual status case exposed a missing policy: repeated background navigation could bypass the operational evidence gate, and unmeasured gaps still produced ~802m after generic overlap correction. Fixed: unknown operational gaps contribute no time, recorded interactions are retained, repetition alone cannot group operational pages. Private database copy produces **35 seconds and no automatic membership**, while preserving every original navigation record. Private copies/scripts remain only under ignored `.tmp/private-diagnostics` / `.tmp`.
- Latest full unit/protocol/UI run: 32/32, before adding diagnostics/migration tests. The new diagnostics/migration test passes independently; next full run should contain 33 suites.
- Expanded real extension E2E passes: literal evidence drawers/focus restoration, keep-ungrouped and reassignment, 25-minute and untimed sessions, double-start rejection, reload, manual end, delayed alarm, service-worker restart, recap link, pause and deletion/alarm/notification cleanup.
- Live laptop recheck completed: 2 passes / 138.138 seconds / ~3.59 GiB sampled peak, no model overlap; record construction 6.5 ms. Current transcript replay passes. Reports use the actual September 7 date.
- Remaining: screenshot review (light/dark/mobile), Map repeated-link/correction regression, audit integration verification, capture/pipeline E2E, release docs/version/package and final push. Installed old pages have a blocked database upgrade; reload the installed extension only after release checks, using the saved private backup as evidence protection.

### Release verification in progress

- Full tests now pass **33/33**. Updated schema-sensitive capture E2E passes all 16 checks. Expanded Home/session/Audit/export/diagnostics E2E passes. Dark/light and 390px sample screenshots reviewed; trail-card grid overflow fixed.
- Larger synthetic computation: 20,000 visits, 1,000 pages, 100 trails; record 293ms + daily signals 133ms (Node only, no storage/DOM). Reports/docs/version now target 5.1.0; package not yet produced.
- Pipeline E2E exposed a pre-existing same-host redirect heuristic that dropped actual rapid visits. Removed hostname-only collapse; explicit automatic-transition collapse remains. Unit and exact current replay being checked, then real pipeline test. Prior pipeline attempts failed their live embedding assertion because a real page had been incorrectly collapsed; do not call those attempts passes.
- Correction repair also clears stale exclusion reasons and retries centroid rebuilding if cached vectors become available. All new private diagnostics remain ignored. No installed database mutations yet.

### Verified release checkpoint

- Live pipeline E2E now passes **all four checks**, including actual repeat-page inference, offscreen closure, stale-run recovery and duplicate scheduling. Fixed hostname-only redirect collapse; supported pages now survive and reach inference. Current exact replay remains passing.
- Unknown-duration-only days are excluded from time comparisons; sparse comparison histories no longer display invalid quartiles. Schema-5 repair gate is version 2, so installations that briefly ran the earlier repair will receive the operational-page fix.
- Release version **5.1.0** built in `dist/cognitive-trails` and `dist/cognitive-trails-v5.1.0.zip` (~0.34 MiB). Archive checked for private diagnostics, .git, node_modules and model recordings: none included.
- Latest targeted dashboard test passes. Final full test **33/33** and exact packaged-product E2E **pass**, recorded in `.tmp/tests-5.1.log` and `.tmp/package-5.1.log`; no new model run is needed for these UI/baseline display checks.
- Only remaining implementation steps: commit/push this milestone, update installed extension, verify live evidence, and mark final checklist. Store publication and independent human/hardware evaluation are outside the authorized local build and remain documented pilot limitations.

### Completed installed verification

- GitHub milestone **cd76c5a** pushed to `origin/v4`. Installed extension was still manifest version 4.0; reloaded through its own Chrome extension controls and verified **5.1.0**. No user history was deleted or replaced with fixtures.
- Live read-only diagnostics confirm **schema 5**, stored page and visit totals **35,000ms**, **211 original status-page entries**, and **empty automatic membership**. The normal Home page drawer independently shows **35s**, explicitly labels unknown visit duration, and discloses **129 unknown-duration entries**. Missing history gaps are excluded rather than presented as observed zeros.
- Home/rings load against the live record. A final copy pass distinguishes passive recorded **episodes** from opt-in **sessions**, keeps sub-minute evidence in seconds, and labels unknown durations in search and evidence lists. Added a DOM regression; UI/copy checks pass. Backend/inference are unchanged by this final copy pass.
- All six implementation milestones are complete. Private diagnostic backups remain ignored locally; the distributed archive contains only runtime assets and a synthetic sample. Release documents retain the actual limits: one measured M3 Pro, mixed-page grouping weaknesses, no human-quality validation or store publication.

### Main promotion (September 8, 2026)

- Promoted the verified 5.1 release from v4 to main by fast-forward, preserving the full commit history. No merge conflicts or runtime changes.
- Updated this resume checklist to track main going forward. Validation remains the completed 33 test files and capture, live pipeline, and packaged-product E2E checks; this promotion changes only the branch and checklist.
