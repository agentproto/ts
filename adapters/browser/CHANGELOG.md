# @agentproto/adapter-browser

## 0.3.0

### Minor Changes

- a68d1d6: Publish the browser stack packages that consumer apps depend on. Camofox, Chrome and Chromium browser providers, the browser session/profile model, the BrowserDriver, and the embedded pairing-host library are now published to npm under their existing public versions; adapter-browser, browser-process, driver, secrets and workflow-runtime carry forward their current versions so dependent bumps resolve.

### Patch Changes

- Updated dependencies [a68d1d6]
  - @agentproto/adapter-browser-camofox@0.2.0
  - @agentproto/adapter-browser-chromium@0.2.0
  - @agentproto/driver-browser@0.2.0
  - @agentproto/browser-process@0.2.0

## 0.2.0

### Minor Changes

- 84f5782: New `@agentproto/adapter-browser-camofox`: a `camofox` provider for `@agentproto/driver-browser` with an idempotent `launch()` (a healthy server on the port is reused and never respawned), a `health()` that maps the camofox `/health` lifecycle fields (a 503 crash-looping answer is a state, not an error), a REST client that throws on non-2xx and sends an optional Bearer key that is never logged, and a `BrowserDriver` with typed-unsupported errors for CDP-only calls.

  `@agentproto/adapter-browser` is now a compat facade over kit providers: `browserAdapters`, `getBrowserAdapter` and the new `toAdapterHandle` keep their shape for `camofox`, `bureau` and `chromium`. The chromium facade no longer falls back to a private `pnpm --filter` launch command; set `CHROMIUM_SERVE_CMD` or pass `launchCmd`.

- f2678e0: New `@agentproto/adapter-browser-chromium`: a `chromium` provider that drives Playwright Chromium on its own dedicated profile dir, with an idempotent `launch()`, CDP endpoint, network capture with response bodies, screenshots and cookie injection. `playwright-core` is loaded lazily, so importing the package needs no browser; install one with `npx playwright install chromium`.

  New `@agentproto/adapter-browser-chrome`: a `chrome` provider that finds the system Chrome (`CHROME_EXECUTABLE_PATH`, then the standard per-OS paths), launches it with `--remote-debugging-port=0` on a fresh dedicated user-data-dir, attaches over CDP and injects granted cookies through `Network.setCookies` (the cookie source is a parameter).

  Both providers never use the default Chrome user-data-dir (Chrome 136+ refuses the debugging port there). A request for it, for a real profile name, for `--full-profile`, or for a `--user-data-dir` / `--remote-debugging-*` override is refused with the typed error `browser:profile-refused`.

  `@agentproto/adapter-browser`: the `chromium` facade id is now backed by the real Playwright provider instead of managing a service process. `resolveCmd` stays exported. `browserAdapters`, `getBrowserAdapter` and `toAdapterHandle` keep their shape. The `chromium` manifest now prompts for `CHROMIUM_EXECUTABLE_PATH` instead of `CHROMIUM_SERVE_CMD`.

### Patch Changes

- Updated dependencies [84f5782]
- Updated dependencies [f2678e0]
- Updated dependencies [439110f]
- Updated dependencies [f2678e0]
- Updated dependencies [0aa2d28]
- Updated dependencies [1f789a2]
  - @agentproto/adapter-browser-camofox@0.1.0
  - @agentproto/adapter-browser-chromium@0.1.0
  - @agentproto/driver-browser@0.1.0

## 0.1.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/browser-process@0.1.2

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/browser-process@0.1.1

## 0.1.0

### Minor Changes

- e33d99a: start_browser no longer blocks the MCP request during a cold start — heavy services (chromium/bureau) register immediately as `starting` and converge to healthy in the background; opt-in via BrowserProcessSpec.initialWaitMs, default behavior unchanged.
- 6738ef9: Surface adapter manifest (location/install/config) over MCP; add binPath to start_browser
- cfbeb8f: Browser-as-adapter stack: adapter-browser, browser-process primitive, `agentproto browser` CLI

### Patch Changes

- 8a24b4b: Fix chromium adapter pnpm filter to use correct @agstudio/browser-service package name
- Updated dependencies [e33d99a]
- Updated dependencies [cfbeb8f]
  - @agentproto/browser-process@0.1.0
