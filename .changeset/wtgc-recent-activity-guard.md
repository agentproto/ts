---
"@agentproto/worktree": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
"agentproto-vscode": minor
---

`worktree gc` now refuses to touch a recently-active worktree. A worktree whose own git index was written within the last 60 minutes (the worktree's private index — checkout/add/commit/status all rewrite it, so a young mtime means someone is working in there regardless of what any session registry knows) classifies `hold` with hold reason `recent-activity`, never `reclaim`/`salvage`, at plan time and again in apply's pre-removal re-check; the index mtime is always read before gc's own `git status` so the sweep can't report itself as activity. Plumbed end-to-end as `activeMinutes` (engine `PlanGcInput`/`ApplyGcOptions`, the `worktree_gc` MCP tool and `POST /worktrees/gc` body, `agentproto worktree gc --active-minutes <n>`, and the VS Code daemon client) with default 60; `0` disables the guard. Apply outcomes and the daemon's plan/outcome views now carry the hold reason, and a plan entry that became recently active between plan and apply aborts as `aborted-reclassified` to hold instead of acting on the stale plan.
