# @agentproto/adapter-browser-camofox

## 0.2.2

### Patch Changes

- @agentproto/driver-browser@0.2.2

## 0.2.1

### Patch Changes

- @agentproto/driver-browser@0.2.1

## 0.2.0

### Minor Changes

- a68d1d6: Publish the browser stack packages that consumer apps depend on. Camofox, Chrome and Chromium browser providers, the browser session/profile model, the BrowserDriver, and the embedded pairing-host library are now published to npm under their existing public versions; adapter-browser, browser-process, driver, secrets and workflow-runtime carry forward their current versions so dependent bumps resolve.

### Patch Changes

- Updated dependencies [a68d1d6]
  - @agentproto/driver-browser@0.2.0

## 0.1.0

### Minor Changes

- 84f5782: New `@agentproto/adapter-browser-camofox`: a `camofox` provider for `@agentproto/driver-browser` with an idempotent `launch()` (a healthy server on the port is reused and never respawned), a `health()` that maps the camofox `/health` lifecycle fields (a 503 crash-looping answer is a state, not an error), a REST client that throws on non-2xx and sends an optional Bearer key that is never logged, and a `BrowserDriver` with typed-unsupported errors for CDP-only calls.

  `@agentproto/adapter-browser` is now a compat facade over kit providers: `browserAdapters`, `getBrowserAdapter` and the new `toAdapterHandle` keep their shape for `camofox`, `bureau` and `chromium`. The chromium facade no longer falls back to a private `pnpm --filter` launch command; set `CHROMIUM_SERVE_CMD` or pass `launchCmd`.

### Patch Changes

- Updated dependencies [439110f]
- Updated dependencies [f2678e0]
- Updated dependencies [0aa2d28]
- Updated dependencies [1f789a2]
  - @agentproto/driver-browser@0.1.0
