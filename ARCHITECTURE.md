# Architecture and contracts

## Observation and storage

The content script collects a bounded main-content excerpt and interaction timing from eligible http(s) top-level pages. It avoids editable/form content, checks sensitive URLs before collecting, sanitizes URLs, and handles SPA navigation. Chat pages retain a bounded head and tail and refresh at most once per minute, twelve times per page session. A mutation marks content dirty rather than repeatedly extracting it.

The service worker validates captures again and owns their writes. Initial content and final updates are durable before acknowledgement; intermediate timing updates are buffered. A serialized writer barrier coordinates capture, retention, preferences, personal trail metadata, and pipeline starts. Deletion closes the gate synchronously, drains in-flight writes, stops and verifies the offscreen document, then wipes the record. It retains only a paused state and a history import cutoff, so a later import cannot resurrect the deleted history. Failed shutdown does not report successful deletion.

IndexedDB `cognitive-trails` remains schema version 4; the app release is version 5. URL identity migration runs atomically and idempotently. It reconstructs query-addressed pages from preserved visit/capture URLs, removes excluded legacy URLs, invalidates affected memberships, and schedules derived history for repair. The original URL information can only be recovered where a visit/capture retained it. Existing embedding-model changes are refused if incompatible with the registry's model/dimension.

Home loads one metadata snapshot transaction, omitting page text and vectors from the returned data. It reconciles captures with visits one-to-one, then derives search results and trail episodes. It refreshes when shown and every 30 seconds while visible; an open note editor is preserved. Personal metadata lives in `corrections` under `trail:<id>` and is overlaid on suggested topics. It has separate timestamps and bounded text fields. Concurrent edits to the same note use last-write-wins.

## Local analysis

The offscreen document performs history import → embeddings → clustering → labels → bounded ambiguity checks → atomic registry commit → transitions and daily metrics. The service worker proxies Chrome history because offscreen documents cannot call that API directly. Pipeline liveness uses a real heartbeat clock; calendar processing can use an injected clock for reproducible tests.

`needsEmbedding`, `needsClassification`, `classificationStatus`, and `classificationReason` are durable page state. Embeddings commit after each completed batch. Failed or interrupted classification leaves pending rows, even if a page is outside the import overlap. Registry rows, memberships, events, and completed page classification flags commit in one transaction. A failed registry transaction cannot expose half a topic update. `metricsDirty` keeps downstream repair retryable after a partial derived-data failure. The import watermark advances only after successful processing of the bounded pass, not after every page in the backlog has been grouped.

Pages attach to existing centroids when they meet a heuristic threshold; remaining pages use deterministic average-linkage clustering. Model labels summarize sampled page subjects. Low-cohesion groups can receive two order-varied checks; agreement is a consistency check, not scientific validation. Disagreement can leave pages ungrouped. Transport errors remain recorded; these heuristics do not certify a topic's accuracy. UI language calls every group a suggestion and keeps the source pages accessible.

Topic identity persists across runs. A dormant topic revives only when new evidence has a later visit date; processing old backlog cannot manufacture a return. Membership dwell is recomputed from authoritative page totals instead of added repeatedly across overlap imports. Retired identities are not silently reused. Ambiguous match candidates stay separate; unsafe legacy manual merge and map write paths were removed. Naming and notes use the supported Home workflow.

## Runtime boundaries

The model endpoint is fixed to localhost:11434. Ollama origin rewriting is scoped to the extension's initiator ID; arbitrary webpages cannot use it. No hosted inference fallback exists. Startup health checks list models without loading them. A small chat model receives structured output schemas and bounded contexts; embedding and labeling models are run sequentially and released.

The idle gate is cooperative: it checks between requests. It cannot instantly preempt a GPU request already in progress or guarantee zero latency impact. Work is deferred rather than discarded. A cold initial import can take several bounded passes. The default hourly scheduler drains pending pages independently of new-visit counts.

## Verification boundaries

Tests cover identity preservation, encoded/hash privacy paths, final capture durability, deletion races, rollback, corrupted caches, vector-space changes, batch deferral, backlog drainage, stale metrics, longitudinal topic identity, descriptive metrics, notes/pins/search, and the actual Chrome extension lifecycle. Live evaluation uses synthetic material and a fresh vector cache. A full transcript replay protects protocol integration; it does not replace a human pilot.

Current limitations: metadata/history grow until the user deletes the record; snapshot loading and clustering need further measurement at years of history. Query sanitization and exclusion lists are conservative, not complete personal-data detection. Inferred page groups and approximate time can be wrong. Calendar displays follow the current device timezone, so changing timezone can change day grouping. No encryption beyond the browser/OS profile, multi-device sync, full-text index, automated human-quality evaluation, or store publishing is supplied.
