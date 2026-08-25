# Phase 6 Notes — Demo and docs

## Done
- `ui/demo.html` + `demo.js` + `demo.css` replace v3's `test.html`. It loads `fixtures/golden/snapshot.json` into an in-memory store and renders **the real surfaces** — `CTNewtab.main` and `CTAudit.render`, not reimplementations — so the demo cannot drift from the product. Four tabs:
  - **Home** — the Whoop-style new tab over the recorded record.
  - **Audit** — coverage, registry, exclusions by reason, run history, storage.
  - **Adjudication & exclusions** — what the record refuses to claim and why, every topic expandable to its evidence pages, the adjudication protocol on real model output, and every recorded prompt/reply.
  - **Validation** — the committed report, rendered from Markdown.
- `tools/serveDemo.js` serves it with no dependencies: `node tools/serveDemo.js` then open `http://localhost:8912/ui/demo.html`. Works from a fresh clone with Ollama absent.
- `tools/recordAuditDemo.js` records the self-consistency protocol against live gemma3:12b with the gate deliberately widened (see below).
- `tools/refreshGoldenSnapshot.js` regenerates the demo's database by *replaying* the committed transcript through the current pipeline — no Ollama. Use it after a pipeline change that alters stored values but not prompts; `recordGolden.js` is for when the prompts themselves change.
- README rewritten around what the system measures and what it refuses to infer, with the validation numbers and an explicit note that the committed report wins over any prose claim. `PRIVACY.md` written as a verification procedure (net-export, grep, export inspection, delete check) with an honest "where the risk actually is" section. `DEBUGGING.md` rewritten for v4.

## Why there is a separate adjudication recording

With the gate fixed (Phase 3 notes), the audit **never fires on the fixture** — the clusters really are cohesive. That is the correct outcome and the honest one, but it would leave the demo showing none of the protocol that the trust argument rests on.

`tools/recordAuditDemo.js` therefore runs the same code path with `cohesionThreshold` raised to 0.99 over three contrasting clusters, and the demo labels it as exactly that. The result is more informative than a staged success would have been:

| Case | cohesion | audited in production? | pass 1 / pass 2 | grouping agreement | outcome |
|---|---|---|---|---|---|
| Coherent Rust-async cluster | 0.859 | no | split / split | 0.333 | excluded |
| Sourdough + Kubernetes, forced together | 0.608 | yes | split / split | 0.400 | excluded |
| Ambiguous link roundups | 0.575 | yes | split / split | 0.467 | excluded |

gemma3:12b answers "split" to essentially any cluster of 8–12 pages and cannot reproduce its own grouping when the page order is reversed. **That instability is the thing the two-pass protocol exists to detect**, and the table is the argument for the gate: send it a coherent topic and it will happily fragment it, so the gate must only send material where fragmentation is the honest answer. All three Jaccard scores fall below the 0.60 bar, so all three end in exclusion — which is right for rows 2 and 3, and is precisely why row 1 must never reach this code path in production.

## Acceptance
- Demo works from a fresh clone with no Ollama: verified in a browser (3 rings, 3 brief items, 4 focused runs, all four tabs populated).
- README claims match `validation/report-*.md`: the report is committed alongside and the README says so explicitly rather than restating the figures as prose.
