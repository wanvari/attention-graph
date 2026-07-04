# Cognitive Trails

A local-first Chrome extension that maps browser history into auditable topic flows.

The app answers:

- What topics did my attention move through?
- How often did I switch between topics?
- What evidence supports each topic or flow label?

## Requirements

- Chrome or another Chromium browser with Manifest V3 support
- Local Ollama at `http://localhost:11434`
- Models:
  - `bge-m3:latest` for embeddings
  - `gemma3:12b-32k` for topic and transition labels

Install the models with:

```bash
ollama pull bge-m3
ollama pull gemma3:12b-32k
```

The extension includes a local-only Chrome network rule that rewrites requests to `localhost:11434` so Ollama sees a normal localhost origin. No hosted API calls are made.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable Developer mode
3. Click Load unpacked
4. Select this repository folder
5. Click the extension icon

## What Changed

This version replaces the old heuristic dashboard with a trust-audit workflow:

- Expands Chrome history with `chrome.history.getVisits` so repeated visits are preserved.
- Estimates dwell time from time until next visit, capped at 30 minutes.
- Uses local Ollama only. No hosted API calls are made.
- Builds topic clusters with `bge-m3` embeddings and labels them with `gemma3:12b-32k`.
- Categorizes the highest-attention pages by default and reports how much estimated active time and how many visits those topics cover.
- Shows topic and transition confidence, rationale, and representative visit evidence.
- Stores analysis cache and user corrections in IndexedDB.

## Views

- `popup.html`: topic-sector map with top flow controls and an evidence panel.
- `analysis.html`: trust audit dashboard with data coverage, topic time share, switch burden, focused runs, and validation queue.
- `test.html`: static demo page for smoke testing outside the Chrome extension context.

## Development Checks

```bash
node tests/attentionAnalysis.test.js
node tools/auditHistory.js --days=7 --max-results=2000
node tools/auditHistory.js --days=7 --max-results=2000 --with-ollama --max-pages=420
```

The test suite covers visit expansion, same-domain false positives, Ollama JSON parsing, evidence generation, and validation queue behavior.
