# @agentproto/browser-profiles

## 0.2.0

### Minor Changes

- a68d1d6: Publish the browser stack packages that consumer apps depend on. Camofox, Chrome and Chromium browser providers, the browser session/profile model, the BrowserDriver, and the embedded pairing-host library are now published to npm under their existing public versions; adapter-browser, browser-process, driver, secrets and workflow-runtime carry forward their current versions so dependent bumps resolve.

### Patch Changes

- Updated dependencies [a68d1d6]
- Updated dependencies [4243c75]
  - @agentproto/driver-browser@0.2.0
  - @agentproto/tool@0.4.0

## 0.1.0

### Minor Changes

- 439110f: Add consent, grants and a ledger to `@agentproto/browser-profiles`. Cookie import now needs explicit registrable domains (wildcards, bare TLDs, leading dots and empty lists throw typed errors), per-domain consent through an injected `prompt`, and a sink acknowledgement for remote sinks. Grants are scoped per paired device. Every grant, revoke, sink acknowledgement and agent denial is appended to a hash-chained `consent.jsonl` (file 0600, directory 0700) that never holds a cookie value. Revoke deletes the derived cookies and session state. `runDoctor` classifies a blocked Cookies db as missing Full Disk Access and names the binary, and only touches the Keychain on request. An agent surface can refresh and revoke but not grant, add a domain or change profile.

  `@agentproto/driver-browser`: `--full-profile` unlocks only with an active recorded full-profile grant (`FullProfileGrantProof`), and still never targets the default user-data-dir. `@agentproto/adapter-browser-chrome` and `@agentproto/adapter-browser-chromium` pass the proof through, and the chromium provider accepts a grant-backed `cookieSource`. `@agentproto/plugin-local-browser`: the profile clone now runs only after an explicit full-profile grant (`setup --full-profile`, plus `--yes` when non-interactive) and `revoke` deletes the clone.

- a09c448: Add `@agentproto/browser-profiles`: the public half of the browser session and profile model. Saveable session descriptors with zod schemas (descriptors written by earlier code load unchanged), Chrome `Local State` parsing and profile discovery, in-memory cookie reads from a synthetic or local Chrome user-data-dir, camofox tab reuse per `userId`, and three typed injection seams: `AuthSignalRegistry` (per-site "signed in" detectors, none built in), an optional `accountSwitcher` hook (default none), and a `SessionSource` registry (register, list, resolve by kind; an unknown kind throws `SessionSourceUnknownError`). Launching Chrome against a default profile stays refused by the kit (`browser:profile-refused`). `@agentproto/plugin-local-browser` now imports its `Local State` parsing from this package instead of keeping a second copy.

### Patch Changes

- Updated dependencies [439110f]
- Updated dependencies [f2678e0]
- Updated dependencies [0aa2d28]
- Updated dependencies [1f789a2]
  - @agentproto/driver-browser@0.1.0
  - @agentproto/tool@0.3.2
