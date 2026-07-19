# @agentproto/sandbox-e2b

## 0.2.1

### Patch Changes

- 8e44bce: Pin the boot-time `@agentproto/cli` install to a configurable `cliVersion` (defaulting to `@latest`) instead of a hardcoded `@agentproto/cli@latest`, so a broken `@latest` npm publish can no longer silently kill the sandbox on boot.
  - @agentproto/sandbox@0.1.5

## 0.2.0

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
  - @agentproto/sandbox@0.1.4

## 0.1.3

### Patch Changes

- @agentproto/sandbox@0.1.3

## 0.1.2

### Patch Changes

- @agentproto/sandbox@0.1.2

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/sandbox@0.1.1

## 0.1.0

### Minor Changes

- 126f7c6: Add createSandboxAgentSessionHost, e2b SandboxProvider, and re-export daemon host from worktree
- 414a327: e2b sandbox: update CLI on boot and open daemon origin allowlist
- 553597a: Add sandbox reconnect/reuse and AIP-36 lifecycle pause support

### Patch Changes

- Updated dependencies [126f7c6]
- Updated dependencies [e029a35]
- Updated dependencies [553597a]
  - @agentproto/sandbox@0.1.0
