# @agentproto/harness

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
