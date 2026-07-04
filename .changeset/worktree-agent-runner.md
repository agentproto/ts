---
"@agentproto/worktree": minor
---

Add a `worktree-agent` CLI that runs `worktreeAgentWorkflow` end-to-end against a real agentproto daemon (`agent_start`-backed `AgentSessionHost`, not a bare subprocess). The workflow def moves into `@agentproto/worktree` itself; `@agentproto/worktree-agent-example` now re-exports it for back-compat.
