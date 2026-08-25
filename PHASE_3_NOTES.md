# Phase 3 Notes — Pipeline

## Done
- `lib/ollama.js`: injectable transport, batched embeds with one retry, `keep_alive` control, explicit `num_ctx`, fence-tolerant JSON parsing, `/api/ps` residency reporting. Parse failures are tagged `error.code = 'parse'` so a malformed batch degrades locally while a transport failure fails the run.
- `lib/history.js`: v3 dwell/session logic plus v4 redirect collapse (< 2 s + auto-transition or same domain), pause-interval exclusion, denylist exclusion at ingest, and the capture-based dwell upgrade `min(activeMs, gapDwell)` within a ±90 s match window.
- `lib/label.js`, `lib/adjudicate.js` (v3 protocol + the §4.6 split-grouping Jaccard fix), `lib/brief.js`, `lib/pipeline.js` (staged commits, heartbeats, watermark discipline), `offscreen/analysis.{html,js}` with a service-worker history proxy.
- Fixtures: `tools/recordGolden.js` records a real sequential gemma3:12b run (`fixtures/golden/calls.json` + `snapshot.json`); `tests/protocol/golden.test.js` replays it without Ollama and fails loudly if a prompt hash drifts.
- Tests: `tests/unit/{history,adjudicate,brief}.test.js` and `tests/protocol/pipeline.test.js` (happy path, Ollama down per stage with watermark unmoved, registry rollback + recovery, adjudication timeout, malformed label batch, unknown ids).

## The one significant deviation: the adjudication gate

The first golden recording exposed a real failure. Of ~105 embedded pages, **123 memberships were dumped into `uncategorized` with reason `disagreement`**, including the entire "Async Rust Programming" and "Sourdough Baking" topics — pages that are 100% single-ground-truth.

Cause: the v3 gate fires when `dominantDomainShare < 0.75`. That was a sound proxy when embeddings saw only titles. With content embeddings it inverts. Measured on the fixture:

| cluster type | cohesion | dominant domain share | old heuristic confidence |
|---|---|---|---|
| 12 real topics | 0.795 – 0.877 | 0.20 – 0.60 | 0.55 – 0.80 |
| ambiguous | 0.571 | 0.35 | 0.52 |
| junk | 0.499 | 0.10 | 0.34 |

Domain share does not separate real topics from junk **at all** — genuine research topics span 4–5 domains, blended pages cluster on fewer. Worse, the 0.6-weighted mixed-domain penalty dominated `heuristicConfidence`, dragging every real topic under the 0.68 bar too, so *both* gate conditions fired on *every* real topic. gemma then reliably answered "split" for a large coherent topic (it likes to subdivide 20 pages of async Rust into "Tokio internals" / "Pin and Unpin" / "cancellation safety") but could not reproduce the same subdivision with the page order reversed — so the §4.6 Jaccard check correctly called it disagreement, and D7 correctly excluded the pages. Every layer behaved as specified; the gate was pointing at the wrong evidence.

The spec already contains the correct reasoning, in §4.3.4: *"keep v3's cross-domain logic only as a confidence penalty, not as a merge veto. Content embeddings make domain a weak prior."* That instruction was applied to clustering but not carried through to the adjudication gate or the confidence formula, both inherited verbatim from v3. This is the same class of internal inconsistency D8 identifies for the clusterer.

Fix, in two parts:
1. `MIXED_DOMAIN_PENALTY_WEIGHT` 0.6 → **0.15**, making domain diversity the nudge §4.3.4 asks for rather than a veto.
2. The gate's blended-evidence trigger is now **cohesion < 0.70** instead of `dominantDomainShare < 0.75`. The threshold is the clusterThreshold: a cluster whose average internal similarity is below the bar we require to merge two pages is suspicious by our own standard.

Result on the same fixture, re-recorded:

| | before | after |
|---|---|---|
| disagreement exclusions | 123 | **0** |
| uncategorized reasons | disagreement 123, thin 13, no_content 2, agreed 1 | thin 13, no_content 2 |
| chat calls in the golden run | 34 | **7** |
| ground-truth topic purity | — | **100% on all 12 topics, 0 impure topics of 22** |

The protocol itself is untouched: two passes, order reversed, Jaccard ≥ 0.60, disagreement still excludes. It now fires on genuinely mixed material instead of on honest multi-domain research. `tests/unit/adjudicate.test.js` pins the regression from both sides: a cohesive multi-domain cluster must not spend audit budget, and a single-domain incoherent cluster must.

## Other decisions
- Ambiguous fixture pages are **not** excluded; they form small clusters that gemma labels honestly ("Weekly Link Roundups", "Medium Link Roundups"). That is the correct behavior — the pages really are link roundups, and inventing an exclusion would be as dishonest as inventing a theme. They never contaminate a real topic (purity table above). Exclusion recall is therefore low on this fixture and exclusion *precision* is the meaningful number.
- Split-grouping partial agreement now applies pass 1's surviving groups when at least one group survives the disputed-pair filter, rather than requiring two. Requiring two discarded clusters the passes genuinely agreed about.
- Transition labeling runs on **today only**, ≤ 1 label + ≤ 1 verify call; older days keep whatever they got, per §4.8.
- The offscreen document cannot call `chrome.history`, so it proxies through the service worker (`HISTORY_SEARCH` / `HISTORY_GET_VISITS`); each proxy message also keeps the SW alive.

## Open questions
- §9.1 is now answerable with data: `clusterThreshold` 0.70 sits cleanly in the fixture's separation gap (within-topic cosine p5 ≈ 0.77, cross-topic p95 ≈ 0.55). `assignThreshold` 0.78 is doing its job (matched counts rise across sequential runs). Neither needed moving.
