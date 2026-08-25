# Phase 4 Notes — Scheduling and lifetime

## Done
- `chrome.alarms`: `daily` every 60 min, `flush` every 2 min, (re)created on both `onInstalled` and `onStartup`.
- Gating per §1.3: a run needs (no successful run in 20 h **or** ≥ 150 new visits since the watermark) **and** (machine idle for 120 s, or local time 02:00–05:00, or idle gating disabled in Settings) **and** Ollama healthy with both configured models. **Run now** on the Audit page bypasses the first two, never the third.
- Anti-starvation: if gating has blocked a run for more than 36 h, the next fire runs anyway and logs a warning, so a machine that is never idle does not starve.
- Offscreen lifecycle: `createDocument` failures fall back to `getContexts` and message the existing document. A run whose `runs` row is `running` with a heartbeat under 60 s old causes the alarm to record a `skipped` row instead of starting a second run.
- Abandoned-run recovery: on service-worker startup, any `running` row with a heartbeat older than 10 minutes becomes `abandoned`.
- The offscreen document proxies `chrome.history` through the service worker (it cannot call the API directly); each proxy message also keeps the SW alive during a long run.
- `tests/e2e/pipeline.e2e.mjs` covers the last three §7.7 bullets against real Chrome with live Ollama, all green: alarm-triggered full run (visits, pages, embeddings, metrics and brief written; offscreen document closes itself), stale `running` row swept to `abandoned` without blocking a rerun, and a second run request while one is in flight recorded as `skipped`.

## A gap the e2e suite exposed

`markAbandonedRuns()` was wired only to `onInstalled` and `onStartup`. Neither fires when Chrome merely recycles the service worker, which is the common case — so a run abandoned by a service-worker death would have stayed `running` in the audit until the next browser restart. It is now swept at the top of `dailyAlarmFired()`, before any due-check can return early, and again in `startPipeline()`. Those are the moments a stale row actually matters.

Note that a stale row never *blocked* anything: `pipelineIsRunning()` only treats a run as in flight when its heartbeat is under 60 s old. The bug was in the honesty of the record, not in the scheduling.

## Decisions / deviations
- §7.7 suggests testing abandoned-run recovery by injecting `chrome.runtime.reload()`. That is not usable here: an extension loaded with `--load-extension` never comes back in a Playwright persistent context (every subsequent navigation returns `ERR_BLOCKED_BY_CLIENT`). The suite instead exercises the sweep that a real service-worker restart triggers, which is the mechanism under test; a genuine browser-restart recovery remains manual.
- `TEST_FIRE_ALARM` and `TEST_SET_SETTING` message handlers exist for the e2e suite. Both are gated on `settings.testMode`, and `TEST_SET_SETTING` additionally restricts writes to an explicit key allowlist, so neither can be used to reconfigure a real install.
- Notifications are wired but default off, fire at most once per day, only after a successful run, and only when the brief contains a revival, dormancy, or convergence item (spec §5.4).

## Not yet done — needs calendar time, not code
- **Three consecutive nights of unattended runs on the M3** (`runs.status='ok'`, no `abandoned` rows, fan off during the day). This is the one Phase 4 acceptance criterion that cannot be simulated; it needs the extension loaded in the daily browser for three days. The mechanism is covered by the e2e suite; what remains untested is real MV3 lifetime behaviour over real overnight idle.
