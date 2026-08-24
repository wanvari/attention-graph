# CLAUDE.md

This repository is **Cognitive Trails v4**: a Manifest V3 Chrome extension that keeps a passive, longitudinal, local-only record of where browsing attention went, surfaced on the new-tab page. There is no build system; development is vanilla JavaScript, HTML, CSS, D3, Chrome extension APIs, IndexedDB, and local Ollama. The authoritative build spec lives in the repo history; this file describes the current architecture and the rules that must not regress.

## Development Commands

```bash
npm test                      # unit + protocol + copy + ui tests (Node, no Ollama, no Chrome)
node tools/validate.js        # accuracy/consistency validation on fixtures (needs live Ollama)
node tools/bench.js           # per-stage timing budget (needs live Ollama)
node tools/embedFixtures.js   # regenerate fixtures/embeddings.bin (needs live Ollama)
node tools/recordGolden.js    # re-record fixtures/golden/ chat transcripts (needs live Ollama)
```

Load the extension through `chrome://extensions/` with Developer mode enabled. Playwright e2e suites live in `tests/e2e/` and run manually on the development machine.

## Architecture (v4)

- **Sensor:** `content/capture.js` runs on every http(s) page, measures active time (visible + focused + input in last 60 s), extracts ≤ 8,000 chars of main-content text, and streams idempotent capture upserts to `background.js`. Denylisted domains/paths and paused intervals capture nothing.
- **Service worker:** `background.js` only routes messages, buffers captures, manages `chrome.alarms` (`daily` hourly gate, `flush` every 2 min), and spins up the offscreen document. It never runs the pipeline.
- **Pipeline:** `offscreen/analysis.js` hosts `lib/pipeline.js`, which orchestrates staged, transactional runs: ingest → embed → cluster → label → adjudicate → registry → transitions → metrics. Failed runs never move the watermark and never partially write `topics`.
- **Registry:** `lib/registry.js` maintains persistent topic identity across runs (`topicId` stable forever), with lifecycle states active/dormant/retired and events (created, dormant, revived, merged-proposal, retired, relabeled). Every metric is computed over the registry, not per-run snapshots.
- **Storage:** `lib/store.js` wraps IndexedDB `cognitive-trails` v4 (visits, captures, pages, embeddings, topics, memberships, topic_events, daily_metrics, baselines, runs, briefs, transitions, uncategorized, corrections, settings). Loadable in Node with fake-indexeddb.
- **Surfaces:** `ui/newtab.html` (default new tab; rings + baseline card + daily brief + focused runs; renders < 100 ms from IndexedDB, never triggers Ollama), `ui/map.html` (topic-sector map over the registry), `ui/audit.html` (trust audit: runs, coverage, registry stats, uncategorized by reason, Run now, export, delete), `ui/options.html` (settings incl. denylist, pause, LLM-chat domains).
- Every `lib/*.js` module uses the UMD wrapper pattern so it loads in the extension and in Node tests. No bundler.

## Product Constraints (do not regress)

- **Local-only.** Models: `bge-m3:latest` via `/api/embed`, `gemma3:12b` via `/api/chat`, endpoint fixed at `http://localhost:11434`. The manifest CSP `connect-src` allows only self + localhost:11434 / 127.0.0.1:11434. Any change adding a remote host is wrong.
- **No normative scores.** Every displayed number is descriptive or a deviation from the user's own 28-day baseline (z-band: "within your range" / "outside usual" / "unusual"). No green/red valence, no "focus score", no good/bad copy — enforced by `tests/copy.test.js` and the CSS hue test.
- **No goal inference, no synthesis.** The system reports dormancy/revival/convergence facts; it never interprets, recommends, or claims topic X relates to topic Y.
- **Uncertainty defaults to exclusion.** Self-consistency adjudication (two passes, order reversed, split-grouping Jaccard ≥ 0.60) decides keep/split/uncategorized; disagreement always lands pages in the uncategorized bucket with a reason. There is no manual review queue.
- **Order-invariant clustering.** Average-linkage agglomerative over cosine distance; assignment to existing registry centroids first (threshold 0.78), remainder clustered at 0.70. Shuffling input must not change partitions.
- **Compute caps.** Per run: ≤ 300 embeds, ≤ 2 label calls, ≤ 8 adjudication calls, ≤ 2 transition calls, all sequential. Embed model `keep_alive: '5m'` and unloaded before chat calls; both models never resident longer than needed. Idle-gated scheduling.
- **Privacy.** Content capture never reads form fields; denylist covers banks/health/auth/mail plus sensitive paths; `extractedText` is deleted after 30 days; export contains no page text; delete-everything wipes IndexedDB and `chrome.storage.local`.
- **Dwell honesty.** Gap-based dwell capped at 30 min; session-ending visits get a 1-minute allowance; capture-measured active time upgrades dwell via `min(activeMs, gap dwell)` and can only lower it.
- **Coverage honesty.** Categorized share, uncovered transitions, and the uncategorized bucket (by reason) are always shown next to the claims they qualify.

## Testing Notes

`npm test` runs everything under `tests/` except `tests/e2e/`. Key invariants the suites protect: repeated visits stay separate events; session-ending visits never inherit away-gaps; same-domain pages are not automatically related; fenced JSON parses; adjudication agreement/disagreement/error semantics and the per-run cap; split-grouping Jaccard boundaries; registry match-score boundaries and lifecycle day-exact transitions; entropy/baseline/z-score math; brief priority order and forbidden-word list; migration from v3 preserves embeddings and drops the old snapshot analysis; watermark never moves on failed runs.
