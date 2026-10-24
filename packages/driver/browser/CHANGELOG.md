# @agentproto/driver-browser

## 0.3.2

### Patch Changes

- Updated dependencies [76003b9]
  - @agentproto/provider-kit@0.5.0

## 0.3.1

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4
  - @agentproto/provider-kit@0.4.7
  - @agentproto/tool@0.5.2

## 0.3.0

### Minor Changes

- 350e966: `chrome-live` gains a `cookieSource` seam (`ChromeLiveProviderConfig.cookieSource`, same `BrowserCookieSource` shape `chrome` already uses) that injects cookies through `Network.setCookies` into ONLY the dedicated, zero-consent Chrome this provider auto-launches — the user's own, attached-to Chrome stays read-only exactly as before. Injection runs on every `attach()` of a dedicated instance, is filtered to the launch's `domains` option (both by the source's own request and, belt-and-suspenders, by this package again), and never logs a cookie value, only a count. This package has no opinion on where cookies come from or who may grant them: `cookieSource` is a pure injection point, no selection or consent logic lives here.

  `BrowserCookieSource`'s request shape (`@agentproto/driver-browser`) grows two optional fields, `domains` and `chromeProfile`, additive and ignored by existing callers (e.g. `chrome`'s own cookie source).

  `@agentproto/adapter-browser` adds `chromeProfile`/`domains` to `BrowserAdapterStartOptions` (chrome-live only, ignored by every other adapter) and a new `createChromeLiveAdapter(config)` factory so a host can build its own `chrome-live` adapter handle over a custom `ChromeLiveProviderConfig` (e.g. with a concrete `cookieSource`) without touching the default `chromeLiveAdapter` singleton, which ships with no `cookieSource` configured.

  `@agentproto/runtime`'s `start_browser` MCP tool grows matching `chromeProfile`/`domains` parameters, forwarded verbatim into the resolved adapter's `ensure()` — chrome-live only, every other adapter ignores them.

- 350e966: `chrome-live` gains a `cookieSource` seam (`ChromeLiveProviderConfig.cookieSource`) that injects granted cookies through `Network.setCookies` into only the dedicated, zero-consent Chrome this provider auto-launches; the user's own attached-to Chrome stays read-only. Injection is filtered to the launch's `domains` option and never logs cookie values.

  `BrowserCookieSource`'s request shape (`@agentproto/driver-browser`) grows two optional, additive fields, `domains` and `chromeProfile`.

  `@agentproto/adapter-browser` adds `chromeProfile`/`domains` to `BrowserAdapterStartOptions` and a new `createChromeLiveAdapter(config)` factory, and re-exports `chromeLiveLaunchOptionsFrom`.

  `@agentproto/runtime`'s `start_browser` MCP tool grows matching `chromeProfile`/`domains` parameters, forwarded verbatim into the resolved adapter's `ensure()`.

## 0.2.2

### Patch Changes

- Updated dependencies [ab367ec]
  - @agentproto/tool@0.5.1

## 0.2.1

### Patch Changes

- Updated dependencies [5b021a8]
  - @agentproto/tool@0.5.0

## 0.2.0

### Minor Changes

- a68d1d6: Publish the browser stack packages that consumer apps depend on. Camofox, Chrome and Chromium browser providers, the browser session/profile model, the BrowserDriver, and the embedded pairing-host library are now published to npm under their existing public versions; adapter-browser, browser-process, driver, secrets and workflow-runtime carry forward their current versions so dependent bumps resolve.

### Patch Changes

- Updated dependencies [4243c75]
  - @agentproto/tool@0.4.0

## 0.1.0

### Minor Changes

- 439110f: Add consent, grants and a ledger to `@agentproto/browser-profiles`. Cookie import now needs explicit registrable domains (wildcards, bare TLDs, leading dots and empty lists throw typed errors), per-domain consent through an injected `prompt`, and a sink acknowledgement for remote sinks. Grants are scoped per paired device. Every grant, revoke, sink acknowledgement and agent denial is appended to a hash-chained `consent.jsonl` (file 0600, directory 0700) that never holds a cookie value. Revoke deletes the derived cookies and session state. `runDoctor` classifies a blocked Cookies db as missing Full Disk Access and names the binary, and only touches the Keychain on request. An agent surface can refresh and revoke but not grant, add a domain or change profile.

  `@agentproto/driver-browser`: `--full-profile` unlocks only with an active recorded full-profile grant (`FullProfileGrantProof`), and still never targets the default user-data-dir. `@agentproto/adapter-browser-chrome` and `@agentproto/adapter-browser-chromium` pass the proof through, and the chromium provider accepts a grant-backed `cookieSource`. `@agentproto/plugin-local-browser`: the profile clone now runs only after an explicit full-profile grant (`setup --full-profile`, plus `--yes` when non-interactive) and `revoke` deletes the clone.

- f2678e0: Add the F11 profile guard: `BrowserProfileRefusedError` (code `browser:profile-refused`), `resolveDedicatedProfileDir`, `isDefaultChromeUserDataDir`, `assertNoOwnedArgs`, `assertSpawnArgsSafe` and `liveProfileLockPid`, so providers never launch against or attach to a default Chrome user-data-dir. Add the cookie helpers `browserCookieSchema`, `cookiesFromSessionPayload` and the `BrowserCookieSource` type. `runConformance` now passes `fixture.url` as `initialUrl` when it attaches each level's driver.
- 0aa2d28: Add the browser supervisor and the conformance kit to `@agentproto/driver-browser`. `createBrowserSupervisor`: health loop over `BrowserInstance.health()`, a launch-loop detector (N failed starts in a window flips to `crash-looping` and stops retrying until an explicit `restart()`; a slow launch inside the launch budget is not a failure), `onBackendRestart` on a `bootId` change, and orphan sweep by process marker behind an injected process lister. `KeepAlivePolicy`: idle tab reaper that never closes a keepAlive session's tabs, plus an idle-browser-shutdown gate that refuses while a keepAlive session exists. `runConformance(provider, { levels })` with levels `core | interaction | network | download | profile`, a per-level per-check report, unsupported capabilities skipped with `browser:unsupported`, an in-memory fake provider (with injectable faults) and a fake remote provider server for `location: "remote"` conformance.
- 1f789a2: Add @agentproto/driver-browser: browser provider kit (defineBrowser, ports, registry, capability gate)

### Patch Changes

- Updated dependencies [88f2836]
- Updated dependencies [461df5e]
  - @agentproto/provider-kit@0.4.6
  - @agentproto/define-doctype@0.1.3
  - @agentproto/tool@0.3.2
