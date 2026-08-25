# Privacy

Cognitive Trails reads a lot: every page you visit, and the text on it. That is only defensible if the data never leaves your machine and you can verify that claim yourself. This document is the verification procedure.

## The trust boundary

The extension's content security policy permits exactly three connect targets:

```
connect-src 'self' http://localhost:11434 http://127.0.0.1:11434
```

There is no analytics, no error reporting, no update ping, no CDN. A change that adds any remote host is a change to the product's premise, not a detail.

## What is stored, and where

Everything lives in one IndexedDB database, `cognitive-trails`, in your Chrome profile. Nothing is written anywhere else except a few flags in `chrome.storage.local` (pause state and the denylist, which the content script needs to read cheaply on every page load).

| Store | Contents |
|---|---|
| `visits` | One row per Chrome visit event: url, title, time, estimated dwell. |
| `captures` | Per page load: active time, scroll depth, text hash, and up to 8,000 characters of page text. |
| `pages`, `topics`, `memberships`, `topic_events` | The topic registry and its history. |
| `embeddings` | Local vectors from your own Ollama, keyed by content hash. |
| `daily_metrics`, `baselines`, `transitions`, `uncategorized`, `briefs`, `runs` | Derived record. |

## What is never captured

Evaluated in the content script **before** anything is collected — excluded pages send no message at all:

- **Form contents.** The extractor never reads `input`, `textarea`, `select`, or `contenteditable` values. Verified by an end-to-end test that loads a page containing a known secret string in an input and asserts it is absent from the stored capture.
- **Denylisted sites**, seeded with banks and brokerages, health portals (`*mychart*`), password managers, auth providers, and webmail. Editable in Settings.
- **Sensitive URL paths**: any path containing `/checkout`, `/payment`, `/billing`, `/login`, `/signin`, `/password`, `/reset`.
- **Incognito.** Content scripts do not run in incognito unless you explicitly enable it — don't. The service worker also drops any capture arriving from an incognito tab as a second line of defence.
- **Anything while paused.** The pause switch stops capture *and* records the interval, so history from that window is excluded from analysis too. It is not merely a UI toggle.

## Retention

- Page **text** is deleted from captures older than **30 days**. The embedding is already computed and cached, so the text has no further use. Aggregates (active time, scroll depth, hash) are kept.
- **Embeddings** unused for 45 days *and* belonging to no current topic membership are pruned.
- **Delete everything** in Settings wipes the IndexedDB database and `chrome.storage.local`, behind a two-step confirmation.
- **Export JSON** deliberately omits `extractedText` and the raw centroid vectors.

## Verifying it yourself

1. **Watch the network.** Open `chrome://net-export/`, start logging, trigger a run from the Audit page, stop, and inspect the capture. The only destination should be `localhost:11434`.
2. **Grep the source.**
   ```bash
   grep -rn "https://" lib/ ui/ content/ background.js offscreen/
   ```
   Expect only the CSP line, `xmlns` SVG namespace declarations, and fixture URLs — no request targets.
3. **Check an export.** Audit → Export JSON, then search the file for a sentence you know was on a page you visited. It should not be there.
4. **Check a delete.** Audit → Delete everything, then look at DevTools → Application → IndexedDB and Local Storage. Both should be empty.
5. **Confirm form data is absent.** `npm run e2e` includes this as an assertion, or do it by hand: type a distinctive string into a form, then search the `captures` store for it in DevTools.

## Where the risk actually is

Being straight about this:

- The extension holds host permissions for all http(s) sites. That is a real capability, and the reason to read the source rather than take the README's word.
- Page text sits unencrypted in IndexedDB for up to 30 days. Anyone with access to your unlocked machine and profile can read it. It is exactly as protected as your browser history already is — no more.
- Local models are still models. Page text is sent to Ollama on your own machine; if you have configured Ollama to forward elsewhere, that is outside this extension's control and its guarantees.
