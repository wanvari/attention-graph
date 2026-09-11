# Efficiency review — September 11, 2026

Version 5.1.2, compared with `183ab41` (5.1.1). Models, prompts, embedding inputs, clustering thresholds, inference pacing and capture timing are unchanged. The separate Studio interface branch is preserved; this work is based on main.

## Changes

- Schema 6 adds derived metadata stores for captures, topics and embeddings. Cursor backfill and all subsequent source/projection/revision writes are atomic. Original capture text, vectors and records stay in their existing stores.
- Home reads metadata directly. Unchanged refreshes read only small revision records; changes from any store instance invalidate the affected table. Time-dependent record calculations still receive the current clock on refresh.
- Shared page grouping evidence is computed once per page; events are indexed by topic. Daily comparisons allocate one timeline and use bounded lookups for the 29 windows.
- Completed startup repair checks its version before reading the full database. Explicit repair retains the full rebuild and avoids writes of unchanged source rows. Corrections remain atomic and protected against late model commits.

## Measured results

Apple M3 Pro. CPU results use five alternating repetitions against the frozen old implementation with identical synthetic input, explicit GC between repetitions and no inference. Values are medians; component medians need not sum to total medians.

| Synthetic input | Old record + daily calculations | New | Reduction |
| --- | ---: | ---: | ---: |
| 20,000 visits / 1,000 pages / 100 trails | 200.40 ms | 104.49 ms | 47.9% |
| 100,000 visits / 5,000 pages / 500 trails | 1,353.33 ms | 449.23 ms | 66.8% |

Real Chromium 151, separate disposable database: 3,000 captures with 8,000 retained text characters each (24 million total). Median old raw-read-then-strip was 34.7 ms, metadata read 5.1 ms, unchanged refresh 0.1 ms. One schema-5-to-6 backfill took 275 ms. Timer resolution matters for the tiny unchanged case. These are storage-read measurements, not complete UI rendering or memory-residency claims. Projections add metadata storage and small transactional write overhead; total disk growth and battery life were not measured.

Raw reports: [CPU](performance-2026-09-11.json), [Chromium storage](storage-2026-09-11.json). Reproduce with `npm run check:performance` and `npm run e2e:storage`. Reruns replace these measurement files.

## Verification

- Baseline: 36/36 existing test files passed.
- Infrastructure: existing 36 plus new output-equivalence and storage-projection suites pass. The final working-tree run also includes the initial context-input test: 39/39 total.
- 316 full record/dashboard/recap comparisons against frozen 5.1.1 match every output field. Cases include changed evidence, corrections, overlapping tabs, simultaneous visits, future/clipped observations, unknown status-page durations, open/closed pauses, midnight and DST across three time zones.
- Schema-5 source text and vectors survive migration unchanged. Tests cover cross-context revision reuse, atomic abort, retention, range deletion, deletion followed by new writes, and a completed repair gate that reads no full tables.
- Home/session/Audit browser E2E passes, including worker restart, user corrections, persistence and deletion.
- Capture E2E passes all 16 checks. Live pipeline E2E passes all four checks. Existing exact production transcript replay remains passing; fixtures/current was not replaced.
- Real Chromium migration and metadata read E2E passes all five checks.

No installed user database was opened or modified, and the installed extension was not reloaded. Upgrading an installation requires the usual extension reload to close older database connections. Schema 6 is forward migration; an old schema-5 binary cannot open the upgraded database. Packaging/onboarding improvements and broader hardware validation remain outside these two authorized steps.
