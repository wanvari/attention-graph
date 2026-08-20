# CLAUDE.md

This repository is a Manifest V3 Chrome extension. There is no build system; development is vanilla JavaScript, HTML, CSS, D3, Chrome History APIs, IndexedDB, and local Ollama.

## Development Commands

```bash
npm test
node tools/auditHistory.js --days=7 --max-results=2000
node tools/auditHistory.js --days=7 --max-results=2000 --with-ollama --max-pages=420
```

Load the extension through `chrome://extensions/` with Developer mode enabled.

## Current Architecture

- `attentionAnalysis.js` is the shared data and trust layer. It expands `chrome.history.search` results with `chrome.history.getVisits` (concurrently), estimates dwell time, calls local Ollama, clusters pages into topics, adjudicates uncertain clusters, builds topic transitions, caches analyses, and stores user corrections and settings.
- Analyses run once and persist: `runAnalysis` serves the stored latest analysis from IndexedDB unless `forceRefresh` is set (the Re-run analysis button). Opening the map or dashboard never triggers Ollama work by itself; `checkForNewHistory` makes one cheap `history.search` call to show a staleness banner when new browsing happened since the stored analysis.
- Uncertainty is resolved by the machine, not the user: `adjudicateUncertainTopics` re-checks the lowest-confidence topics twice (self-consistency; page order reversed on the second pass) with verdicts keep/split/uncategorized, and `verifyBorderlineTransitions` double-checks borderline flow labels. Disagreement between passes always lands in the uncategorized bucket or falls back to the similarity heuristic — never in a user-facing review queue.
- Compute is capped for average hardware: at most `maxTopicAdjudications` (4) topics × 2 chat calls plus 1 transition-verification call per re-run, all sequential.
- Per-page embeddings are cached in the IndexedDB `embeddings` store keyed by `model|hash(pageText)`, so re-runs only embed pages that are new or changed; rows unused for 45 days are pruned after each run.
- `popup.js` renders the topic-sector map. Topic nodes are first-class; selecting a topic or flow opens the evidence panel, which is also where corrections happen in context. Topic-label corrections store a `pageUrls` snapshot so `applyCorrections` can re-attach them by page overlap after a re-run changes topic ids.
- `analysis.js` renders the trust audit dashboard: coverage, topic time share, switch burden (with a context-switches-by-hour chart), focused runs, and the uncategorized bucket.
- `options.html`/`options.js` edit the persisted settings (`days`, `maxPagesForAi`, model names) stored in the IndexedDB `settings` store; only keys in `EDITABLE_SETTINGS` persist.
- `background.js` opens `popup.html` in a full browser tab.

## Product Constraints

- Local-only AI: use `bge-m3:latest` through `/api/embed` and `gemma3:12b` through `/api/chat` at `http://localhost:11434` (models are user-configurable in settings; the endpoint is not).
- Do not silently fall back to old heuristic semantic claims for real browser history. If Ollama is unavailable, show setup guidance.
- If Ollama returns `403 Forbidden` only from Chrome, check `rules_ollama.json` and the `declarativeNetRequest` permission. The extension rewrites only local Ollama request origins so Ollama sees `http://localhost` / `http://127.0.0.1`.
- Dwell time is estimated from history gaps and capped at 30 minutes; session-ending visits get a 1-minute allowance instead of the away gap, so the last page of a session never earns phantom attention.
- Never show the user a claim the analysis is unsure of: uncertain topics are adjudicated locally, and irreducibly ambiguous pages are excluded and reported as uncategorized coverage. There is no manual validation queue.
- The topic map defaults to the highest-attention pages and must report categorized visit/time coverage instead of implying every expanded visit has a semantic topic.
- Every visible topic or transition claim should expose evidence: pages, domains, representative visits, confidence, and rationale.
- User corrections are persisted in IndexedDB and reapplied to cached analyses (topics re-attach across re-runs via page-URL overlap).
- Stay light on compute: adjudication and verification passes are capped and sequential; never add unbounded or parallel LLM work to a re-run.

## Testing Notes

The synthetic tests intentionally protect against the old failure modes:

- Repeated visits must remain separate visit events.
- Session-ending visits must not inherit the away-from-browser gap as dwell.
- Same-domain pages are not automatically related.
- Gemma JSON wrapped in Markdown code fences must parse.
- Adjudication: agreed keep/split verdicts apply; agreed uncategorized and pass disagreement move pages to the uncategorized bucket; LLM errors keep the topic; the per-run compute cap holds.
- Transition verification: agreement boosts confidence, disagreement falls back to the similarity heuristic marked uncertain.
- Corrections refresh derived metrics and re-attach to renamed topic ids by page overlap.
