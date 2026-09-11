# Studio implementation

The extension now uses Studio across Home, Graph, Explore, Settings and record inspection. Dark mode is the default; the Light/Dark preference is saved through the worker and synchronized across open extension pages. The installed UI reads existing records; no database migration, model, or permission changes are needed for this redesign.

Try the implemented screens with `npm run demo`: [Home](http://localhost:8912/ui/demo.html), [Graph](http://localhost:8912/ui/map.html?demo=1), and [Explore](http://localhost:8912/ui/explore.html?demo=1). This uses the committed March sample, so its graph and activity differ from the illustrative prototypes below. Connections appear only when the record contains at least two qualifying sequences.

Implemented screenshots: [Home](implemented/studio-home-dark.png) · [Graph, dark](implemented/studio-graph-dark.png) · [Graph, light](implemented/studio-graph-light.png) · [Explore](implemented/studio-explore-dark.png).

Implementation checks include the full unit/protocol suite, the existing Chrome trails workflow, and `npm run e2e:studio` for theme persistence, graph source evidence, search, dragging, keyboard selection, chart drill-down, and six screens at five widths in both themes.

# Cognitive Trails: UI explorations

Open `http://localhost:8912/design/prototype/mockups.html` after running `npm run demo`. The prototype opens to the selected Studio graph direction, dark by default. It also opens directly from `design/prototype/mockups.html` and uses the repository’s bundled D3; it loads no external assets. Home, Graph, Explore, and Your trails share the same navigation. The original directions remain accessible through the top selector.

These are design proposals with illustrative September 4–10, 2026 data, not a replacement for the production UI or the existing model-recorded fixture. The prototype itself does not touch production records. The approved Studio direction is now implemented in `ui/`; these archived files preserve the earlier proposals. Source links open external pages only when clicked. Notes, pins, and graph arrangements live in memory and reset on reload. The Studio theme preference is saved in the prototype-specific localStorage key `ct.design.studio.theme`; this does not access the extension database.

## Selected direction: Studio, after dark

The selected direction combines Studio’s persistent sidebar and structured workspace with a higher-contrast dark theme. Near-black backgrounds, brighter text, and explicit surface boundaries support a night-focused interface. Trail identities remain violet, cyan, amber, and mint in both themes; the light palette is adjusted for contrast against light surfaces.

| Preview | Image |
| --- | --- |
| Full graph, dark | [Dark graph](mockups/studio-graph-dark.png) |
| Full graph, light | [Light graph](mockups/studio-graph-light.png) |
| Home, dark | [Dark home](mockups/studio-home-dark.png) |
| Weekly explorer, dark | [Dark weekly breakdown](mockups/studio-explore-dark.png) |

Deep links accept `?concept=studio&view=graph&theme=dark` or `theme=light`. Changing the theme updates the entire workspace, including dialogs, without rebuilding the graph or changing its camera. The toggle remembers the preference; an explicit theme in a link overrides that saved preference for the page.

### The full graph

The Graph navigation item preserves a full topic/page graph, independently of the simplified Connections explorer. All 21 sample nodes are visible: four topic nodes, fifteen grouped page nodes, and two ungrouped page nodes. Fifteen thin membership lines connect pages to their topics. Four arrowed connections represent repeated recorded sequences, with clickable counts and source evidence.

- Stable initial clusters; topic size follows estimated time with a minimum visible size, while page size follows visit counts.
- Pan, scroll/pinch zoom, zoom buttons, and Fit. Dragging a topic carries its pages; pages can also be rearranged individually.
- Select topics, pages, or connections for a matching detail panel. Keyboard Enter/Space supports the same selection.
- Optional neighborhood focus dims unrelated nodes while leaving them visible.
- Automatic labels reveal more detail on zoom; explicit All/Off labels and a Pages toggle are available. Narrow screens declutter labels and place the detail panel below the graph.
- Search highlights matching graph nodes and gives an explicit no-match state.
- The light/dark switch leaves node positions and camera unchanged.

This mockup renders the illustrative sample graph rather than the installed extension’s history. Production integration retains the existing map adapter’s membership, sequence, correction, and evidence semantics. Timeline and weekly charts complement the graph; they do not replace it.

## Three directions

| Direction | Home | Default explorer | Design intent |
| --- | --- | --- | --- |
| Still | [Screenshot](mockups/still-home.png) | [Chronological view](mockups/still-explore.png) | Generous space, quiet navigation, one prominent return action, a personal note. |
| Studio | [Screenshot](mockups/studio-home.png) | [Weekly breakdown](mockups/studio-explore.png) | Persistent sidebar, compact record summary, clear hierarchy, direct access to details. |
| Fieldnotes | [Screenshot](mockups/field-home.png) | [Focused connections](mockups/field-explore.png) | Rounded shapes, tactile buttons, welcoming language, an original waymarker character. |

The user selected Studio with a dark default and optional light mode, stronger contrast, distinct colors, and the full graph retained. The three directions above document the earlier exploration.

## Why rethink the charts

The current home gives three large ratios priority over retrieval and continuation. Their mathematical meaning requires explanation, and full rings can read as goals despite neutral wording. The map simultaneously shows topic membership and transitions; its force-directed layout does not convey a stable time axis or a clear next action.

The proposed home emphasizes the saved trail, the person’s note, and search. A compact record strip provides context without dominating the page. All totals retain ungrouped pages. Pinning and notes remain user-authored.

### Your day

Question: “What was I looking at, and where do I pick it up?”

Topics occupy stable lanes on a labeled time axis. A block represents a recorded stretch and opens its individual visits, links, and estimated time. The selected block and detail panel stay visually connected. Gaps do not imply inactivity. In production, place intervals using the existing evidence calculation, and distinguish intervals whose timing is unknown or estimated.

### Your week

Question: “What did I come back to?”

Stacked daily bars show estimated time by trail, including ungrouped pages. Select a day for exact topic totals and source visits. Switch between estimated time and literal visit counts. All marks and totals derive from the same sample visits; the chart does not infer attention, productivity, or learning.

### Connections

Question: “What recorded pages explain this connection?”

Choose one source trail. Show only outgoing destinations with at least two qualifying consecutive sequences. Label the count, keep the layout stable, and expose each before/after pair with timestamps and source links. A connection means recorded sequence, not conceptual similarity or a shared task. A trail without qualifying connections has an explicit empty state with access to its pages.

## Working interactions

- Switch between three directions, three main pages, and three explorer alternatives.
- Search sample titles, websites, trail names, and personal notes; keyboard shortcut Cmd/Ctrl+K.
- Open trails and their source links; pin/unpin trails; filter to pinned trails.
- Edit notes for this prototype session.
- Select timeline blocks, weekly days, units, starting trails, and connections.
- Inspect source visits, evidence explanations, and meaningful empty states.
- Native modal keyboard focus and Escape support; labeled controls and polite selection announcements.

Initial browser verification exercised those flows and checked page overflow for every direction/page/chart at widths 1440, 1024, 768, 390, and 320. The Studio refinement additionally checks node and edge selection, recorded source pairs, focus, search and empty results, dragging, panning, zooming, page and label controls, keyboard selection, ungrouped records, saved theme preferences, and an unchanged camera during a theme switch. Its four main screens are checked in both themes at 1536, 1280, 1024, 768, 390, and 320 pixels. Desktop and mobile screenshots are visually reviewed. This is prototype QA, not a full accessibility audit or production integration test.

## Design references

These inform the proposals; the layouts and waymarker artwork are original.

- [Apple’s software design overview](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/): content emphasis and navigation as a distinct layer.
- [Stripe payments analytics](https://docs.stripe.com/payments/analytics): overview, filtering, and specific reports.
- [Duolingo’s core tab redesign](https://blog.duolingo.com/core-tabs-redesign/): consistent hierarchy, spacing, and purposeful visual character.

The implementation is isolated in `design/prototype/mockups.html`, `ui/mockups.css`, `ui/mockups.js`, `ui/studio-night.css`, and `ui/mockup-graph.js`. Production work would connect the selected presentation to `CTTrails`, `CTDashboard`, and the existing graph view model, preserve the evidence and correction contracts, and verify against the recorded fixture and extension flows.
