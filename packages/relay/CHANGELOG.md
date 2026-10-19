# @agentproto/relay

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
