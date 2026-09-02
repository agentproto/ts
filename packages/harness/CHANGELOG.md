# @agentproto/harness

## 0.4.4

### Patch Changes

- 2fc4c69: Sandboxed sessions now report their spend, and PR footers pick it up.
  - `HarnessClient.usage(sessionId)` (`session_usage`) and an optional `usage` on
    `DaemonAgentSessionHost`. The runtime's sandbox spawn wires it as the session's
    `readUsage` hook, so a box's cost/tokens/model reach the HOST descriptor at
    every turn-end — the proxy's text stream never carried them, which is why the
    CI review footer showed no amount and no model for e2b-sandboxed `claude-sdk`
    reviews.
  - `readUsage` may now return `model`; a descriptor spawned without one adopts it.
  - PR-body footer cost refresh: a PR opened through the daemon is stamped the
    instant `gh pr create` returns — mid-turn, before a claude-code/claude-sdk
    session has reported any cost. The provenance reconciler now re-renders each
    recorded PR's footer once the session knows its spend (`replaceProvenanceFooter`,
    `stampFooterOnPr({ refresh: true })`), exactly once per PR.

## 0.4.3

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.4.2

### Patch Changes

- 8a3d53d: Fix two critical bugs in `monitorSessionWait`:
  1. **Stale fast-path**: The synchronous already-in-target-state check for `turn-end` now requires `opts.since !== undefined` to fire. Without a cursor anchor, there is no way to distinguish "the turn this wait is waiting for already finished" from "some turn finished hours ago". Fresh `agentproto sessions wait` CLI processes (which have no persisted cursor) now correctly fall through to the real bus-subscribe long-poll instead of instantly succeeding against stale history.
  2. **Dropped empty/reason fields**: `SessionTurnEndEvent.empty` (zero assistant output, zero tool calls) and `.reason` (e.g. `"error"`) are now propagated through all three branches of the wait monitor (ring-replay, sync fast-path, bus long-poll) so callers can distinguish productive turns from silent no-ops (bad auth/model config) or adapter-reported errors. CLI exit code 4 is added for these cases.

  Includes a new `currentEventsCursor()` method to capture race-free cursors for prompt+wait patterns that cannot otherwise subscribe before a turn completes.

## 0.4.1

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.

## 0.4.0

### Minor Changes

- bd79483: forward routed auth and provider route to sandbox daemon

## 0.3.0

### Minor Changes

- 57d1499: Route sandboxed agent-step spawns through spawnAgentSession; e2b installPackages boot option

### Patch Changes

- 3d403d7: Fix e2b sandbox timeout issues and add poll resilience.

  Root cause: e2b's per-command timeout defaults to 60s (even for `background: true` commands), killing the daemon mid-turn; sandbox lifetime defaults to 5min, reaped during long turns. Native reviewer failed on every PR, triggering fallback double-reviews.

  Changes:
  - **harness**: Increase MCP request timeout to long-poll window + 60s grace (client was aborting at 60s while server held 49s windows, leaving ~11s headroom)
  - **runtime**: Add poll resilience — retries transient failures up to 6x; make output pulls best-effort (offset-diff safe)
  - **sandbox-e2b**: Set `timeoutMs: 0` on serve command (disables per-command timeout); default sandbox lifetime to 45min (overridable); re-arm timeout on reconnect
  - **ci**: Add postcheck gate (prevent duplicate reviews when native lane posts then errors post-post); add verify gate (confirm review row exists on GitHub API); integrate Langfuse tracing (soft-fail when creds absent)

## 0.2.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

## 0.2.0

### Minor Changes

- e029a35: Wire agent_start.sandbox: boot box + proxy session via SandboxAgentSessionProxy

### Patch Changes

- 5988bf4: Fix waitForSettled to poll past daemon timeouts via timedOut flag

## 0.1.1

### Patch Changes

- 8d1191e: Rename all MCP tool verbs to family-first taxonomy (agent*\*, session*\_, terminal\__, command*\*, file*_, directory\__, browser*\*, policy*_, routine\_\_, tunnel\_\*), split agent tools into a dedicated `agent-tools.ts` module, and fix harness call-sites.

## 0.1.0

### Minor Changes

- 01040cf: Add @agentproto/harness — typed coder/researcher/supervisor session presets over MCP

### Patch Changes

- a076432: Fix ask() race window, wait_for_any 20-child cap, and isError check in #call
- 3af9021: fix(harness): send hermes model via /model turn instead of spawn args
- 5e908f8: add model/effort manifest options to hermes; fix researcher turn-end sequencing
