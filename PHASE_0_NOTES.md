# Phase 0 Notes — Hygiene

## Done
- New `v4` branch (main keeps the released v3).
- File moves per spec §1.1: `popup.*` → `ui/map.*` (`popup.css` → `ui/map.css`), `analysis.*` → `ui/audit.*`, `options.*` → `ui/`, `d3.min.js` → `vendor/`. All script/link/href paths adjusted; extension still loads; `background.js` opens `ui/map.html`.
- Deleted `AGENTS.md` and `test.html`. `DEBUGGING.md` stubbed (full rewrite in Phase 6). `CLAUDE.md` rewritten for v4.
- `npm test` now runs `tools/runTests.js`, which executes every `tests/**/*.test.js` (excluding `tests/e2e/`) in its own Node process. v3 suite (`tests/attentionAnalysis.test.js`) still green.
- Added dev deps: `fake-indexeddb` (store tests in Node), `jsdom` (newtab render test, §7.6).

## Decisions / deviations
- `attentionAnalysis.js` stays at the repo root during the build; its logic dissolves into `lib/*` over Phases 1–3 and the file (plus its v3 test file) is deleted once every behavior it covers is owned by a lib module with its own tests.
- Added `jsdom` beyond the spec's `fake-indexeddb` because §7.6 requires an empty-DB newtab render test in Node.
- The v3 test file was left at `tests/` root rather than `tests/unit/` since it is temporary.

## Open questions
- None.
