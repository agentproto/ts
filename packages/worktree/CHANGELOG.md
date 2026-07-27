# @agentproto/worktree

## 0.4.3

### Patch Changes

- 7192faf: Enrich `SessionRef` with optional `adapterSlug`, `model`, `authMode`, `costUsd`, `tokensIn`, and `tokensOut` echoes from `SessionDescriptor`. These fields are ignored by GC logic and are surfaced in local PR provenance footers.
- 41cd652: Ship opt-in AIP-41 routine for scheduled worktree garbage collection. The `worktree-gc` routine wraps the existing `worktree_gc` engine and packages it as a reference template for users to adopt on a daily cron schedule. Routine ships disabled by default; activate in a workspace by copying to `.routines/` and setting `enabled: true`.
- 7465b6c: Harden git-spawn PATH and worktree-cwd anchoring to fix two runtime bugs surfaced by worktree-gc daemon cron. Narrow inherited PATH (frozen at daemon install time) is merged with standard system bin dirs to prevent spawned tools like git from ENOENT-ing. Worktree-specific git spawns are anchored to stable repoRoot instead of per-worktree paths to prevent TOCTOU race conditions where concurrent gc reaps cause misleading "spawn git ENOENT" errors.
- 4d200a9: Implement AIP-41 routine runtime bridge: tight schema for `target` union (tool/agent/workflow/action), `RoutineRegistrar` that reads `.routines/*/ROUTINE.md` and registers cron jobs, `dispatchTool` gateway for in-process MCP tool calls, HTTP `/routine-defs/:id/trigger` and MCP `routine_trigger` tool (mirrors `cron_run`). New `TargetAgent` sugar kind for agent spawning (ahead of upstream draft). Comprehensive unit + integration tests proving all three target kinds fire through real dispatch mechanism.
- 23fa73e: Wire daemon tool-step registry into compileWorkflow; dogfood worktree-gc→notify
- Updated dependencies [bd79483]
- Updated dependencies [831d4f5]
- Updated dependencies [23fa73e]
  - @agentproto/harness@0.4.0
  - @agentproto/driver@0.2.0
  - @agentproto/workflow-runtime@0.6.0

## 0.4.2

### Patch Changes

- Updated dependencies [57d1499]
- Updated dependencies [3d403d7]
  - @agentproto/workflow-runtime@0.5.0
  - @agentproto/harness@0.3.0

## 0.4.1

### Patch Changes

- a116fd6: Replace literal NUL bytes in memoKey with \\u0000 escape to restore UTF-8 text

## 0.4.0

### Minor Changes

- 98bbebf: Partition session state per workspace (AIP-46 §State partitioning)

## 0.3.0

### Minor Changes

- 5ae8c13: Add agentproto.json lifecycle: setup/teardown hooks, supervised services, localhost reverse proxy, and worktree CLI verb
- 2bed7e6: Add worktree status engine (tree/integration/liveness axes, squash-proof reconciliation, ForgeClient, provenance join, ls --status)
- 3e99abf: Split worktree.cleanup --force into discardUntracked/discardModified flags; add rm/archive CLI verbs and salvage writer
- a63b4bc: Add worktree new verb, worktrees.root config, and provision provenance marker
- 47d3251: Add `worktree gc` command: plan/apply/salvage cleanup sweep over linked worktrees

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- 4f62f46: Fix worktree archive ENOENT by resolving the main repo root via --git-common-dir
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- 0839e5f: Fix gc salvaging dirty fresh worktrees; add recent-write hold window
- Updated dependencies [7b53b8c]
- Updated dependencies [e0fbccc]
  - @agentproto/driver@0.1.3
  - @agentproto/harness@0.2.1
  - @agentproto/tool@0.2.1
  - @agentproto/workflow-runtime@0.4.0

## 0.2.0

### Minor Changes

- 7aaf24a: Add AgentStep.cwd selector and new worktree provision/gate/cleanup tools
- 435dfbf: Add worktree-agent CLI and move worktreeAgentWorkflow into @agentproto/worktree
- 126f7c6: Add createSandboxAgentSessionHost, e2b SandboxProvider, and re-export daemon host from worktree
- 4733077: Add linkPaths to worktree.provision and --link CLI flag to symlink gitignored deps
- e029a35: Wire agent_start.sandbox: boot box + proxy session via SandboxAgentSessionProxy

### Patch Changes

- 4a1ea0f: Add explicit Bindings type annotations in worktree workflow
- a6dce67: Fix expandGlob stack overflow on large repos by skipping node_modules and avoiding spread-push
- 5988bf4: Fix waitForSettled to poll past daemon timeouts via timedOut flag
- Updated dependencies [f8ebe41]
- Updated dependencies [7aaf24a]
- Updated dependencies [2154ed5]
- Updated dependencies [5988bf4]
- Updated dependencies [e029a35]
  - @agentproto/workflow-runtime@0.3.0
  - @agentproto/harness@0.2.0
