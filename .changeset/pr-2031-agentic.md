---
"@agentproto/worktree": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
"agentproto-vscode": minor
---

Add a recent-activity guard to `worktree gc`: a worktree whose own git index mtime is younger than `--active-minutes` (default 60, `0` disables) classifies `hold` with reason `recent-activity`, at plan time and again in apply's pre-removal re-check, so an actively-edited worktree is never reclaimed or salvaged. Plumbed end-to-end through the worktree engine (`PlanGcInput`/`ApplyGcOptions`), the runtime `worktree_gc` MCP tool and `POST /worktrees/gc` body, the `agentproto worktree gc --active-minutes` CLI flag, and the VS Code daemon client (`DaemonClient.gcWorktrees`). Apply outcomes and daemon plan/outcome views now carry the hold reason.
