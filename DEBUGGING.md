# Debugging

This file is rewritten for v4 at the end of the build (Phase 6). Until then:

- `npm test` runs the Node suites.
- The audit page (`ui/audit.html`) shows run history, per-stage timings, and warnings once Phase 3+ lands.
- If Ollama returns `403 Forbidden` only from Chrome, check `rules_ollama.json` and the `declarativeNetRequest` permission — the extension rewrites local Ollama request origins so Ollama sees `http://localhost` / `http://127.0.0.1`.
