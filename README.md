# Cognitive Trails

A local Chrome extension for finding the pages you visited and returning to the subjects you were exploring. It records eligible browsing passively, groups pages into suggested trails, and lets you pin a trail, give it a name, or leave a note about where to continue.

**This is a browsing record. It does not measure cognition, attention, learning, productivity, or mental health.** A suggested topic describes page content; it does not establish your intentions or the relationship between ideas.

## Use it

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this directory. Open a new tab. Eligible page captures become searchable without a model.
2. For suggested topics, install [Ollama](https://ollama.com/download), start it, and run:
   ```sh
   ollama pull bge-m3
   ollama pull qwen3:4b
   ```
3. Open Cognitive Trails **Settings**, check the connection, and select **Group pages now** for the initial import. By default this imports up to 28 days of eligible Chrome history. Older visits generally have titles and URLs only; installing the extension cannot recover their page text.
4. Browse normally. The scheduler checks hourly and groups pages while the computer is idle. **Pause capture** stops new capture and excludes the pause interval from future history imports. Search and existing trails remain available.

Search matches titles, website names, suggested topics, personal notes, and date text. Date filters and **All pages** include pages without a topic. Open a trail for its dated sessions and original links. Pin, name, and note controls are optional; personal metadata never overwrites inferred labels. The map is a secondary view of suggested groups and consecutive visits.

**Try the recorded sample:** `npm run demo`, then open `http://localhost:8912/ui/demo.html`. It uses the same interface with a committed synthetic record produced by the current local models. It requires neither Ollama nor an extension installation and makes no persistent changes.

## Useful measurements

| Measure | What it actually counts |
| --- | --- |
| Recorded visits | Separate recorded page openings, with capture/history duplicates reconciled. |
| Distinct pages | Sanitized page identities. Content query parameters are preserved; different video IDs stay separate. |
| Websites | Distinct hostnames, not companies or ideas. |
| Days returned | Local calendar dates after the first recorded visit to a trail. |
| Sessions | Visits within a trail separated by less than 30 minutes, on the same date. |
| Estimated browsing time | History gaps capped at 30 minutes and a one-minute allowance at session ends. Available interaction measurements can lower the estimate. Overlapping intervals are counted once on Home. |
| Coverage | Grouped visits and visits with interaction measurements, each alongside the recorded-visit denominator. |

Time is approximate. Visible, focused pages with recent input are observable; silent reading, other apps, other devices, private browsing, excluded pages, and capture gaps are not. Topic membership can be wrong. Model self-ratings are not calibrated probabilities and are not shown as confidence percentages. The former entropy rings and personal deviation judgments are removed from Home and notifications. Legacy derived fields remain in the database/export for compatibility.

## Laptop profile

The default is `bge-m3:latest` for embeddings and `qwen3:4b` for short structured labels. Downloads total roughly 3.7 GB. The [current validation report](validation/report-2026-09-05.md) records measured performance on an **M3 Pro with 18 GiB RAM**, including model residency, stage times, backlog completion, and fixture quality.

- 100 pending pages and at most 12 new topics per run; configurable page budget is bounded at 200.
- Embeddings use batches of 8. Labeling uses at most two batches of 6 with four short page excerpts per topic.
- Chat uses 8,192 context tokens, at most 1,800 output tokens, and thinking disabled. Ambiguous clusters can receive at most eight additional checks.
- Calls are sequential. The embedding model unloads before labeling. Both models unload on exit, with a two-minute residency fallback.
- Default 50% pacing inserts rest after model calls. This limits sustained work, **not instantaneous GPU utilization**. CPU threads are capped at four by default.
- Automatic work requires two minutes of system idle. The worker rechecks before each model call and defers remaining work when the user returns, capture is paused, or the three-minute work window expires. An in-flight call and its rest can finish after that boundary.
- Completed embedding batches survive interruption. Classification remains pending until the registry transaction commits. Later passes drain the backlog even after the import watermark advances.

These are bounded workloads and one measured laptop, not proof of smooth operation on every modern laptop. Smaller-memory and non-Apple machines still need testing. Without Ollama, local capture and title-based retrieval continue to work.

## Development and verification

Vanilla JavaScript, Manifest V3, IndexedDB, and D3. No bundler or hosted backend.

```sh
npm install
npm test                 # unit, protocol, migration, copy and DOM tests; no models
npm run e2e              # Chrome capture/privacy tests; disposable profile
npm run e2e:trails       # actual UI -> worker -> persistence and reload
npm run e2e:pipeline     # Chrome offscreen lifecycle + live Ollama
npm run check:laptop     # cold vector cache, synthetic month, current live models
npm run package          # installable unpacked folder and zip in dist/
```

The live check writes complete chat transcripts, vectors, a metadata-only sample, and measurements. `tests/protocol/current.test.js` replays those exact current requests without models; a changed prompt fails instead of silently substituting a response. Archived 12b fixtures are retained as historical evidence only. The older `validate`/`bench` tools retain their legacy configuration and do not validate the new runtime profile.

See [ARCHITECTURE.md](ARCHITECTURE.md) for failure recovery and storage contracts, and [PRIVACY.md](PRIVACY.md) for data handling. This build is suitable for a local pilot. Multi-device synchronization, a published store release, semantic search over full page text, and independent human evaluation are not implemented.
