# @agentproto/sandbox-e2b

## 0.4.0

### Minor Changes

- 5328e9b: Introduce template version management system for agentproto-workstation e2b template. Establishes `templates/workstation/versions.json` as the canonical pin declaration (CLI, adapters, runtime, base image) and introduces `scripts/sync-templates.mjs` to regenerate all derived artifacts. Enhances `@agentproto/sandbox-e2b` provider with `resolveUpdateCli()` function to intelligently skip the on-boot CLI install when a template's recorded baked image provably carries the requested CLI version—defaulting conservatively to install when the bake is unproven, maintaining backward compatibility.
- db90fb3: Implement port exposure for sandboxes. Add `expose(port)` method and `ports` map to `BootedSandbox` to enable agents to expose HTTP server ports inside sandboxes as publicly accessible URLs. Support pre-declaring ports via `extraPorts` in the sandbox spec for eager resolution at boot time. E2B provider implements port exposure via `sandbox.getHost(port)`. Surface exposed ports in `SessionDescriptor` and `SessionSummary` via new `sandboxPorts` field.

### Patch Changes

- 1817079: Fix adapter installation in e2b template: use one ARG per package instead of space-separated list (E2B's builder mangles spaces in ENV values), consolidate toolchain into single `npm i -g` invocation, and generate Dockerfile from versions.json to prevent pin drift.
- 3c6ca11: Record stable e2b workstation template as proven with real baked CLI and adapters (0.17.0 + hermes/opencode); skip on-boot npm install when template is proven and cliVersion matches, reducing boot time by ~90s on default paths.
- b1b569c: Add mastra-agent adapter support and sandbox resource configuration. The mastra adapter's heavy runtime install requires 2048 MB memory (vs. e2b's 512 MB default), which would otherwise OOM. Resource flags are now validated in versions.json and threaded into build commands as required CLI arguments to `e2b template create`.
- 49a89ba: Fix sandbox spec field forwarding in HTTP path and prevent VM leaks on boot/reconnect failures.

  **@agentproto/runtime**: Fixed #1150 regression where `POST /sessions/agent` silently dropped `extraPorts`, `env`, `lifecycle`, and other fields from inline sandbox specs. Extracted shared schema `sandboxSpecWithReuseSchema` to ensure both HTTP and MCP paths validate against identical schema and forward all fields.

  **@agentproto/sandbox-e2b**: Centralized sandbox cleanup on boot/reconnect failure to prevent VM leaks (observed live: six boxes left running without sessions). Added fast-fail mechanism that exits immediately when daemon crashes during boot, surfacing captured stderr for diagnostics, instead of blocking the full readiness timeout.

- 0deea71: Update stable e2b template to include mastra-agent adapter 0.6.0 in baked image attestation.
- Updated dependencies [db90fb3]
- Updated dependencies [c71753a]
  - @agentproto/sandbox@0.3.0

## 0.3.7

### Patch Changes

- @agentproto/sandbox@0.2.6

## 0.3.6

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

- Updated dependencies [f0c51a7]
  - @agentproto/sandbox@0.2.5

## 0.3.5

### Patch Changes

- e2314b3: Weekly dependency update: minor/patch-range bumps across the workspace.
  - @mastra/core 1.57.0 → 1.59.0
  - @mastra/memory 1.26.0 → 1.26.2
  - @mastra/libsql 1.19.0 → 1.20.0
  - turbo 2.10.9 → 2.10.10
  - unpdf 1.8.0 → 1.8.1
  - e2b 2.38.2 → 2.39.0
  - @anthropic-ai/claude-agent-sdk 0.3.226/0.3.232 → 0.3.233
  - @earendil-works/pi-tui 0.84.1 → 0.84.2
  - mastracode 0.32.6 → 0.33.1

- b95e23b: Weekly dependency update: bump external dependencies to latest minor/patch versions.
  - @anthropic-ai/claude-agent-sdk 0.3.233 → 0.3.241
  - @ast-grep/napi 0.45.1 → 0.45.2
  - @mastra/core 1.59.0 → 1.61.0
  - @mastra/libsql 1.20.0 → 1.21.1
  - @mastra/memory 1.26.2 → 1.27.0
  - @tanstack/react-query 5.66.0 → 5.102.2
  - @types/react-dom 19.2.4 → 19.2.5
  - @types/vscode 1.90.0 → 1.134.0
  - e2b 2.39.0 → 2.45.0
  - mastracode 0.33.1 → 0.35.0
  - turbo 2.10.10 → 2.10.11

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.
  - @agentproto/sandbox@0.2.4

## 0.3.4

### Patch Changes

- 6e403f8: Skip integration test when OPENROUTER_API_KEY is missing
- c4ca23a: Separate integration tests from unit tests via dedicated vitest configs, add auth error handling (gracefully skip on 401/403), install hermes adapter in sandbox boot, and increase test timeout from 120s to 240s. Improves test reliability and maintainability without API changes.
  - @agentproto/sandbox@0.2.3

## 0.3.3

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.

## 0.3.2

### Patch Changes

- @agentproto/sandbox@0.2.2

## 0.3.1

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
  - @agentproto/sandbox@0.2.1

## 0.3.0

### Minor Changes

- 6c35cb9: add config.setupCommands provision hook to e2b sandbox boot
- e81ad25: Add `agentproto sandbox attach` — Phase 1 of AIP-36 sandbox reconnect. New CLI verb and runtime primitives (`attachSandbox`, `buildMcpConfigSnippet`, `registerSandboxAttachTool`) for connecting to already-existing sandboxes without tearing them down. Returns durable, token-gated connection descriptors for any MCP client to use directly. Extends `SandboxProvider` with optional `connect()` method for resume-after-pause workflows, and adds token capture from Box's `--private` and e2b's traffic restriction.

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- 5615d80: Run setupCommands even when the e2b daemon is already autostarted
- Updated dependencies [013e7b3]
- Updated dependencies [e81ad25]
- Updated dependencies [15abbee]
  - @agentproto/sandbox@0.2.0

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
