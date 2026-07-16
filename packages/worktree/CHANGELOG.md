# @agentproto/worktree

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
