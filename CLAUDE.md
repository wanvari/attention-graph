# Cognitive Trails development contract

This repository is Cognitive Trails 5.1, a Manifest V3 Chrome extension. It uses vanilla UMD JavaScript, HTML/CSS, D3, IndexedDB, and local Ollama; there is no bundler or hosted backend. See README.md, ARCHITECTURE.md, and PRIVACY.md for the current product and contracts.

- Preserve user records. Checkpoint before major changes. Database schema is version 6 (raw stores preserved; derived metadata projections and transactional read revisions); migration gates are idempotent settings.
- Record page observations, never infer cognition, goals, productivity, mental health, or scientific validity from browsing. Primary metrics are qualified time estimates and literal Continuity, Top trail and Return share ratios with denominators and evidence. Source pages and ungrouped records remain accessible.
- Keep every inference request on localhost:11434. Never add remote inference or analytics. Keep Origin rewriting restricted to this extension's initiator ID.
- Respect default laptop budgets: bge-m3 embeddings, qwen3:4b labels, 100 pages, 12 new topics, batches 8/6, 8192 context, 1800 output, 50% pacing, four CPU threads, idle checks, short residency and explicit unloading. A model change must be measured; compatibility of vector spaces must be checked.
- Pipeline classification and downstream metrics work are durable and retryable. Batch embeddings are retained on interruption. Registry commits are atomic; page memberships have one current owner. Replay and overlaps cannot inflate totals or invent revivals.
- Worker writes share a deletion barrier. Preferences and trail metadata go through worker messages; do not add direct UI writes that can race deletion. Personal labels/notes overlay inferred labels.
- Home reads a metadata snapshot and never calls a model. Keep it useful before model installation. Use local search, trail sessions, pins and optional notes. Never expose self-rated model confidence as a probability.
- Keep all modules Node-loadable and extension-loadable. HTML dependencies must be present in the proper order, including relevance, trails and dashboard modules.
- Run `npm test`, relevant `npm run e2e:*` suites, and `npm run check:laptop` when changing inference behavior. Current full transcripts live under fixtures/current. A changed prompt must fail exact replay, not receive a substituted reply. Legacy fixtures/reports are historical evidence only.
- User-facing copy is neutral, concrete, and qualified. Automated copy/CSS checks are guardrails, not proof that a product avoids unsupported claims.
