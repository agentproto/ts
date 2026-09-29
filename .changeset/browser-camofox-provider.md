---
"@agentproto/adapter-browser-camofox": minor
"@agentproto/adapter-browser": minor
---

New `@agentproto/adapter-browser-camofox`: a `camofox` provider for `@agentproto/driver-browser` with an idempotent `launch()` (a healthy server on the port is reused and never respawned), a `health()` that maps the camofox `/health` lifecycle fields (a 503 crash-looping answer is a state, not an error), a REST client that throws on non-2xx and sends an optional Bearer key that is never logged, and a `BrowserDriver` with typed-unsupported errors for CDP-only calls.

`@agentproto/adapter-browser` is now a compat facade over kit providers: `browserAdapters`, `getBrowserAdapter` and the new `toAdapterHandle` keep their shape for `camofox`, `bureau` and `chromium`. The chromium facade no longer falls back to a private `pnpm --filter` launch command; set `CHROMIUM_SERVE_CMD` or pass `launchCmd`.
