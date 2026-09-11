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

**Try the recorded sample:** `npm run demo`, then open `http://localhost:8912/ui/demo.html`. It uses the same interface with a committed synthetic record produced by the current local models. It requires neither Ollama nor an extension installation and makes no changes to browsing records. Only the display theme is remembered.

## Today and optional sessions

Studio opens in dark mode, with a saved Light/Dark switch shared across Home, Graph, Explore, Settings and record inspection. Home puts continuation and search first, with compact evidence cards and a seven-day preview.

**Explore** shows 7 or 14 days of stacked activity. Switch between estimated time and recorded visit starts, move to an earlier period, or select a day to inspect its trail totals and source pages. Other trails and ungrouped pages remain in every total. Day boundaries use the local time zone; a page crossing midnight contributes time on both days but starts only once.

**Graph** retains the full topic/page view, including ungrouped pages. Search a trail or page, select a node or connection for evidence, and use **Zoom to this trail** to inspect a neighborhood. Dragging a trail moves its attached pages. Pages and labels can be toggled; Fit returns to the whole graph. Colors identify trails consistently across the workspace.

Home shows estimated recorded time and three compact literal rings. Select any ring to see its formula, counts, contributing pages, timing coverage and comparison details. The continuation card opens your last page or starts an optional session in a selected trail.

| Ring | Calculation | How to use it |
| --- | --- | --- |
| Continuity | Same-trail transitions ÷ classified within-session transitions | Inspect where the recorded sequence stayed within a trail or changed trails. |
| Top trail | Largest trail's estimated minutes ÷ grouped estimated minutes | Identify the subject with the most grouped time and return to its pages. |
| Return share | Grouped minutes in trails first seen before today ÷ grouped minutes | Find earlier trails that you revisited. |

Comparisons use the preceding 28 local calendar days, each through the same clock time as today. The middle 50% (Tukey quartiles) and median require at least seven eligible days. Continuity requires three classified transitions; time shares require ten grouped minutes. Below (ochre), within (blue) and above (plum) are directions relative to your own record, with no preferred direction. Gray means insufficient evidence. Reloads, repeated URLs, simultaneous timestamps, capture pauses, day boundaries, gaps over 30 minutes and ungrouped endpoints do not enter the Continuity denominator.

Sessions are optional: 25, 50 or 90 minutes, or untimed, plus a private next-step note. One session can run at a time. Timed sessions survive a closed tab or worker restart; a generic browser notification opens the recap. The recap shows selected-trail, other-trail and ungrouped estimated time alongside elapsed wall time. Pausing capture ends the session. Corrections can update its grouping later. No session action loads a model.

## Useful measurements

| Measure | What it actually counts |
| --- | --- |
| Recorded visits | Separate recorded page openings, with capture/history duplicates reconciled. |
| Distinct pages | Sanitized page identities. Content query parameters are preserved; different video IDs stay separate. |
| Websites | Distinct hostnames, not companies or ideas. |
| Days returned | Local calendar dates after the first recorded visit to a trail. |
| Recorded episodes | Visits within a trail separated by less than 30 minutes, on the same date. These differ from sessions you explicitly start. |
| Estimated browsing time | Timestamped activity where available; older interaction totals have estimated placement. Otherwise history gaps are capped at 30 minutes, with a one-minute session-end allowance. Unmeasured status-page gaps remain unknown and contribute no time. Overlaps count once across Home, Map, Audit and recaps. |
| Coverage | Grouped visits and visits with interaction measurements, each alongside the recorded-visit denominator. |

Time is approximate. Visible, focused pages with recent input are observable; silent reading, other apps, other devices, private browsing, excluded pages, and capture gaps are not. Topic membership can be wrong. Model self-ratings are not calibrated probabilities and are not shown as confidence percentages. There is no composite score or inferred cognitive state. Legacy derived fields remain in the database/export for compatibility.

## Correct an unexpected result

Select **Inspect page & grouping** on a recorded visit. It separates that visit's estimated time, all visits to the page, and the entire trail's time across recorded dates. Move the page to another trail or keep it ungrouped; your choice survives automatic analysis. A trail with no current pages remains available for reassignment.

**Record & privacy → Inspect a page** compares stored totals with the current evidence calculation without changing the database, including legacy schema-4 records. **Recalculate evidence** rebuilds derived time and memberships while preserving raw history and personal corrections. Repeated status-page navigations can be background refreshes, so repetition alone cannot qualify them for grouping. Map lines require at least two recorded sequences in the selected period; a single sequence remains available in the timeline.

Version 5.1 upgrades the database to schema 5. Reload the extension in `chrome://extensions` after updating; older open extension pages can block migration. Reopen Home after reloading. The release uses the existing permissions.

## Laptop profile

The default is `bge-m3:latest` for embeddings and `qwen3:4b` for short structured labels. Downloads total roughly 3.7 GB. The [current validation report](validation/report-2026-09-10.md) records code-review findings, regression tests and measured performance on an **M3 Pro with 18 GiB RAM**, including model residency, stage times, backlog completion, and fixture quality.

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
npm run e2e:studio   # Studio themes, graph interactions, chart totals and responsive screens
npm run e2e:trails       # actual UI -> worker -> persistence and reload
npm run e2e:pipeline     # Chrome offscreen lifecycle + live Ollama
npm run check:laptop     # cold vector cache, synthetic month, current live models
npm run package          # installable unpacked folder and zip in dist/
```

The live check writes complete chat transcripts, vectors, a metadata-only sample, and measurements. `tests/protocol/current.test.js` replays those exact current requests without models; a changed prompt fails instead of silently substituting a response. Archived 12b fixtures are retained as historical evidence only. The older `validate`/`bench` tools retain their legacy configuration and do not validate the new runtime profile.

See [ARCHITECTURE.md](ARCHITECTURE.md) for failure recovery and storage contracts, and [PRIVACY.md](PRIVACY.md) for data handling. This build is suitable for a local pilot. Multi-device synchronization, a published store release, semantic search over full page text, and independent human evaluation are not implemented.
