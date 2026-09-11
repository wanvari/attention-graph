# Architecture and contracts

## Observation and storage

The content script collects a bounded main-content excerpt and interaction timing from eligible http(s) top-level pages. It avoids editable/form content, checks sensitive URLs before collecting, sanitizes URLs, and handles SPA navigation. Chat pages retain a bounded head and tail and refresh at most once per minute, twelve times per page session. A mutation marks content dirty rather than repeatedly extracting it.

The service worker validates captures again and owns their writes. Initial content and final updates are durable before acknowledgement; intermediate timing updates are buffered. A serialized writer barrier coordinates capture, retention, preferences, personal trail metadata, and pipeline starts. Deletion closes the gate synchronously, drains in-flight writes, stops and verifies the offscreen document, then wipes the record. It retains only a paused state and a history import cutoff, so a later import cannot resurrect the deleted history. Failed shutdown does not report successful deletion.

IndexedDB `cognitive-trails` uses schema version 6; the app release is 5.1.2. URL identity migration runs atomically and idempotently. It reconstructs query-addressed pages from preserved visit/capture URLs, removes excluded legacy URLs, invalidates affected memberships, and schedules derived history for repair. The original URL information can only be recovered where a visit/capture retained it. Existing embedding-model changes are refused if incompatible with the registry's model/dimension.

Home loads one metadata snapshot transaction, omitting page text and vectors from the returned data. It reconciles captures with visits one-to-one, then derives search results and trail episodes. It refreshes when shown and every 30 seconds while visible; open editors and evidence drawers are preserved. Personal metadata lives in `corrections` under `trail:<id>` and is overlaid on suggested topics. It has separate timestamps and bounded text fields. Concurrent edits to the same note use last-write-wins.

## Local analysis

The offscreen document performs history import → embeddings → clustering → labels → bounded ambiguity checks → atomic registry commit → transitions and daily metrics. The service worker proxies Chrome history because offscreen documents cannot call that API directly. Pipeline liveness uses a real heartbeat clock; calendar processing can use an injected clock for reproducible tests.

`needsEmbedding`, `needsClassification`, `classificationStatus`, and `classificationReason` are durable page state. Embeddings commit after each completed batch. Failed or interrupted classification leaves pending rows, even if a page is outside the import overlap. Registry rows, memberships, events, and completed page classification flags commit in one transaction. A failed registry transaction cannot expose half a topic update. `metricsDirty` keeps downstream repair retryable after a partial derived-data failure. The import watermark advances only after successful processing of the bounded pass, not after every page in the backlog has been grouped.

Pages attach only with enough behavioral evidence, centroid similarity ≥ .78, a runner-up margin ≥ .05 and similarity ≥ .70 to up to two actual members; remaining pages use deterministic average-linkage clustering. Model labels summarize sampled page subjects. Low-cohesion groups can receive two order-varied checks; agreement is a consistency check, not scientific validation. Disagreement can leave pages ungrouped. Transport errors remain recorded; these heuristics do not certify a topic's accuracy. UI language calls every group a suggestion and keeps the source pages accessible.

Topic identity persists across runs. A dormant topic revives only when new evidence has a later visit date; processing old backlog cannot manufacture a return. Membership dwell is recomputed from authoritative page totals instead of added repeatedly across overlap imports. An explicit page correction may reactivate a retired identity; automatic assignment cannot silently reuse one. Ambiguous match candidates stay separate; unsafe legacy manual merge and map write paths were removed. Naming and notes use the supported Home workflow.

## Shared evidence and daily signals

`lib/trails.js` reconciles captures/history one-to-one and allocates non-overlapping intervals once across the full record. Timestamped activity preserves gaps. Legacy totals are placed from the visit start as estimates; operational-page history gaps remain unknown without interaction evidence. Timestamped activity takes precedence over legacy interaction totals, which take precedence over history-gap estimates. Within the same evidence type, the latest-started interval wins, with stable ID tie-breaking; this is an allocation rule, not proof of foreground ownership. Grouping eligibility uses the allocated evidence. Operational pages require at least two minutes of recorded interaction; incident articles remain ordinary content. Startup repair version 3 updates stored totals under this rule without deleting navigation records.

`lib/integrity.js` rebuilds replaceable visit/page/member/topic totals atomically, preserving `gapDwellMs` and original navigation records. Conflicting owners abstain. Removed members cause centroids to rebuild from compatible cached vectors or mark the topic for rebuilding. Manual `page_membership` corrections are applied inside the same transaction and checked again during any later registry commit. Home, Map, Audit and recaps derive from the same corrected record. Raw diagnostics deliberately open the existing DB version without migration and omit text/vectors.

`lib/dashboard.js` calculates bounded daily ratios, a 28-calendar-day comparison at the same local clock time, median and Tukey quartiles. Minimum evidence prevents labeling sparse days relative to a personal range. Grouped/timed record counts and transition exclusions are explicit. Current timezone determines calendar boundaries; DST uses local calendar constructors, not fixed 24-hour offsets.

## Intent sessions

`intent_sessions` persists target, optional note, start/deadline, completion reason and notification/recap receipt state. Worker messages are serialized through the existing deletion barrier. Chrome alarms and startup/status reconciliation finalize overdue sessions at the intended deadline. If pause persistence is interrupted before session completion, reconciliation ends the session at the first overlapping pause boundary, even after capture resumes. Completion and notification suppression are durable before browser API calls; alarm/notification cleanup retries after failures with persisted completion markers. Viewing the recap suppresses further delivery. Alarms may arrive late during sleep; the recorded deadline remains fixed. Untimed sessions persist until ended or capture pauses. Deletion clears session alarms and notifications before wiping the database. Recaps remeasure the bounded interval using current corrections and show missing coverage. Session actions never run inference.

## Runtime boundaries

The model endpoint is fixed to localhost:11434. Ollama origin rewriting is scoped to the extension's initiator ID; arbitrary webpages cannot use it. No hosted inference fallback exists. Startup health checks list models without loading them. A small chat model receives structured output schemas and bounded contexts; embedding and labeling models are run sequentially and released.

The idle gate is cooperative: it checks between requests. It cannot instantly preempt a GPU request already in progress or guarantee zero latency impact. Work is deferred rather than discarded. A cold initial import can take several bounded passes. The default hourly scheduler drains pending pages independently of new-visit counts.

## Verification boundaries

The offscreen host explicitly acknowledges accepted work and refuses requests during a run or model cleanup. The worker propagates that refusal instead of reporting a run that was dropped. Completion is reported after both model unload attempts; a missing completion acknowledgement times out after five seconds so the document can close. The browser shutdown check allows the two ten-second unload timeouts, that acknowledgement deadline, and browser overhead.

Tests cover identity preservation, encoded/hash privacy paths, final capture durability, deletion races, rollback, corrupted caches, vector-space changes, batch deferral, backlog drainage, stale metrics, longitudinal topic identity, descriptive metrics, notes/pins/search, and the actual Chrome extension lifecycle. Live evaluation uses synthetic material and a fresh vector cache. A full transcript replay protects protocol integration; it does not replace a human pilot.

Current limitations: metadata/history grow until the user deletes the record; snapshot loading and clustering need further measurement at years of history. Query sanitization and exclusion lists are conservative, not complete personal-data detection. Inferred page groups and approximate time can be wrong. Calendar displays follow the current device timezone, so changing timezone can change day grouping. No encryption beyond the browser/OS profile, multi-device sync, full-text index, automated human-quality evaluation, or store publishing is supplied.


### Metadata reads and evidence calculations (5.1.2)

Schema 6 preserves the existing raw captures, topics and embeddings. Three derived `_metadata_*` stores omit captured text and vectors; they are backfilled atomically with cursors on upgrade. All production mutations go through the store transaction wrapper, which writes each projection and per-table `_snapshot_revisions` in the same transaction as its source. Aborts roll back all three. These internal stores are excluded from metadata exports; wiping clears the projections and advances revisions. Do not bypass the wrapper with direct IndexedDB writes or cursor updates.

`readSnapshot(names)` still returns a fresh metadata snapshot. Home opts into `reuseUnchanged`; it reads revisions and changed tables in one consistent read transaction and reuses unchanged arrays. These opt-in snapshots are read-only; UI updates must replace objects rather than mutate them. Time-dependent record and daily calculations still receive a fresh clock, so revisions cannot suppress midnight, DST or session updates.

Record construction groups shared page evidence once and indexes events by topic. Daily comparisons allocate one complete timeline then query bounded windows, rather than allocating it independently 29 times. Frozen 5.1.1 reference implementations and adversarial equivalence tests check all output fields. Completed startup repair checks its version inside the write transaction before loading tables; explicit repairs still rebuild the entire record and skip shallow-identical row writes.
