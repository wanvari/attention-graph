# Phase 5 Notes — Surfaces

## Done
- `ui/newtab.*`: the Whoop-style home. Three rings (Spread / Continuity / Active) in one neutral hue, each captioned with its z-band; a "within your range" card listing all five baselined metrics with today's value, the user's usual value, and the band, expanding on click into a static 28-day D3-free SVG sparkline; the daily brief; today's focused runs; footer links and a pause toggle. Renders from IndexedDB with **4 store reads**, no Ollama, no pipeline work.
- Empty / first-run state gives the three-step Ollama setup. When today has no run yet, the most recent analyzed day is shown with an explicit "today has not been analyzed yet" stamp **plus** live unanalyzed counts computed cheaply from today's captures.
- `ui/audit.*`: coverage and honesty (categorized share, uncovered transitions, content-vs-title embedding share), registry stats by lifecycle with near-miss counts, uncategorized by reason, merge proposals awaiting confirmation (executing one is a user action that writes a correction and retires the absorbed topic), run history with per-stage detail, storage usage, resident models via `/api/ps`, Run now, Export JSON, Delete everything.
- `ui/map.*`: the v3 D3 rendering pointed at the registry through a new `ui/mapData.js` adapter — nodes are non-retired topics with dwell in a selectable 7/30/90-day window, edges are aggregated `transitions` rows. Corrections write directly to the registry because topic ids are stable now; the v3 page-overlap re-attachment is gone.
- `ui/options.*`: pause, denylist editor, LLM-chat domain list, first-run window, per-run page budget, idle-gating toggle (with an explicit warning when disabled), notifications toggle, model names. Only allowlisted keys persist.
- `lib/brief.js` with the §5.3 priority order and copy rules.

## Tests
- `tests/copy.test.js` sweeps every user-facing string in `lib/brief.js` and `ui/*.{js,html}` for the forbidden-word list and for displayed confidence percentages, and re-checks the brief generator's own output over a stress input covering every item kind.
- `tests/ui.test.js` parses every colour literal in `ui/*.css` (and the map's JS palettes) and fails the build on any hue in the red band [340,20] or green band [90,150] above 20% saturation; renders the newtab in jsdom + fake-indexeddb for the empty, populated, and stale-day states; and asserts the ≤ 4 IndexedDB transaction budget.

## Fixes these tests forced
- The inherited v3 `map.css` carried exactly the green/red valence D4 forbids (health pill states, setup box, dead category swatches). All replaced with the neutral palette; the dead v3 category swatches deleted.
- The map's health state `'bad'` renamed to `'unavailable'` — the word was a CSS class, but a valence word in the code is the seed of a valence word in the UI.
- `confidenceBar` displayed a percentage. It now renders a bar with a coarse word (limited / moderate / strong) and no number: the heuristic score ranks clusters for the audit gate and is not a probability the record can honestly display.
- v4 transition rows carry no per-transition gap data, so the evidence panel now shows days observed and an hour-of-day histogram instead of a fabricated "average gap".
