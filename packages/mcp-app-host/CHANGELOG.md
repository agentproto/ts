# @agentproto/mcp-app-host

## 0.2.0

### Minor Changes

- 40a373d: feat(mcp-apps): serve MCP App views from a dedicated sandbox origin, as the MCP Apps spec requires (host and view on different origins, `allow-same-origin`, CSP as an HTTP header). The daemon registers views at `POST /mcp-app-sandbox/views` and serves them on `<token>.sandbox.localhost` (or a dedicated port, or a fixed public hostname via `daemon.mcpAppSandbox`). A sandbox origin is never trusted by the daemon: any request carrying one in `Origin`/`Referer`, and any WebSocket upgrade from one, is refused with 403 whatever the allowlist says, and a sandbox host serves documents only. `mountMcpApp` uses the sandbox origin automatically when the daemon offers one and otherwise falls back to the opaque-origin `srcdoc` (logged as "restricted mode"); new `@agentproto/mcp-app-host/csp` export with `buildSandboxCspHeader`.

### Patch Changes

- 325c582: fix(acp): surface the canonical MCP tool name (`mcp__<server>__<tool>`) from `_meta.claudeCode.toolName` instead of the bridge's "<server>: <tool>" display title, so chat UIs can route MCP App views for claude-code sessions. fix(mcp-app-host): emit `object-src 'none'` in the sandbox CSP as the MCP Apps spec requires.

## 0.1.6

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

## 0.1.5

### Patch Changes

- 35da910: Decline `ui/request-display-mode` for a mode missing from `hostContext.availableDisplayModes` instead of passing it to the embedder's handler

## 0.1.4

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.1.3

### Patch Changes

- 179ea46: Declare the `@agentproto/app-client` dev dependency so workspace type-checks build the display-mode export before checking MCP app host round-trip tests. All other changes in this PR are workflows, CI drivers, and root-level scripts, which are not published packages and require no version bump.

## 0.1.2

### Patch Changes

- 88f2836: Weekly minor/patch dependency bumps across workspaces (@modelcontextprotocol/sdk 1.30.0 → 1.30.1, @anthropic-ai/claude-agent-sdk 0.3.282 → 0.3.283, turbo 2.10.12 → 2.11.5, @tauri-apps/* 2.12, @tanstack/react-query 5.104, e2b 2.51, @earendil-works/pi-tui 0.87, tsx 4.23.15, @types/vscode 1.138).

## 0.1.1

### Patch Changes

- 639892d: Test-only: the `mountMcpApp` ui/initialize test now polls for the reply instead of sleeping a fixed 20ms, which flaked on loaded CI runners.

## 0.1.0

### Minor Changes

- f12f006: New package: framework-free MCP Apps host over the official ext-apps AppBridge — transport-agnostic core (`createMcpAppHost`) with pre-ready send queueing and honest host capabilities, plus a browser DOM adapter (`mountMcpApp`) that mounts a `ui://` resource in a sandboxed srcdoc iframe with its CSP.
