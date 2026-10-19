# @agentproto/adapter-browser

## 0.8.0

### Minor Changes

- e9e2cb5: `chrome-live` gains two agent-surface features, exposed as new MCP tools in `@agentproto/runtime`:

  - **File upload onto a real `<input type=file>`** — `browser_upload_file { sessionId, selector, paths, tabId? }` attaches local files through CDP `DOM.querySelector` + `DOM.setFileInputFiles` (the same mechanism devtools uses; the input is fed, never written back out). Every path must be absolute+existing and live inside an upload allowlist: the agent's workspace + `~/.pygmalion/data` by default, extendable via `AGENTPROTO_BROWSER_UPLOAD_ALLOW_DIRS` (a `:`-separated dir list). Outside the allowlist → typed refusal, the driver is never touched.
  - **Several tabs in the agent's own window** — `browser_new_tab { sessionId, url? }` opens a FRESH tab (the same activate-anchor → `Target.createTarget` → `getWindowForTarget` flow as the first tab, never a reuse, never the user's windows), `browser_list_tabs { sessionId }` lists the agent-owned tabs (`{ targetId, url, windowId }[]`), and every existing browser tool already accepts those `tabId`s.

  `ChromeLiveInstance` grew `uploadFileOwnedTarget` / `newTabOwnedTarget` / `listOwnedTabs`; `evalRaw` on `ChromeCdpDriver` became `protected` so the live driver can probe the file input first (`no <input type=file> matches selector …`).

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [e9e2cb5]
- Updated dependencies [cf6085d]
- Updated dependencies [e9e2cb5]
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/adapter-browser-chrome@0.7.0
  - @agentproto/adapter-browser-camofox@0.2.4
  - @agentproto/adapter-browser-chromium@0.2.4
  - @agentproto/browser-process@0.2.1
  - @agentproto/driver-browser@0.3.1

## 0.7.0

### Minor Changes

- 345cf99: chrome-live gains the read AND control path that `start_browser` always lacked, all addressing the same agent-OWNED tab (never a foreign one): `navigateOwnedTarget`/`domOwnedTarget` (read) plus new `clickOwnedTarget`/`fillOwnedTarget`/`evaluateOwnedTarget`/`scrollOwnedTarget` (control) — the latter four thin dispatches onto the same owned driver's existing `click`/`fill`/`evaluate` (scroll has no driver primitive of its own; it's an `evaluate` of a generated `scrollIntoView`/`scrollTo` expression). All six go through the same ownership guard as `screenshotOwnedTarget`. `@agentproto/adapter-browser`'s `BrowserAdapterInstance` exposes these as optional `navigate`/`getDom`/`click`/`fill`/`evaluate`/`scroll`, wired for chrome-live — the bridge fills in the kit's required option fields (`trusted`, `clear`, `awaitPromise`, ...) that this facade's simpler surface leaves optional.

  `@agentproto/runtime` adds eight MCP tools, all ONE model (the agent's owned tab): `fetch_page` (plain HTTP read, no browser — `{ title, text, url, blocked }`, `blocked: true` on a 403/429/503/401/407 or a known anti-bot challenge fingerprint from Cloudflare/Akamai/PerimeterX/Datadome/Incapsula) and chrome-live-only `browser_navigate` / `browser_extract_text` / `browser_get_dom` / `browser_click` / `browser_fill` / `browser_evaluate` / `browser_scroll`. `browser_extract_text` and `fetch_page` both purify their HTML with a small Defuddle wrapper (`page-text.ts`) — mirrors `@agentproto/bureau-purify`'s approach rather than depending on it, so the daemon's core runtime stays free of a dependency on a downstream product package; `browser_get_dom` returns the raw serialized DOM for selector discovery instead.

  Resolves a name collision the review caught: the existing, currently-unused `projectBrowserTools` (`browser-projection.ts`) projected a DIFFERENT model (one whole attached instance, no per-agent tab ownership) onto the SAME `browser_navigate`/`browser_click`/`browser_fill`/`browser_evaluate`/`browser_screenshot`/`browser_get_dom` names. Its tools are renamed `browser_kit_*` (capability-gate ids are unchanged — each `ToolSpec` now carries its own `gateId` rather than deriving one from `name`) so the two surfaces can never collide if `projectBrowserTools` ever gets mounted.

- 350e966: `chrome-live` gains a `cookieSource` seam (`ChromeLiveProviderConfig.cookieSource`, same `BrowserCookieSource` shape `chrome` already uses) that injects cookies through `Network.setCookies` into ONLY the dedicated, zero-consent Chrome this provider auto-launches — the user's own, attached-to Chrome stays read-only exactly as before. Injection runs on every `attach()` of a dedicated instance, is filtered to the launch's `domains` option (both by the source's own request and, belt-and-suspenders, by this package again), and never logs a cookie value, only a count. This package has no opinion on where cookies come from or who may grant them: `cookieSource` is a pure injection point, no selection or consent logic lives here.

  `BrowserCookieSource`'s request shape (`@agentproto/driver-browser`) grows two optional fields, `domains` and `chromeProfile`, additive and ignored by existing callers (e.g. `chrome`'s own cookie source).

  `@agentproto/adapter-browser` adds `chromeProfile`/`domains` to `BrowserAdapterStartOptions` (chrome-live only, ignored by every other adapter) and a new `createChromeLiveAdapter(config)` factory so a host can build its own `chrome-live` adapter handle over a custom `ChromeLiveProviderConfig` (e.g. with a concrete `cookieSource`) without touching the default `chromeLiveAdapter` singleton, which ships with no `cookieSource` configured.

  `@agentproto/runtime`'s `start_browser` MCP tool grows matching `chromeProfile`/`domains` parameters, forwarded verbatim into the resolved adapter's `ensure()` — chrome-live only, every other adapter ignores them.

- 6e75183: chrome-live now prefers the dedicated, zero-consent Chrome by DEFAULT: a bare `launch({})` launches (or reuses, hot) its own headful Chrome immediately, with no attempt to attach to the user's own Chrome and no consent wait. Attaching to the user's real, logged-in Chrome through the remote debugging toggle (port 9222) now requires an explicit ask — a pinned `wsUrl`/`port` (launch opts, provider config, or `CHROME_LIVE_*` env), or the new `attachIntent: true` launch option — and, as before, falls back to the dedicated Chrome if that attach is not possible. The new `preferDedicated` provider-config flag (`false` restores the old attach-first default for every call on that provider instance) and the new `attachIntent` launch option are both opt-in surfaces; existing callers that already pin an endpoint are unaffected. Two new pure helpers, `pinnedEndpoint` and `wantsAttachFirst`, are exported for testing the routing decision without touching a real Chrome.

  `@agentproto/adapter-browser` (the kit's `chrome-live` adapter description, `browser_adapter_list`) gets the `BrowserAdapterStartOptions.profile` field (`"dedicated" | "personal"`, mapped to `attachIntent` for chrome-live, ignored by every other adapter) alongside its doc-only patch. `@agentproto/runtime`'s `start_browser` MCP tool grows the matching `profile` parameter — an agent asks for `"personal"` only when it needs to see something from the user's own accounts, `"dedicated"` (default) otherwise — on top of its doc-only patch.

- c265752: chrome-live now falls back to auto-launching a dedicated headful Chrome when the remote-debugging toggle is not attachable on the default endpoint (9222). The launched browser runs on a free port with its own persisted user-data-dir (`~/.agentproto/browser/chrome/live`, override `CHROME_LIVE_LAUNCH_DATA_DIR`), requires no consent click, and is tracked so that `stop()` kills only that pid — attach-to-9222 stays the preferred path and the user's own Chrome is never signalled. An explicitly pinned endpoint (launch `wsUrl`/`port`, provider config, or `CHROME_LIVE_*` env) disables the fallback.
- 345cf99: chrome-live gains the read AND control path that `start_browser` always lacked, all addressing the same agent-OWNED tab (never a foreign one): `navigateOwnedTarget`/`domOwnedTarget` (read) plus `clickOwnedTarget`/`fillOwnedTarget`/`evaluateOwnedTarget`/`scrollOwnedTarget` (control) — the latter four dispatch onto the same owned driver's `click`/`fill`/`evaluate` (scroll is an `evaluate` of a generated `scrollIntoView`/`scrollTo` expression). All six go through the same ownership guard as `screenshotOwnedTarget`. `navigateOwnedTarget` now reads back the committed `document.location.href` (best-effort) so its returned url reflects redirects. `@agentproto/adapter-browser` exposes these as optional `navigate`/`getDom`/`click`/`fill`/`evaluate`/`scroll` on `BrowserAdapterInstance`, wired for chrome-live.

  `@agentproto/runtime` adds the owned-tab MCP tools `fetch_page` (plain HTTP read, `{ title, text, url, blocked }`), `browser_navigate`, `browser_extract_text`, `browser_get_dom`, `browser_click`, `browser_fill`, `browser_evaluate`, `browser_scroll`. `fetch_page`/`browser_extract_text` purify HTML via a small Defuddle wrapper (`page-text.ts`); anti-bot detection is narrowed to challenge-only fingerprints so ordinary vendor-fronted pages no longer report `blocked`. The unused `projectBrowserTools` surface is renamed to `browser_kit_*` (with explicit per-`ToolSpec` `gateId`s) so it can never collide with the owned-tab tool names.

- 350e966: `chrome-live` gains a `cookieSource` seam (`ChromeLiveProviderConfig.cookieSource`) that injects granted cookies through `Network.setCookies` into only the dedicated, zero-consent Chrome this provider auto-launches; the user's own attached-to Chrome stays read-only. Injection is filtered to the launch's `domains` option and never logs cookie values.

  `BrowserCookieSource`'s request shape (`@agentproto/driver-browser`) grows two optional, additive fields, `domains` and `chromeProfile`.

  `@agentproto/adapter-browser` adds `chromeProfile`/`domains` to `BrowserAdapterStartOptions` and a new `createChromeLiveAdapter(config)` factory, and re-exports `chromeLiveLaunchOptionsFrom`.

  `@agentproto/runtime`'s `start_browser` MCP tool grows matching `chromeProfile`/`domains` parameters, forwarded verbatim into the resolved adapter's `ensure()`.

### Patch Changes

- Updated dependencies [345cf99]
- Updated dependencies [350e966]
- Updated dependencies [6e75183]
- Updated dependencies [c265752]
- Updated dependencies [6e75183]
- Updated dependencies [345cf99]
- Updated dependencies [350e966]
  - @agentproto/adapter-browser-chrome@0.6.0
  - @agentproto/driver-browser@0.3.0
  - @agentproto/adapter-browser-camofox@0.2.3
  - @agentproto/adapter-browser-chromium@0.2.3

## 0.6.1

### Patch Changes

- Updated dependencies [65b571e]
  - @agentproto/adapter-browser-chrome@0.5.1

## 0.6.0

### Minor Changes

- d6ccf1f: Add chrome-live screencast for live view and recording of agent's tab

### Patch Changes

- Updated dependencies [d6ccf1f]
  - @agentproto/adapter-browser-chrome@0.5.0

## 0.5.0

### Minor Changes

- e296593: Route Chrome Live screenshots and health checks through its provider.

### Patch Changes

- Updated dependencies [e296593]
  - @agentproto/adapter-browser-chrome@0.4.0

## 0.4.0

### Minor Changes

- 3c5c88f: Add the `chrome-live` browser provider: it attaches to the user's already running Chrome through the remote debugging toggle (chrome://inspect/#remote-debugging) over one memoized websocket, works in its own window, only addresses targets it created, never sends `Browser.close`, and keeps cookies read-only. Typed errors `browser:remote-debugging-off`, `browser:consent-timeout` and `browser:disconnected`. The `@agentproto/adapter-browser` facade registers it as the `chrome-live` adapter.
- 3c5c88f: Add the `chrome-live` browser provider (attaches to the user's running Chrome via the remote debugging toggle) and register it in the `@agentproto/adapter-browser` facade. `@agentproto/runtime` only gets docs and test updates.

### Patch Changes

- Updated dependencies [3c5c88f]
- Updated dependencies [3c5c88f]
  - @agentproto/adapter-browser-chrome@0.3.0

## 0.3.2

### Patch Changes

- @agentproto/driver-browser@0.2.2
- @agentproto/adapter-browser-camofox@0.2.2
- @agentproto/adapter-browser-chromium@0.2.2

## 0.3.1

### Patch Changes

- @agentproto/driver-browser@0.2.1
- @agentproto/adapter-browser-camofox@0.2.1
- @agentproto/adapter-browser-chromium@0.2.1

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
