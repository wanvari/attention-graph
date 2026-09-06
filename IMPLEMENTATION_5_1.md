# Cognitive Trails 5.1 implementation and resume checklist

Branch: `v4` → `origin/v4` (GitHub: wanvari/attention-graph). Push each verified milestone. Baseline: `396929f`; pre-rebuild checkpoint: `58cf412`. No merge into main is requested.

## Resume here

Status: implementing. Last completed step: baseline verified clean and already pushed. Next: investigate timing/classification and implement shared evidence accounting. Read this file, `git status --short --branch`, and recent commits before resuming. Do not restart completed work. Keep incomplete work and failing checks recorded here before stopping.

## Accepted product decisions

- Home order: search, Today dashboard, continuation card, recent/pinned trails. Time headline plus three literal rings: Continuity (same-trail / classified within-session transitions), Top trail (largest trail / grouped estimated minutes), Return (minutes in trails first observed before that day / grouped minutes). No composite or cognitive/productivity score.
- Compare today through the current local clock time against up to 28 preceding calendar days with usable evidence. Median and Tukey Q1/Q3, minimum 7 eligible days; continuity eligibility 3 classified transitions, minute ratios 10 grouped minutes. Below/within/above labels with ochre/slate-blue/plum colors; insufficient evidence gray. Explicit denominators, evidence drawers, grouped and timing coverage.
- Passive first. Optional selected-trail sessions: 25/50/90 minutes or untimed, next-step note, one active session, durable restart-safe timer, generic end notification, factual recap (target/other/ungrouped time, evidence). No drift nudges or model calls from dashboard/session actions. Pausing ends a session; deletion clears sessions, alarms, notifications.
- Fix brief Claude Status visit reported as a cross-site connection and 805 minutes. Diagnose raw evidence and aggregation, conservative status-page grouping, stronger member-supported assignment, explicit visit/page/trail time scopes, repeated map links, durable move/remove/keep-ungrouped corrections, repair existing derived data.
- Preserve local privacy, raw history, corrections and laptop inference budgets. Version 5.1.0, IndexedDB schema 5. Home/map/recaps must share corrected evidence accounting. Unknown historical duration must remain unknown, not invented or claimed repaired.

## Milestones

- [x] Confirm baseline checkpoint, clean branch, GitHub upstream.
- [ ] 1. Evidence integrity: reproduce brief status-page case; shared bounded interval accounting; one-to-one capture/history reconciliation; explicit timing provenance; raw-vs-derived audit and idempotent repair. Diagnose installed data if accessible without changing user history.
- [ ] 2. Grouping integrity: status/operational evidence rules; evidence floor on direct attachment; member support and runner-up margin; durable membership overrides; retryable repair of stale grouping; repeated map connections.
- [ ] 3. Daily analysis: pure daily signals, same-clock comparisons and quartiles, minimum evidence, coverage/evidence, deterministic continuation.
- [ ] 4. Sessions/backend: schema migration, serial worker messages, durable start/end/reconciliation, alarms, generic notifications, deletion/pause integration, recap.
- [ ] 5. UI: dashboard/rings/comparisons/drawers; precise time scopes and corrections; session controls/recap; responsive and keyboard access; sample record.
- [ ] 6. Validation/release: full unit/protocol/UI tests, extension E2E, inference/laptop checks, performance, visual QA, documentation/version/package, final commit/push.

## Verification ledger

- Baseline `396929f`: previously reported 29 suites and extension E2E passing; prior M3 Pro synthetic-month benchmark 132 seconds / 3 passes, peak Ollama residency ~3.59 GiB. These are prior results, not verification of 5.1.
- Current turn: `git status` clean, `v4...origin/v4` at baseline.

## Investigation notes / limitations

- Source investigation found status.claude.com not treated specially; direct assignment only tests centroid cosine >= .78 and bypasses singleton evidence floor. These are verified code behaviors, not a confirmed root cause of the installed 805-minute value.
- The exact stored 805-minute instance is unresolved. Do not claim it is repaired without inspecting its evidence. A page's brief visit must never inherit a whole trail's displayed total.
- All work is local. User data or browser records must not be committed. Use synthetic/minimized regressions; private diagnostic output goes under ignored `.tmp/` only if necessary.
