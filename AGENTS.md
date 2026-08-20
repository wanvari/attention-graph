# AGENTS.md

This repository is a Manifest V3 Chrome extension. There is no build system; development is vanilla JavaScript, HTML, CSS, D3, Chrome History APIs, IndexedDB, and local Ollama.

## Development Commands

```bash
node tests/attentionAnalysis.test.js
node tools/auditHistory.js --days=7 --max-results=2000
node tools/auditHistory.js --days=7 --max-results=2000 --with-ollama --max-pages=420
```

Load the extension through `chrome://extensions/` with Developer mode enabled.

## Current Architecture

- `attentionAnalysis.js` is the shared data and trust layer. It expands `chrome.history.search` results with `chrome.history.getVisits`, estimates dwell time, calls local Ollama, clusters pages into topics, builds topic transitions, caches analyses, and stores user corrections.
- `popup.js` renders the topic-sector map. Topic nodes are first-class; top cross-topic flows are filtered by the Top 25 / Top 50 / All control; selecting a topic or flow opens the evidence panel.
- `analysis.js` renders the trust audit dashboard. It shows coverage, topic time share, switch burden (with a by-hour chart), focused runs, and the uncategorized bucket. There is no manual validation queue; uncertain claims are adjudicated locally or excluded.
- `background.js` opens `popup.html` in a full browser tab.

## Product Constraints

- Local-only AI: use `bge-m3:latest` through `/api/embed` and `gemma3:12b` through `/api/chat` at `http://localhost:11434`.
- Do not silently fall back to old heuristic semantic claims for real browser history. If Ollama is unavailable, show setup guidance.
- If Ollama returns `403 Forbidden` only from Chrome, check `rules_ollama.json` and the `declarativeNetRequest` permission. The extension rewrites only local Ollama request origins so Ollama sees `http://localhost` / `http://127.0.0.1`.
- Dwell time is always estimated from history gaps and capped at 30 minutes; visits that end a session count 1 minute instead of the away gap.
- The topic map defaults to the highest-attention pages and must report categorized visit/time coverage instead of implying every expanded visit has a semantic topic.
- Every visible topic or transition claim should expose evidence: pages, domains, representative visits, confidence, and rationale.
- User corrections are persisted in IndexedDB and reapplied to cached analyses.

## Testing Notes

The synthetic tests intentionally protect against the old failure modes:

- Repeated visits must remain separate visit events.
- Same-domain pages are not automatically related.
- Gemma JSON wrapped in Markdown code fences must parse.
- Topics and transitions must expose evidence and low-confidence review items.
