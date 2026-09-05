# Cognitive Trails v4

A Chrome extension that keeps a **passive, longitudinal, local-only record of where your browsing attention went**, and surfaces it on your new-tab page.

It is a record-keeper, not a coach. It will tell you that a topic went quiet for eighteen days and then came back, or that today's spread of attention was unusual *for you*. It will never tell you that was good, bad, productive, or distracting — and it is built so that it *cannot*, because those words fail a test in CI.

Everything runs on your machine. The only network destination the extension is permitted to reach is `http://localhost:11434`, where your own Ollama serves the models.

---

## What it measures

| It reports | Definition |
|---|---|
| **Spread** | Shannon entropy over the day's topic dwell shares, in bits. Descriptive; no direction is implied. |
| **Continuity** | Share of consecutive-visit transitions that stayed inside one topic or moved to a near-neighbour topic. |
| **Active time** | Estimated attention, from history gaps (capped at 30 min, session-enders get 1 min), *lowered* — never raised — by measured in-page active time. |
| **Topics touched**, **switch rate** | Counts and rates over the day's categorized visits. |
| **Dormancy / revival** | A topic with no activity for 14 days goes dormant; a new page brings it back, and the record notes how long it was gone. |
| **Convergence** | A topic that appeared in *both* ordinary browsing and LLM chat conversations within the trailing 7 days. |

Each daily number is shown next to a **deviation from your own 28-day baseline** — "within your range", "outside usual", "unusual for you" — and only once at least 14 comparable days exist. There is no cross-user comparison, no target, and no score.

## What it refuses to infer

These are design commitments, not omissions:

- **No normative scores.** No green/red, no "focus score", no good/bad. Enforced by `tests/copy.test.js` (a forbidden-word sweep over every user-facing string) and `tests/ui.test.js` (a hue check that fails the build if any stylesheet uses a saturated red or green).
- **No goal inference.** The system reports that a topic went dormant. What that means is yours to decide.
- **No synthesis.** It may report that a topic appeared in two sources. It will never claim that topic X *relates to* topic Y beyond the observed same/adjacent/switch classification of consecutive visits.
- **No forced classification.** Pages the analysis cannot honestly label are excluded and counted in an uncategorized bucket *with the reason*, rather than being pushed into the nearest topic. Coverage is always displayed next to the claims it qualifies.
- **No review queue.** Uncertainty is resolved by spending local compute, not your attention (see below).

## How uncertainty is handled

A topic cluster whose internal cohesion falls below the bar we require to merge two pages in the first place is *audited*: the same question is put to the local model twice, with the page order reversed the second time. Only agreement counts.

- Both passes say **keep** → the topic stands.
- Both say **uncategorized** → every page is excluded, reason `agreed_uncategorized`.
- Both say **split** → the two groupings are compared as sets of co-membership pairs (Jaccard ≥ 0.60). Agreement applies the split; pages the passes placed differently are excluded as `split_leftover`.
- Anything else — differing verdicts, unparseable output, incompatible groupings → excluded as `disagreement`.

A model or network failure is *not* evidence of a bad cluster: the topic is kept and the error is counted. The whole audit is capped at 4 topics × 2 sequential calls per run.

## Validation

`node tools/validate.js` runs the pipeline over a committed 384-page / 28-day synthetic fixture with live Ollama, N times, and writes a dated report to `validation/`. It separates two things the previous version conflated:

- **Accuracy** — Adjusted Rand Index and pairwise precision/recall against ground-truth topics.
- **Consistency** — pairwise ARI *between runs*, which is what tells you whether the thing is stable rather than merely plausible-looking once.

It also reports exclusion honesty (of the pages excluded, how many were genuinely ambiguous or junk) and replays the 28 fixture days as 28 sequential runs to assert that topic identity, dormancy, revival, convergence, and the data-gap report all behave.

The committed report in `validation/` carries the current numbers. **Any claim in this README about accuracy is only as good as that file** — if they disagree, the file is right.

## Try it without installing anything

```bash
node tools/serveDemo.js
```

Then open `http://localhost:8912/ui/demo.html`. This replays a real recorded `gemma3:12b` run over the fixture — the home screen, the trust audit, every topic with its evidence pages, the exclusion bucket by reason, the adjudication protocol on real model output, and the validation report. It needs no Ollama and no Chrome extension install.

## Install

1. **Ollama**, running locally:
   ```bash
   ollama serve
   ollama pull bge-m3
   ollama pull gemma3:12b
   ```
   Roughly 11 GB resident when both are loaded; the pipeline unloads the embedding model before chat work so they overlap only briefly.

   On Apple silicon these models run entirely on the GPU, which has no
   utilisation cap. If you want the machine to stay cool, Settings →
   **Local model intensity** rests between model calls instead: at 75% the
   GPU works three seconds for every one it idles. The run takes
   proportionally longer, which costs nothing when it happens while you are
   away.
2. **The extension**: open `chrome://extensions/`, enable Developer mode, choose *Load unpacked*, and select this directory.
3. Chrome will warn that the extension can read data on all sites. It can — that is how the content sensor works. Nothing leaves your machine; see `PRIVACY.md`.
4. Browse normally. The first analysis runs on its own when the machine is idle (or between 02:00 and 05:00). To run it immediately, open the extension's **Audit** page and press **Run now**.

Upgrading from v3: your cached embeddings and corrections are migrated. The v3 snapshot analysis is deliberately *not* imported — its topics had no stable identity, and seeding the registry with them would fabricate history. The registry starts fresh.

## Architecture

```
content/capture.js  ──►  background.js  ──►  offscreen/analysis.js  ──►  Ollama
   (per-tab sensor)      (SW: alarms,          (the pipeline; outlives     (localhost
                          buffering,            the service worker)         :11434)
                          scheduling)                   │
                                                        ▼
                                          IndexedDB `cognitive-trails`
                                                        │
                        ┌───────────────┬───────────────┼───────────────┐
                        ▼               ▼               ▼               ▼
                   ui/newtab.html   ui/map.html   ui/audit.html   ui/options.html
```

The service worker never runs analysis — Chrome kills it after ~30 s idle. Work happens in an offscreen document that survives service-worker termination, writes a heartbeat, and closes itself when done. A run that fails leaves the watermark untouched, so the next run redoes exactly the work that was lost and nothing else.

The **topic registry** is the core primitive: topics have stable ids across runs, so dormancy, revival, entropy trends and baselines are all computed over one continuous record rather than over disconnected snapshots.

### Layout

| Path | What it is |
|---|---|
| `lib/` | Everything testable: store, history, cluster, ollama, label, adjudicate, registry, metrics, brief, pipeline, text, privacy. Each loads in both the extension and Node. |
| `content/capture.js` | The sensor: active-time, scroll depth, main-content extraction. |
| `offscreen/` | The pipeline host. |
| `ui/` | newtab (home), map, audit, options, demo. |
| `fixtures/` | 384 synthetic pages, 28 days of designed visits, real committed bge-m3 vectors, and recorded model transcripts. |
| `tests/` | `unit/`, `protocol/` (full pipeline with a scripted model), `copy`, `ui`, and `e2e/` (Playwright, real Chrome). |
| `tools/` | Fixture generation, golden recording, validation, benchmarking, demo server. |

## Development

```bash
npm test                      # unit + protocol + copy + ui  (no Ollama, no Chrome)
npm run e2e                   # Playwright capture suite (real Chrome, local only)
node tests/e2e/pipeline.e2e.mjs   # scheduling/lifetime suite (needs Ollama)
node tools/validate.js        # accuracy + consistency report (needs Ollama)
node tools/bench.js           # per-stage timing budget (needs Ollama)
```

There is no build step. `npm test` runs every `tests/**/*.test.js` in its own process.

## Known limitations

- **Video pages undercount.** Active time requires an input event within 60 s, so watching a long video without touching anything reads as inactive. Not special-cased: doing so would require a judgement about what watching means.
- **Scroll depth is captured but never scored.** Turning it into an "engagement" number would require a claim about what scrolling means.
- **Dwell is an estimate**, and is labelled as one everywhere it appears.
- **Chrome-only, one profile, one device.** No sync.
- **The uncategorized bucket is not empty, by design.** Its size is the honest cost of not guessing.
- **The bookmarks bar hides on the new tab.** Chrome only auto-reveals it on its own built-in new tab page; any extension that overrides the new tab loses that behaviour, and no extension API restores it. Turn on **Always show bookmarks bar** (`Cmd/Ctrl+Shift+B`) to keep it visible everywhere.
- **Chrome shows a "your new tab page was changed" notice.** That bar comes from Chrome's extension-controlled-settings warning, not from this extension, and cannot be dismissed programmatically.
- **The new tab's search box routes through your default engine.** It calls `chrome.search.query`, so Chrome picks the engine you already configured; the query is never read, stored, or added to the record.
