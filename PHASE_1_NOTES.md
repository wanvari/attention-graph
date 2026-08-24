# Phase 1 Notes — Storage and registry core

## Done
- `lib/text.js`: normalizeUrl (query/fragment/trailing-slash/case/IDN/www/ports; non-http(s) and malformed input returned unchanged), tokenize, cleanTitle, FNV hash, DST-safe day-key arithmetic.
- `lib/store.js`: full §3.1 schema on IndexedDB `cognitive-trails` v4, injectable indexedDB (fake-indexeddb in Node), transactional `registryCommit` (all-or-nothing, injectable failure for tests), per-day `dayCommit` that replaces day-scoped rows, embedding prune (idle > 45 d AND no membership), 30-day `extractedText` retention sweep, wipe, migration from v3.
- `lib/cluster.js`: average-linkage agglomerative clustering over cosine distance, canonical input ordering for order invariance, assign-to-existing (0.78), cluster cut (0.70), thin-singleton routing, 20-topic cap, zero/NaN vector rejection, v3 heuristic confidence (mixed-domain logic demoted to penalty per §4.3.4).
- `lib/registry.js`: match scoring (0.7·cosine + 0.3·60-day page overlap), merge ≥ 0.80 / near-miss 0.65–0.80 / create, merge-proposal (never auto-executed), dwell-weighted centroid update, relabel rule with alias retention, lifecycle (dormant ≥ 14 d dated to the crossing day, retire ≥ 120 d & < 30 min unless user-corrected), paused-day subtraction, revival events with dormantDays.
- `lib/metrics.js`: entropy, day metrics (§4.9), transition building with reload/session-end skips and honest uncovered count, focused runs (≥ 5 min), convergence (both sources, trailing 7 d), 28-day baselines (n ≥ 14, sample std), z-scores clamped ±4 with the three neutral bands.
- Fixtures: `tools/makeFixtures.js` (seeded, deterministic) → 384 pages (324 topical over 12 topics, 40 ambiguous, 20 junk) + 28 days of designed visits (dormancy/revival, daily topic, llm_chat→web convergence, 3-day gap, low-data day, DST day, midnight session, pause interval). `tools/embedFixtures.js` produced real bge-m3 vectors, committed as `fixtures/embeddings.bin` (1.5 MB).
- Tests: `tests/unit/{text,store,cluster,registry,metrics}.test.js`, all green. Order invariance passes 20/20 shuffles on real vectors; migration test uses a seeded v3-shaped DB.

## Decisions / deviations
- **Fixture authorship**: the spec says "hand-curated" pages. Hand-writing ~150k words inline was not practical; instead the curation is 12 hand-written per-topic sentence banks (15 sentences each) plus junk/ambiguous templates, composed deterministically by a committed, seeded generator. Regenerate with `node tools/makeFixtures.js && node tools/embedFixtures.js`.
- **Migration is cross-database**: v3 actually stored data in `attentionGraphTrustAudit` (a different DB name), so "single onupgradeneeded transaction" is impossible; instead migration copies embeddings/corrections/settings into `cognitive-trails`, is idempotent, only deletes the old DB after success, and surfaces `migrationError` without marking done on failure (v3 data survives; retry works).
- **Dormancy off-by-one**: §4.7 says the dormant event fires at `lastActiveDay + 14`; §7.4 implies day 22 for a topic last active day 7 (i.e. +15). I implemented §4.7 (dormant when ≥ 14 days without activity; tests pin 13/14/15). `tools/validate.js` will assert day 21, not 22.
- **Embedding-vector cosine check**: within-topic p5 ≈ 0.77, cross-topic p95 ≈ 0.55 on the fixture set, so the spec's 0.70/0.78 defaults sit in the separation gap. Formal ARI validation comes with Phase 3's `tools/validate.js`.
- Added `totalDwellMs` to topic rows (needed for dwell-weighted centroid updates and the retirement dwell test) — a field §3.1 implies but does not list.

## Open questions
- None blocking. Threshold tuning waits for §7.4 validation.
