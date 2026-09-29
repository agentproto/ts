# @agentproto/plugin-local-browser

## 0.3.1

### Patch Changes

- 439110f: Add consent, grants and a ledger to `@agentproto/browser-profiles`. Cookie import now needs explicit registrable domains (wildcards, bare TLDs, leading dots and empty lists throw typed errors), per-domain consent through an injected `prompt`, and a sink acknowledgement for remote sinks. Grants are scoped per paired device. Every grant, revoke, sink acknowledgement and agent denial is appended to a hash-chained `consent.jsonl` (file 0600, directory 0700) that never holds a cookie value. Revoke deletes the derived cookies and session state. `runDoctor` classifies a blocked Cookies db as missing Full Disk Access and names the binary, and only touches the Keychain on request. An agent surface can refresh and revoke but not grant, add a domain or change profile.

  `@agentproto/driver-browser`: `--full-profile` unlocks only with an active recorded full-profile grant (`FullProfileGrantProof`), and still never targets the default user-data-dir. `@agentproto/adapter-browser-chrome` and `@agentproto/adapter-browser-chromium` pass the proof through, and the chromium provider accepts a grant-backed `cookieSource`. `@agentproto/plugin-local-browser`: the profile clone now runs only after an explicit full-profile grant (`setup --full-profile`, plus `--yes` when non-interactive) and `revoke` deletes the clone.

- a09c448: Add `@agentproto/browser-profiles`: the public half of the browser session and profile model. Saveable session descriptors with zod schemas (descriptors written by earlier code load unchanged), Chrome `Local State` parsing and profile discovery, in-memory cookie reads from a synthetic or local Chrome user-data-dir, camofox tab reuse per `userId`, and three typed injection seams: `AuthSignalRegistry` (per-site "signed in" detectors, none built in), an optional `accountSwitcher` hook (default none), and a `SessionSource` registry (register, list, resolve by kind; an unknown kind throws `SessionSourceUnknownError`). Launching Chrome against a default profile stays refused by the kit (`browser:profile-refused`). `@agentproto/plugin-local-browser` now imports its `Local State` parsing from this package instead of keeping a second copy.
- 0329a22: Harden imported-MCP connections (P0). `imported-mcps.json` is now written mode 0600 by every writer (runtime `saveImportedMcps`, plugin-local-browser register/unregister). The daemon proxy expands `${VAR}` in upstream headers (parity with the apps-host pool). A 401/403/unauthorized/forbidden failure now drops the upstream client so the next call reconnects, in both `McpProxyRegistry` and `McpClientPool`. New shared `resolveImportConnection` (`mcp-import-resolve.ts`) feeds both the proxy and the apps-host resolver. `McpCredentialDeps` gains `resolveMcpSecret` / `storeMcpSecret` seams (wired to the keychain in `serve`, unused until a later phase).
- 7130165: Imported MCPs link to their source and keep secrets out of `imported-mcps.json` (P1). Entries gain additive optional fields (`origin`, `resolve: "live" | "snapshot"`, `secretRefs`); the file stays `version: 1`. A single `resolveImportConnection` chokepoint (shared by the proxy and the MCP-Apps host) resolves `live` entries against discovery (exact id, else same source+scope url/command+args match; missing source falls back to the snapshot and reports `stale`) and resolves `secretRefs` from the OS keychain into the same header/env key, dropping rather than leaking bound secrets when a live source re-points to a different upstream. On import (`mcp_import`, `POST /mcps/imports`) literal header/env values are stored via `storeMcpSecret` and replaced by refs (literal + warning when no store). `McpProxyRegistry` reconnects when a live source file's mtime changes; `stale`/`resolve`/secret key names surface in `mcp_imported_status`, `capabilities_inventory` and `/mcps/proxy/status`.

  New `agentproto mcp migrate-secrets [--apply]` (dry-run default) migrates existing literal-secret entries to secret refs.

  New `agentproto mcp mount-default <adapter> <importId...>` (P2) lets an adapter natively mount imported MCPs via a managed `harness-<adapter>` bundle, so the adapter spawns with those MCPs mounted by default instead of proxied.

  `capabilities_inventory` now reports `alsoNativeIn` (P3): other harness configs that already natively mount the same upstream, identified by normalized url/stdio matching (absolute-path args stripped) with no upstream url/header material leaking into the report.

  Settings bundles export secret key names only and report dangling secrets on apply.

- Updated dependencies [439110f]
- Updated dependencies [a09c448]
  - @agentproto/browser-profiles@0.1.0

## 0.3.0

### Minor Changes

- 8c74864: stdio MCP-server entries now carry `args` and `env` end to end: the ACP schema, runtime tool/HTTP parsing, spawn and restart mount builders, the file-based config converter, and the VS Code client type all forward them instead of silently dropping them. The local-browser plugin additionally exports headless per-session browser helpers (`ensureChromeDevtoolsMcp`, `resolveChrome`, `buildHeadlessBrowserMcpEntry`, …) and `installChromeMcp` gains generic `pkg`/`binName` options.
- e7a2958: Per-session headless browser: `agent_start`/HTTP/CLI spawns accept `browser: "headless"` (off by default), mounting an isolated chrome-devtools-mcp stdio server with a per-session Chrome profile that is swept on session exit; `buildHeadlessBrowserMcpEntry` gains an optional `userDataDir`.

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.2.0

### Minor Changes

- 5284213: Relocate local-browser skill into skill-pack-bureau. Consolidates skill distribution into the dedicated skill pack; plugin functionality and TypeScript API remain unchanged. Users should install the skill via `agentproto install skill/local-browser --pack bureau-plugin` instead of from the plugin package.

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
