# @agentproto/relay

## 0.1.8

### Patch Changes

- 89258dd: Weekly dependency refresh (minor-patch).

  Held back: `@mastra/code-sdk` stays at 1.14.0 via a root `pnpm.overrides` entry.

  From 1.16.0, `@mastra/code-sdk` declares `@mastra/core` as a peer (`>=1.80.0`)
  instead of an exact dependency, so pnpm binds it to this workspace's deliberately
  pinned `@mastra/core@1.66.0` — a version whose "exports" map does not define the
  `./knowledge` subpath that code-sdk's dist imports, which makes importing
  `@agentproto/adapter-mastracode-inprocess` (and every CLI test that imports it)
  fail with `Package subpath './knowledge' is not defined by "exports"`. 1.14.0 is
  the resolution this lockfile already proved green, so the hold pins it exactly
  rather than float onto an untested 1.15.x. Lift the hold once the
  mastracode-inprocess adapter moves to a `@mastra/core` that exports
  `./knowledge` (>= 1.78.0).

## 0.1.7

### Patch Changes

- b211901: `POST /remote/enable`, `POST /remote/disable` and the mutating `/tunnels*` routes (create, delete, revoke, hostnames, login, provider credentials) now take the same gate as the mutating `/sessions/*` routes: a foreign browser Origin is refused, the per-boot token (or an allowlisted Origin) is required, and POST, PUT and PATCH must send `content-type: application/json` (415 otherwise). `GET /remote/status` and the read-only `/tunnels` routes are unchanged. `agentproto-relay --tunnel` now sends the daemon token on `POST /tunnels`; the `agentproto remote` and `agentproto tunnel` commands already did.

## 0.1.6

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.1.5

### Patch Changes

- 0dd095d: Fix daemon crash when a rendezvous/tunnel/terminal-input WebSocket dial is aborted or times out while still connecting: keep a permanent `error` listener on the socket and use `terminate()` for a CONNECTING socket, so the late "closed before the connection was established" error becomes a normal dial failure instead of an unhandled `error` event that crashes the process.

## 0.1.4

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.1.3

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.

## 0.1.2

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

## 0.1.0

### Minor Changes

- 611ce4c: Add @agentproto/relay: webhook-to-session relay with fixed target, bearer auth, and rate limiting
