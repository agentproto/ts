# @agentproto/adapter-browser-camofox

## 0.2.5

### Patch Changes

- Updated dependencies [c6e0daa]
- Updated dependencies [5ab8114]
- Updated dependencies [5ab8114]
- Updated dependencies [c6e0daa]
  - @agentproto/driver-browser@0.4.0

## 0.2.4

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/driver-browser@0.3.1

## 0.2.3

### Patch Changes

- Updated dependencies [350e966]
- Updated dependencies [350e966]
  - @agentproto/driver-browser@0.3.0

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
