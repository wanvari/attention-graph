# Design: Night atlas

The extension's interface as of September 2026. The approved plan, with its tokens, constraints and verification steps, is in [night-atlas-plan.md](night-atlas-plan.md).

## Principles

- A blue-black canvas (`#0b0e14`) with near-white text; the light theme keeps the same hierarchy. Body, secondary and faint text meet WCAG AA or better on every surface in both themes, checked by `tests/unit/tokens.test.js`.
- Fraunces for headings, trail names and large numbers; Inter for interface text. Both are bundled in `vendor/fonts/` (SIL Open Font License) because extension pages only load their own files.
- Each trail keeps one color on every screen (`--trail-0` to `--trail-7`). The lime accent marks navigation and focus only. No color grades a value, so the three rings share one neutral ink.
- One token file: `ui/studio.css` defines the tokens, fonts, base elements, shared controls and the sidebar. Page stylesheets add layout only.

## Screens

| Screen | What it shows | Screenshots |
| --- | --- | --- |
| Home | Greeting, search, a card for picking up where you left off, recent trails, and today's ratios as literal fractions. Scrolling down shows the same ratios as rings. | [Dark](implemented/night-atlas-home-dark.png) · [Light](implemented/night-atlas-home-light.png) · [Today in detail](implemented/night-atlas-home-today-dark.png) · [Phone](implemented/night-atlas-home-mobile-dark.png) |
| Your trails | Pinned, Today, This week and Earlier sections with sorting, filters and a 14-day visit strip per trail. Trail detail opens in a side sheet. | [Dark](implemented/night-atlas-trails-dark.png) |
| Graph | Every trail in one constellation. Halos group shared title words; arrows are repeated visit sequences; selecting a trail shows its pages as satellites. | [Dark](implemented/night-atlas-graph-dark.png) · [Light](implemented/night-atlas-graph-light.png) · [Selected trail](implemented/night-atlas-graph-selected-dark.png) |
| Explore | Seven or fourteen days of stacked activity, with the pages behind each day. | [Dark](implemented/night-atlas-explore-dark.png) |

Settings and Record & privacy use the same page header, panels and controls. The screenshots use the committed synthetic sample.

## Try it

Run `npm run demo` and open [Home](http://localhost:8912/ui/demo.html), [Your trails](http://localhost:8912/ui/demo.html?view=trails), [Graph](http://localhost:8912/ui/map.html?demo=1) or [Explore](http://localhost:8912/ui/explore.html?demo=1). The sample is read-only.

## Verification

- `npm test`: unit, protocol, copy, hue, DOM, entry-point and token-contrast tests.
- `npm run e2e:studio`: theme sync, graph search, keyboard, drag and labels, chart totals, and six screens in two themes at five widths.
- `npm run e2e:graph-scale`: 117 trails and 1,025 pages with separated circles, collision-free labels inside the canvas, a deterministic layout, complete lists and phone widths.
- `npm run e2e:connections`, `npm run e2e:trails` and `node tests/e2e/navigation.e2e.mjs`: related titles, the full product flow through the worker, and dock navigation.

Earlier explorations (Still, Studio, Fieldnotes and the minimal interface) are in git history.
