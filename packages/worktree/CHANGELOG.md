# @agentproto/worktree

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
