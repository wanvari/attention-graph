# Night atlas: Cognitive Trails UI redesign

> Status: implemented on branch claude/night-atlas (September 2026). This is the approved plan, kept for reference.

## Context
The user finds the current UI weak. What they want:
1. A minimalist, aesthetic, friendly landing page that draws people in.
2. Keep the sidebar capsule.
3. Strong color contrast and better fonts.
4. Trails that are easy to sort through and interpret.
5. Bring back a large, organic but clean graph of all trails.

Choices made with the user (2026-09-14):
- **Direction:** Night atlas. Blue-black background, near-white text, saturated jewel trail colors, Fraunces headings with Inter for UI text; the lime sidebar highlight stays.
- **Home:** greeting, search, a continue card, pinned/recent trail chips, and a line with today's three ratios as literal fractions. Each fraction opens the existing evidence drawer, and scrolling down turns the fractions into the three restyled rings.
- **Graph:** a constellation where trails sharing title words or visited in sequence pull together, with soft group halos.
- **Your trails:** recency sections with sort, filters and a 14-day visit strip per row.

Why the current UI is weak:
- Legacy per-page CSS (`ui/shared.css`, `ui/newtab.css`, `ui/map.css` at 1,181 lines) is re-skinned by overrides in `ui/studio.css`: duplicate selectors, 34 `!important`s.
- Low-chroma palette, no bundled fonts.
- Graph regressed from the approved prototype (`design/mockups/studio-graph-dark.png`, `design/prototype/mockup-graph.js`) to cards that hide the canvas.

## Constraints (verified in code)
- **Copy test** (`tests/copy.test.js`) bans *should, focus, productive, distract, goal, improve, better, worse, good, bad* in UI strings. So the greeting is "Welcome back." or "Hello again.", not "Good evening".
- **Color test** (`tests/ui.test.js:54-80`) bans red hues (≥340° or ≤20°) and green hues (90–150°) above 20% saturation in `ui/*.css`. Only `studio.css` is exempt for green. `studio.css` must keep the literal `--accent: #7fee64` and `--signal-{below,within,above,neutral}: var(--ring-ink)`. So **tokens stay in `ui/studio.css`** (no new tokens file), and rings stay neutral ink.
- **Entry-point test** (`tests/unit/entrypoints.test.js`) requires every `src`/`href` to exist. Script order: `lib/trails.js` < `newtab.js`; `lib/dashboard.js` < `dashboard.js` < `newtab.js`; `lib/dashboard.js` < `mapData.js`.
- **Packaging:** `tools/package.js` copies all of `vendor/` and `ui/`, so `vendor/fonts/` ships automatically.
- **Fonts:** the extension CSP is `'self'`, so fonts must be local woff2 files. Downloading them needs the user's explicit OK at implementation time (planned source: Fraunces and Inter, OFL, e.g. `@fontsource-variable/*`; copy the woff2 and OFL license into `vendor/fonts/`).
- **Product contract (CLAUDE.md):** Home never calls a model and works before models are installed; ratios keep denominators and evidence; ungrouped pages stay reachable; writes go through worker messages; modules stay Node- and extension-loadable.
- **Test class hooks:** unit tests use `nt-*` classes (`nt-search`, `nt-search-input`, `nt-content`, `nt-layout`, `nt-ring-card`, `nt-ring-title`, `nt-ring-dial`, `nt-page-link`, `nt-trail-title`, `nt-detail-heading`, `nt-episode`, `nt-visit`, `nt-pin`, `nt-edit-form`, `nt-method`, `nt-freshness`, `nt-visit-time`). **Keep these names** where the meaning is unchanged.

## Design tokens (in `ui/studio.css`)
**Dark (default)**
| Token | Value |
|---|---|
| `--bg` | `#0B0E14` |
| `--panel` | `#131824` |
| `--panel-2` | `#1B2130` |
| `--line` | `#283044` |
| `--line-strong` | `#3A4560` |
| `--text` | `#F3F5FA` (≈18:1) |
| `--text-dim` | `#A9B2C4` (≈9:1) |
| `--text-faint` | `#7D879B` (≈5:1) |
| `--accent` | `#7fee64` (navigation and focus only) |
| Trails | violet `#9B8CFF`, cyan `#3FD0E8`, amber `#FFBE55`, pink `#FF7AC6` (326°), mint `#52DDB0` (160°), blue `#5EA6FF`, orange `#FF9E5E` (24°), citron `#E3DD6B` (58°) |

**Light**
| Token | Value |
|---|---|
| `--bg` | `#F7F8FB` |
| `--panel` | `#FFFFFF` |
| `--panel-2` | `#EEF0F5` |
| `--line` | `#D5DAE4` |
| `--text` | `#121622` |
| `--text-dim` | `#4A5367` |
| `--accent` | `#42623a` |
| Trails | `#5B4BD6`, `#0B8AA3`, `#A86A08`, `#C23F8C`, `#11876F`, `#2F6FD6`, `#C25E1E`, `#8A8216` |

**Type:** `--font-display: 'Fraunces'` (headings, trail titles, big numbers) and `--font-ui: 'Inter'` with `cv11`. Scale 12/13/15/18/24/32/44. Minimum 12px; secondary text uses `--text-dim`, never opacity.

**Shape:** radius 10 for controls, 14 for cards, pill for chips. Hairline borders, no drop shadows. Motion 200–300ms ease-out, disabled under reduced motion.

`topicIndex`/`topicColor` in `ui/studio.js` keep mapping trails onto `--trail-0..7`.

## Phases

### Phase 0: Checkpoint (needs user OK to commit)
- Commit the current uncommitted work on `codex/minimal-interface` (15 modified files plus `tests/e2e/navigation.e2e.mjs` and `tests/unit/studio.test.js`) as a checkpoint.
- Branch `claude/night-atlas` from it.

### Phase 1: Foundation
- `ui/studio.css`: rewrite as tokens, `@font-face`, base elements (buttons, inputs, chips, cards, list rows, side sheet, dialog) and the shell. Delete the duplicated override blocks.
- Delete the legacy token layers: remove the `:root` tokens in `ui/shared.css`, the `--nt-*` tokens in `ui/newtab.css`, and the hardcoded light colors in `ui/map.css`. Page CSS files keep only layout and components on the new tokens, with no `!important`.
- Add `vendor/fonts/` (woff2 plus OFL license).
- Sidebar: keep geometry, dock, hover pill, tooltips and behavior as-is (`mount` in `ui/studio.js`); restyle via tokens only.
- Add a contrast unit test (`tests/unit/tokens.test.js`): parse the `studio.css` tokens and assert text/bg ≥ 7:1, dim ≥ 4.5:1 and faint ≥ 4.5:1 in both themes.

### Phase 2: Home (`ui/newtab.js` home mode, `ui/newtab.css`, `ui/dashboard.js`)
First viewport, top to bottom:
1. **Greeting** in Fraunces ("Welcome back.") and a date line: "Monday, Sept 14 · 44m estimated today". The time comes from `CTDashboard.buildDailySignals(record).totalMs`; clicking it opens the existing time drawer.
2. **Search**: the existing form and behavior (Enter, Escape, `/`).
3. **Continue card**: reuse `D.continuation(record)` (`lib/dashboard.js`, already used in `ui/dashboard.js` draw). Shows the trail name, personal note, "Open last page ↗" and "Start session". It moves from the Your trails view to Home.
4. **Trail chips**: up to 4 (pinned first, then most recent) with a trail-colored 7-day visit strip. Chips open the trail sheet.
5. **Fraction line**:
   - "Continuity 11 of 11 steps · Top trail 13m of 40m · Return share 40m of 40m", using the existing `raw(key)` values; missing values show "—".
   - Each fraction is a button that calls `openMetric(key)`.
   - Show a small "Today in detail ↓" cue.

Below the fold:
- A **Today** section with the three restyled rings (`nt-ring-card` etc.): thin neutral-ink ring, Fraunces number, title, literal fraction, "View details". Clicking still opens the drawer.
- **Scroll morph:** a CSS scroll-driven animation (`animation-timeline: view()`) scales and fades the rings in from the fraction row. Under reduced motion, or without scroll-timeline support, it's a plain section.
- Keep the coverage line ("16 of 18 visits grouped · timing measured for 18").

Other states:
- **Searching** replaces the content under the search bar with results (existing `runSearch`/`drawVisitList`).
- **Empty and no-model states:** without trails, the chips become recent pages. Without records, a friendly empty state links to the sample and settings. Home never loads a model.
- In `dashboard.js`, add a `home` mount mode for the fraction line plus the Today section. Keep `minimal`/`showSessions` for Your trails.

### Phase 3: Your trails (`ui/newtab.js` trails mode, `ui/newtab.css`)
- Header: title, search, sort `<select>` (Recent · Most time · Most days returned · A–Z) and filter chips (Pinned · Has note · This week · Pages without a trail).
- Sections: Pinned, Today, This week, Earlier, bucketed by `trail.lastAt` against local day keys (`CTText.dayKeyFromMs`, `CTText.addDays`). Sorting other than Recent flattens the sections.
- Each row (`nt-trail-card` → list row, keeping `nt-trail-title` and `nt-pin`):
  - color swatch and personal name, with the suggested label as secondary text when renamed;
  - a 14-day visit strip built from `trail.events[].day`;
  - "N pages · N sites · last visited 2 days ago";
  - estimated time `duration(trail.estimatedMs)` and a pin.
- Trail detail opens as a right side sheet (bottom sheet on mobile) reusing `drawTrail` content (`nt-detail-heading`, `nt-edit-form`, `nt-episode`, `nt-visit`):
  - summary numbers (pages, sites, days returned, estimated time);
  - a note field;
  - dated episodes.
- The right-hand aside ("week at a glance", stats, capture status) becomes a compact footer strip. The method details (`nt-method`) and freshness line (`nt-freshness`) stay.

### Phase 4: Grand graph (`ui/map.js`, `ui/map.html`, `ui/map.css`)
Remove the card-grid view (`#graph-atlas`, `renderAtlas`, `atlasFrame`, `revealGraph`) and the treemap (`computeTopicAnchors` group rectangles). The canvas becomes the page: full-bleed within the shell, with the inspector (`#evidence-panel`) as a right panel.

Keep:
- `CTMapData.build` and `buildTopicGroups` (`ui/mapData.js`);
- `buildGraphData`;
- the selection and evidence methods (`selectTopic`, `selectTransition`, `selectPage`, `selectGroup`, `appendTimeline`, `appendSites`, `appendConnectionAudit`);
- search (`searchGraph`), zoom controls and tooltips.

**Layout:** a seeded, deterministic `d3.forceSimulation`, pre-ticked about 300 times, then stopped.
- Initial positions come from an id hash. Positions are cached in `savedPositions`.
- Forces:
  - a link force over cross-trail transitions, strength ∝ `log1p(visitCount)`;
  - group cohesion: each trail is pulled toward its `buildTopicGroups` group centroid; "Other trails" gets only weak centering;
  - weak many-body repulsion;
  - `forceCollide(radius + 8)`.
- Node radius is `sqrt` of `estimatedDwellMs`, clamped to 8–34.
- The ungrouped collection sits at the edge as a dust field of loose pages.

**Halos:** per related group, a padded `d3.polygonHull` smoothed with `curveCatmullRomClosed` (a circle for 1–2 members), filled with the group color at about 9% opacity, with a group label.

**Edges:**
- Curved quadratic paths with count badges.
- The overview shows the top N by weight (`#flow-limit`).
- Selecting a trail shows all its routes.
- Keep the `.flow-link` class.

**Semantic zoom** (`updateLevelOfDetail`):
- zoomed out (k < 0.6): group labels only;
- mid zoom: greedy collision-avoiding trail labels, ranked by time, with the top ~15 always shown;
- zoomed in (k > 1.6) or on selection: page satellites (existing `anchorForNode` golden-angle placement), keeping `.page-node`/`.topic-node`/`.page-label`.

**Interactions:**
- Hover dims unrelated nodes.
- Click selects and opens the inspector.
- Search highlights and zooms (`zoomToNodes`).
- Keyboard Enter/Space and Escape.
- Controls: Overview/Fit, zoom, a Pages/Connections toggle (`graph-focus-tabs`), and a Map options popover (window, flow lines, trail limit, labels).

**Narrow screens:** the canvas fills the width, the inspector becomes a bottom sheet, labels are decluttered.

### Phase 5: Explore, Settings, Record & privacy, demo
- Explore (`ui/explore.js`, `ui/explore.css`): same structure. The heading becomes "Your week" with the date range. Bars use the new trail palette and gain a Fraunces total.
- Settings (`ui/options.html`, `ui/options.css`) and Record & privacy (`ui/audit.html`, `ui/audit.css`):
  - rebuild on token cards and rows;
  - drop the duplicate header link buttons instead of hiding them with CSS;
  - keep every control and ID that `ui/options.js` and `ui/audit.js` use.
- Demo (`ui/demo.html`, `ui/demo.css`): same shell; the sample badge becomes a token chip.

### Phase 6: Tests and docs
- **Update to the new structure:**
  - `tests/unit/home.test.js`: Home now shows the continuation card and chips when data exists; rings still render; `.nt-layout` visibility assertions change.
  - `tests/ui.test.js`: aside assertions (`nt-time-estimate`, `nt-mini-day`) move to the footer strip.
  - e2e suites `studio`, `graph-scale`, `connections` and `navigation`: replace `.atlas-*` and `#graph-atlas` flows with constellation selection, keep `.topic-node`/`.page-node`/`.flow-link`/`#evidence-panel`/`.graph-result`/`.graph-timeline`/`.graph-connection-audit`.
- **Add:**
  - the token contrast test;
  - a graph layout unit test: deterministic positions for the same input, and no node overlap at 117 trails (`tests/fixtures/largeGraph.js`).
- **Docs:** README ("Today and optional sessions" plus the Graph paragraphs), `design/README.md`, and fresh screenshots in `design/implemented/`.

## Verification
- `npm test`: unit, protocol, migration, copy, hue, DOM, entry-point and the new token/layout tests.
- `npm run e2e:studio`, `npm run e2e:graph-scale`, `npm run e2e:connections`, `npm run e2e:trails`, and `node tests/e2e/navigation.e2e.mjs`.
- `npm run check:laptop` is not needed (no inference changes).
- Browser pane on the demo server (`http://localhost:8912/ui/demo.html`, `map.html?demo=1`, `explore.html?demo=1`, `demo.html?view=trails`):
  - screenshots at 1440, 1024, 768, 390 and 320 px, in dark and light;
  - check the scroll morph, fraction → drawer, the trail sheet, and graph zoom levels and selection;
  - no console errors.
- The 117-trail fixture in the graph-scale suite stays legible: no label overlaps and click targets ≥ 24px.
- `npm run package`, then load `dist/cognitive-trails` unpacked in Chrome to confirm the fonts load under the extension CSP.
