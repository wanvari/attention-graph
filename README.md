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
  - `gemma3:12b` for topic and transition labels (the stock tag; the extension requests a 16K context per call, so no custom Modelfile is needed)

Install the models with:

```bash
ollama pull bge-m3
ollama pull gemma3:12b
```

The extension includes a local-only Chrome network rule that rewrites requests to `localhost:11434` so Ollama sees a normal localhost origin. No hosted API calls are made.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable Developer mode
3. Click Load unpacked
4. Select this repository folder
5. Click the extension icon

## How It Works

- Expands Chrome history with `chrome.history.getVisits` so repeated visits are preserved.
- Estimates dwell time from time until next visit, capped at 30 minutes; visits that end a session count 1 minute instead of inheriting the away-from-browser gap.
- Uses local Ollama only. No hosted API calls are made.
- Builds topic clusters with `bge-m3` embeddings and labels them with `gemma3:12b`.
- Runs a capped second adjudication pass over the lowest-confidence topics: each is re-checked twice (page order reversed the second time) and the verdict only counts when both runs agree. Confirmed topics stay, mixed ones are split, and anything the model cannot label honestly moves to an explicit **Uncategorized** bucket instead of being forced into a topic or handed to the user to sort.
- Verifies borderline transition labels with one extra pass; disagreement falls back to the similarity heuristic, marked uncertain.
- Reports coverage honestly: topic metrics only count pages the analysis stands behind, and uncategorized time/visits are shown, not hidden.
- Serves the stored analysis until you re-run, and shows a banner when new browsing has happened since it was generated.
- Stores analysis cache, embeddings (pruned after 45 days unused), settings, and user corrections in IndexedDB. Topic-label corrections re-attach across re-runs by page overlap.

## Views

- `popup.html`: topic-sector map with top flow controls and an evidence panel. Corrections are made in context here (rename a topic, reclassify a flow).
- `analysis.html`: trust audit dashboard with data coverage, topic time share, switch burden (including context switches by hour of day), focused runs, and the uncategorized bucket.
- `options.html`: settings for history window, page budget, and local model names.
- `test.html`: static demo page for smoke testing outside the Chrome extension context.

## Development Checks

```bash
npm test
node tools/auditHistory.js --days=7 --max-results=2000
node tools/auditHistory.js --days=7 --max-results=2000 --with-ollama --max-pages=420
```

The test suite covers visit expansion, dwell estimation at session breaks, same-domain false positives, Ollama JSON parsing, adjudication verdicts (keep/split/uncategorized/disagreement/error), transition verification, staleness detection, correction re-attachment, and cache behavior.
