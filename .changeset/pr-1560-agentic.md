---
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Extend background-mode job polling to `worktree_gc` and `session_wrapup_plan`, backed by a new shared `createBackgroundJobRegistry` helper. Both tools now accept optional `wait`/`waitMs` params and gain matching `worktree_gc_status`/`session_wrapup_status` polling tools, plus new `worktreeGcJobsDir`/`sessionWrapupJobsDir` runtime options.

`removeWorktreeFast`'s cleanliness gate is re-derived from git's real refusal rule: ignored files are tolerated, untracked files are refused even when `status.showUntrackedFiles=no`, and locked worktrees are refused. Trash deletion is now serialized into a single detached deleter per pool, exposed via the new `ensureTrashDeleter`/`WORKTREE_TRASH_PIDFILE` exports and additional `spawnDeleter` options.
