---
"@agentproto/cli": minor
---

Add CLI flags for agent spawn configuration: `--access-profile` (named billing profile), `--worktree`/`--no-worktree` (git worktree isolation), `--mode` (manifest-declared mode), and `--effort` (reasoning effort). Mirrors MCP agent_start tool fields. Includes actionable error handling for access profile failures.
