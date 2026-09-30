# @agentproto/adapter-browser-chrome

## 0.2.0

### Minor Changes

- a68d1d6: Publish the browser stack packages that consumer apps depend on. Camofox, Chrome and Chromium browser providers, the browser session/profile model, the BrowserDriver, and the embedded pairing-host library are now published to npm under their existing public versions; adapter-browser, browser-process, driver, secrets and workflow-runtime carry forward their current versions so dependent bumps resolve.

### Patch Changes

- Updated dependencies [a68d1d6]
  - @agentproto/driver-browser@0.2.0

## 0.1.0

### Minor Changes

- f2678e0: New `@agentproto/adapter-browser-chromium`: a `chromium` provider that drives Playwright Chromium on its own dedicated profile dir, with an idempotent `launch()`, CDP endpoint, network capture with response bodies, screenshots and cookie injection. `playwright-core` is loaded lazily, so importing the package needs no browser; install one with `npx playwright install chromium`.

  New `@agentproto/adapter-browser-chrome`: a `chrome` provider that finds the system Chrome (`CHROME_EXECUTABLE_PATH`, then the standard per-OS paths), launches it with `--remote-debugging-port=0` on a fresh dedicated user-data-dir, attaches over CDP and injects granted cookies through `Network.setCookies` (the cookie source is a parameter).

  Both providers never use the default Chrome user-data-dir (Chrome 136+ refuses the debugging port there). A request for it, for a real profile name, for `--full-profile`, or for a `--user-data-dir` / `--remote-debugging-*` override is refused with the typed error `browser:profile-refused`.

  `@agentproto/adapter-browser`: the `chromium` facade id is now backed by the real Playwright provider instead of managing a service process. `resolveCmd` stays exported. `browserAdapters`, `getBrowserAdapter` and `toAdapterHandle` keep their shape. The `chromium` manifest now prompts for `CHROMIUM_EXECUTABLE_PATH` instead of `CHROMIUM_SERVE_CMD`.

- 439110f: Add consent, grants and a ledger to `@agentproto/browser-profiles`. Cookie import now needs explicit registrable domains (wildcards, bare TLDs, leading dots and empty lists throw typed errors), per-domain consent through an injected `prompt`, and a sink acknowledgement for remote sinks. Grants are scoped per paired device. Every grant, revoke, sink acknowledgement and agent denial is appended to a hash-chained `consent.jsonl` (file 0600, directory 0700) that never holds a cookie value. Revoke deletes the derived cookies and session state. `runDoctor` classifies a blocked Cookies db as missing Full Disk Access and names the binary, and only touches the Keychain on request. An agent surface can refresh and revoke but not grant, add a domain or change profile.

  `@agentproto/driver-browser`: `--full-profile` unlocks only with an active recorded full-profile grant (`FullProfileGrantProof`), and still never targets the default user-data-dir. `@agentproto/adapter-browser-chrome` and `@agentproto/adapter-browser-chromium` pass the proof through, and the chromium provider accepts a grant-backed `cookieSource`. `@agentproto/plugin-local-browser`: the profile clone now runs only after an explicit full-profile grant (`setup --full-profile`, plus `--yes` when non-interactive) and `revoke` deletes the clone.

### Patch Changes

- Updated dependencies [439110f]
- Updated dependencies [f2678e0]
- Updated dependencies [0aa2d28]
- Updated dependencies [1f789a2]
  - @agentproto/driver-browser@0.1.0
