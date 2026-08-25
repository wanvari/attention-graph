# Debugging

Where to look when something is wrong, in the order worth checking.

## Start at the Audit page

`ui/audit.html` is the first stop for almost everything. It shows the run history with per-run status, the stage a failed run died at, its error, per-stage timings, counts (visits ingested, embedded vs cached, audited, excluded), warnings, registry state by lifecycle, the uncategorized bucket by reason, and which models Ollama currently has resident.

A run's `status` tells you most of what you need:

| Status | Meaning |
|---|---|
| `ok` | Completed; the watermark advanced. |
| `failed` | Died at `stage`; **the watermark did not move**, so the next run redoes the work. Safe by construction. |
| `abandoned` | Was `running` with a heartbeat older than 10 minutes when the service worker restarted — the offscreen document died mid-run (extension reload, browser quit). |
| `skipped` | An alarm fired while another run was in flight. Expected, not an error. |
| `running` with a fresh heartbeat | Actually running right now. |

## Nothing is being captured

1. Is capture paused? Check the new-tab status dot or Settings.
2. Is the page denylisted? The default list covers banks, health portals, password managers, auth, and webmail, plus any URL path containing `/checkout`, `/payment`, `/billing`, `/login`, `/signin`, `/password`, `/reset`. This is intentional.
3. Is it an ordinary `http(s)` page? The content script does not run on `chrome://`, the Web Store, PDFs, or other extensions' pages.
4. Open DevTools on the page and check `chrome.storage.local` for `ctPaused`.
5. Captures are buffered in the service worker and flushed every 2 minutes or every 50 updates. To force one, run this in an extension page console:
   ```js
   chrome.runtime.sendMessage({ type: 'FLUSH_CAPTURES' }, console.log)
   ```

**Known limitation, not a bug:** active time requires an input event within 60 seconds, so a long video watched without touching anything reads as inactive.

## Runs never start

The `daily` alarm fires hourly but a run needs all three of:

1. No successful run in 20 h, **or** ≥ 150 new visits since the watermark.
2. The machine idle for 2 minutes, or the local time between 02:00 and 05:00. (If this blocks for more than 36 h it runs anyway and logs a warning.)
3. Ollama reachable with **both** configured models present.

Condition 3 is the usual culprit. Check it directly:

```bash
curl -s http://localhost:11434/api/tags | grep -o '"name":"[^"]*"'
```

You need both `bge-m3:latest` and `gemma3:12b` (or whatever Settings names). **Run now** on the Audit page bypasses conditions 1 and 2 but never 3.

## Ollama returns 403 only from Chrome

Ollama rejects the `chrome-extension://` origin. The extension already rewrites the `Origin` header on local Ollama requests via `rules_ollama.json` and the `declarativeNetRequest` permission, so Ollama sees `http://localhost`. If you still get 403:

- Confirm `rules_ollama.json` is listed in `manifest.json` under `declarative_net_request` and the extension has been reloaded.
- As an alternative, set `OLLAMA_ORIGINS` to include the extension origin and restart Ollama.

## A run fails at a specific stage

- **`ingest`** — the `chrome.history` proxy through the service worker failed. Usually the SW was recycled mid-run; the next run retries. Persistent failure means the `history` permission is missing.
- **`embed`** — Ollama unreachable, or the embedding model is not pulled. Batches retry once before failing.
- **`label` / `adjudicate`** — a chat call failed. Note the distinction: *malformed JSON* from the model costs only that batch its labels (the run continues, clusters keep keyword labels), while a *transport* failure fails the run. If gemma is timing out, it is usually memory pressure — check whether both models are resident with `curl -s http://localhost:11434/api/ps`.
- **`registry`** — the one non-idempotent stage, written in a single transaction. If it fails, nothing was written; the next run recomputes from cached embeddings, which is cheap.

## The topic map is empty

The map reads the **registry**, not live history, and shows only topics with dwell inside the selected window. An empty map means either no successful run yet (check Audit) or no topic activity in that window — widen it to 90 days.

## Everything is landing in `uncategorized`

Check the reason breakdown on the Audit page:

- `no_content` — pages with no real title and no captured text. Working as intended.
- `thin_evidence` — one-page topics with under 2 minutes of attention.
- `beyond_budget` — the per-run cap of 20 new topics; retried next run.
- `disagreement` — the two adjudication passes disagreed. **A large number here is a signal worth investigating**, not routine. It historically meant the audit gate was firing on coherent clusters; the gate now triggers on cohesion below 0.70 rather than on domain diversity. If you see this at scale, compare the audited clusters' `cohesion` against the threshold in `lib/adjudicate.js`.

## Inspecting the database directly

DevTools → Application → IndexedDB → `cognitive-trails`. Or from any extension page console:

```js
const store = CTStore.createStore({});
await store.open();
console.table(await store.getAll('runs'));
console.table(await store.getAll('topics'));
console.table(await store.getAll('uncategorized'));
```

## Reproducing without Chrome

Most logic is testable in Node against the committed fixtures:

```bash
npm test                                  # everything except e2e
node -e "require('./tests/helpers/pipelineHarness.js').makeEnv().then(async env => {
  console.log(await env.runThroughDay(7));
})"
```

The harness gives you a full pipeline over 384 fixture pages with a scripted model and the committed real embeddings — no Ollama needed. `tests/protocol/golden.test.js` replays a recorded real `gemma3:12b` transcript; if it fails with *"prompt hash not in golden index"*, a prompt changed and the golden needs re-recording with `node tools/recordGolden.js`.

## Performance

`node tools/bench.js` (needs Ollama) reports per-stage timings and polls `/api/ps` to confirm the two models are not resident together for more than a minute. Budget: a full first run under 5 minutes, an incremental day under 2.
