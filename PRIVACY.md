# Privacy

Cognitive Trails stores eligible browsing locally in your Chrome profile. It does not send browsing history, text, metrics, or notes to a hosted service. Local grouping sends titles and short excerpts to your own Ollama process at `http://localhost:11434`. Installing models is a separate download from Ollama; opening an original page or explicitly choosing web search makes the normal browser request to that destination.

## Stored data

IndexedDB `cognitive-trails` contains sanitized URLs, titles, visit times, approximate dwell, interaction timing, scroll depth, bounded main-content text, embeddings, suggested topic groups, memberships, model run logs, derived metrics, and personal trail names/notes, timestamped activity intervals, page-grouping corrections, and optional session targets/notes/deadlines/recaps. `chrome.storage.local` mirrors pause state and exclusion preferences for content scripts. There is no analytics SDK, remote logging, or hosted inference fallback.

Content scripts run on top-level http(s) pages. They do not read input, textarea, select, or editable values. The default exclusion list covers many financial, health, authentication, password-manager, and mail services. Sensitive paths and route/query selectors are checked after repeated decoding, including hash-based routes. Tracking parameters and ordinary fragment anchors are removed. Content parameters such as video IDs are preserved. Known credential query parameters cause capture rejection.

**These rules cannot identify every sensitive page or URL parameter.** Displayed text on an otherwise eligible page can contain personal information. Review the exclusion list in Settings and pause capture when needed. Adding an exclusion affects subsequent capture/import; it does not retrospectively erase previously stored material. Incognito captures are rejected by the worker. There is no cross-browser or cross-device collection.

## Retention and controls

- Main-content text is bounded at 8,000 characters per capture and removed after 30 days during startup, scheduled maintenance, or a pipeline run. Chrome must be running for scheduled cleanup. Chat excerpts use a bounded head and tail and limited refreshes.
- Unused embeddings older than 45 days are pruned when they are not needed by current topic memberships. Visit metadata, notes, topics, and derived records remain until deletion.
- Pause stops new capture, closes the current measurement interval, and prevents importing history from paused intervals. Search remains available. Pausing also ends any running session.
- **Record & privacy → Export JSON** creates a metadata snapshot without extracted page text, embedding vectors, or topic centroids. URLs, titles, personal notes, session records, and derived data remain in the export; handle it as private browsing history.
- **Delete everything** stops writers before deleting. On success the only retained controls are pause state and a history import cutoff. Capture remains paused until resumed; pre-deletion history is not imported again. Previously exported files and Ollama model downloads are outside the extension's database and are not deleted.

Timed session notifications contain only the app name and a generic completion message. They omit target labels, page titles, URLs and notes. Recaps remain local. Browser notification delivery depends on Chrome and OS permissions; the recap remains available if a notification cannot be shown. Deletion clears session alarms and notifications.

## Verify

Run `npm run e2e` in a disposable Chrome profile to check form exclusion, sensitive URLs, SPA routes, pause, final-write persistence, and deletion. `npm run e2e:pipeline` checks the extension/offscreen/local-model lifecycle. Inspect extension network requests during a run: inference calls should use localhost:11434. The manifest restricts extension `connect-src` to self and localhost/127.0.0.1 on that port. The Origin rewrite is restricted to this extension, not arbitrary websites.

Local storage is not separately encrypted. Someone with access to your unlocked browser profile can read it. Browser/OS backups can retain copies according to their own policies. The extension controls its own requests; a separately modified local inference service is outside that boundary.
