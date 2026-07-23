---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add git-worktree garbage collection surface: `POST /worktrees/gc` HTTP route and `worktree_gc` MCP tool powering the daemon's worktree management. Defaults to dry-run mode; requires explicit `apply: true` to execute. Design maintains architectural isolation from `@agentproto/worktree` via an injected runner port, mirroring the `worktree_status` pattern.
