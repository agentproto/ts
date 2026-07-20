---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Add worktree-status query surface (MCP tool + HTTP route). Exposes git worktree status with live PR integration and session linkage via `worktree_status` MCP tool and `GET /worktrees` HTTP endpoint. The heavy join lives in `@agentproto/worktree` and is injected at the daemon's composition root, keeping the runtime free of that dependency.
