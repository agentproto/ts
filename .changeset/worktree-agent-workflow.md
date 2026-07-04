---
"@agentproto/workflow-runtime": minor
"@agentproto/worktree": minor
---

Add per-step `cwd` to `AgentStep` so a workflow can bind an agent's working directory to a prior step's output (e.g. a provisioned git worktree). New `@agentproto/worktree` package provides `worktree.provision` / `worktree.run-gate` / `worktree.cleanup` TOOL contracts + a builtin PROVIDER for the "launch an agent in a worktree, gate it, clean up" pattern.
