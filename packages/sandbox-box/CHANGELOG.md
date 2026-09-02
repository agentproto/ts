# @agentproto/sandbox-box

## 0.2.6

### Patch Changes

- @agentproto/sandbox@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [f0c51a7]
  - @agentproto/sandbox@0.2.5

## 0.2.4

### Patch Changes

- @agentproto/sandbox@0.2.4

## 0.2.3

### Patch Changes

- @agentproto/sandbox@0.2.3

## 0.2.2

### Patch Changes

- @agentproto/sandbox@0.2.2

## 0.2.1

### Patch Changes

- @agentproto/sandbox@0.2.1

## 0.2.0

### Minor Changes

- 9de8157: Add Box sandbox provider for ascii.dev Box cloud computers. The provider boots a Box, installs an always-on systemd unit for the agentproto daemon, and exposes the daemon's MCP endpoint via a stable hostname. Includes comprehensive test coverage for boot, connect, pause, and stop lifecycles.
- e81ad25: Add `agentproto sandbox attach` — Phase 1 of AIP-36 sandbox reconnect. New CLI verb and runtime primitives (`attachSandbox`, `buildMcpConfigSnippet`, `registerSandboxAttachTool`) for connecting to already-existing sandboxes without tearing them down. Returns durable, token-gated connection descriptors for any MCP client to use directly. Extends `SandboxProvider` with optional `connect()` method for resume-after-pause workflows, and adds token capture from Box's `--private` and e2b's traffic restriction.
- 15abbee: Add `--keep-alive` flag to `agentproto sandbox attach` for always-on rendezvous model. Keeps sandboxes indefinitely awake using provider-specific mechanisms (e.g., Box's `ttlSeconds: null` no-auto-stop) instead of letting the provider's idle/TTL auto-stop reclaim them.

### Patch Changes

- 013e7b3: Carry provider auth headers through attach; fix Box boot auth
- 7f42bc2: Retry transient failures in ascii.dev Box API calls with jittered exponential backoff. Network timeouts, FetchErrors, and 5xx/429 HTTP responses are retried up to 5 times; terminal errors (404, other 4xx) fail fast. All wrapped operations (get, remove, stop, resume) are idempotent on ascii.dev, so retrying is safe and prevents billable boxes from being left running on timeout.
- cce3546: ## Progressive Sessions Webview Loading

  Introduces a new `GET /sessions/summaries` endpoint on the runtime that returns lightweight `SessionSummary` projections with pagination support. The VS Code Sessions webview now uses this endpoint to load the first page (50 summaries) instantly, then offers a "Load more" affordance for older sessions, improving first-paint performance when the daemon holds hundreds of sessions.

  ### Runtime (@agentproto/runtime)
  - Added `SessionSummary` interface — a lightweight projection of `SessionDescriptor` excluding large resume/transcript/policy context
  - Added `listSummaries()` method to `SessionsRegistry` with `limit`/`offset` pagination
  - Added `GET /sessions/summaries` HTTP endpoint

  ### VS Code Extension (agentproto-vscode)
  - Refactored Sessions webview to consume `SessionSummary` instead of full `SessionDescriptor`
  - Implemented progressive loading: bounded first page + "Load more" button
  - Pending optimistic rows merged from store on each render for instant spawn feedback
  - Intelligent refresh: re-fetches the currently loaded slice on SessionStore changes
  - Removed workspace dropdown filter (simplification for paginated model)

  ### Sandbox Box (@agentproto/sandbox-box)
  - Fixed flaky test: strip ANSI color codes from stdout when `FORCE_COLOR=1` is set

- Updated dependencies [013e7b3]
- Updated dependencies [e81ad25]
- Updated dependencies [15abbee]
  - @agentproto/sandbox@0.2.0
