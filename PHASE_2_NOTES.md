# Phase 2 Notes — Sensor

## Done
- `lib/privacy.js`: default denylist (banks/health/password managers/auth/mail + sensitive path parts), wildcard matching, LLM-chat source tagging (local UIs off by default), filtered domains, pause-interval helpers. Unit-tested (`tests/unit/privacy.test.js`); malformed URLs fail closed.
- `content/capture.js`: active time (visible + focused + input within 60 s, 1 s tick, 30 min cap), scroll depth (tick + input events), §2.6 text extraction (root priority, skip lists, never form/contenteditable values, ≤ 200 getComputedStyle checks, 20k node walk cap, one late-render re-extract), SPA detection via 1 s URL poll (isolated-world pushState patching does not see page JS — polling is the reliable route), idempotent CAPTURE_UPDATE transport with text-sent-once, retry-once-then-drop.
- `background.js`: capture buffering (flush alarm 2 min / 50 updates), pause switch writing `settings.pauseIntervals` + `chrome.storage.local` mirror, §1.3 scheduling (20 h / 150 visits, idle-or-02:00–05:00 gate with 36 h anti-starvation, Ollama health), offscreen lifecycle with exists-check and running-heartbeat skip (records `skipped` runs), abandoned-run sweep on startup, notifications (≤ 1/day, kinds 2–4 only, off by default), `navigator.storage.persist()`.
- `manifest.json` v4: content script (lib/text + lib/privacy + capture, document_idle, top frame only), newtab override, permissions per §2.1.
- E2E (`npm run e2e`, Playwright + real Chromium, headed): activeMs tolerance, main-content extraction excluding nav/footer, form values never captured, scroll depth, claude.ai → `llm_chat` via --host-resolver-rules, denylist + /login exclusion, SPA double capture with `isSpaNavigation`, < 50 ms extraction on a 5,000-node DOM, pause/resume. All green.

## Decisions / deviations
- Suite runs **headed**: `document.hasFocus()` (part of the active-time definition) is unreliable in headless Chromium. Local-only suite, so acceptable.
- Send cadence gates on **visibility**, not activity, so a visible-but-idle page still reports scroll depth; hidden tabs stay silent. Loss bound unchanged.
- After an SPA navigation the successor capture announces itself immediately (first message carries its text) instead of waiting for the next cadence window.
- `TEST_FIRE_ALARM` / `TEST_SET_SETTING` messages exist for §7.7 and are gated on `settings.testMode` (and a key allowlist).

## Manual acceptance still owed (needs a real browsing day)
- "A full day of real browsing produces sane activeMs vs a stopwatch on 3 pages" — to be checked once the extension is loaded in the daily browser.
