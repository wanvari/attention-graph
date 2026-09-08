# Cognitive Trails 5.1 implementation and resume checklist

Branch: `v4` → `origin/v4` (GitHub: wanvari/attention-graph). Push each verified milestone. Baseline: `396929f`; pre-rebuild checkpoint: `58cf412`. No merge into main is requested.

## Resume here

Status: release verification complete; GitHub push and installed-extension update remain. Implemented dashboard, sessions, corrections, shared evidence/Map/Audit, operational-page timing fix and schema 5. The installed Claude Status case was diagnosed on a private read-only copy: ~805m in history-gap totals versus 35s of captured interaction; repair retains 35s and removes automatic membership. Private originals are preserved under ignored .tmp/private-diagnostics. Next: commit/push all public changes, reload the installed extension, verify schema/version/35s/no membership without changing raw visits, and record the result here. Do not restart completed work.

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
- [ ] 6. Validation/release: full unit/protocol/UI tests, extension E2E, inference/laptop checks, performance, visual QA, documentation/version/package, final commit/push.

## Verification ledger

- Baseline `396929f`: previously reported 29 suites and extension E2E passing; prior M3 Pro synthetic-month benchmark 132 seconds / 3 passes, peak Ollama residency ~3.59 GiB. These are prior results, not verification of 5.1.
- Current turn: `git status` clean, `v4...origin/v4` at baseline.

## Investigation notes / limitations

- Source investigation found status.claude.com not treated specially; direct assignment only tests centroid cosine >= .78 and bypasses singleton evidence floor. These are verified code behaviors, not a confirmed root cause of the installed 805-minute value.
- The exact ~805-minute instance was inspected on September 7 using a copy of the installed schema-4 database. Its 211 history entries sum to ~805 minutes; capture totals are 35 seconds. Repeated entries are consistent with background refresh but do not establish visible browsing time. Current calculations exclude unmeasured operational-page gaps and require measured evidence for operational grouping. Applying repair to the installed database still remains.
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
