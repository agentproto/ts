---
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

@agentproto/runtime: `worktree_gc` and `session_wrapup_plan` gain background mode — new optional `wait`/`waitMs` parameters, a 25 s default blocking window with fallback to a `{ jobId, status: "running", followUp }` view, and new `worktree_gc_status` / `session_wrapup_status` poll tools backed by a shared background-job registry (new `worktreeGcJobsDir` / `sessionWrapupJobsDir` registration options). Repos' worktree merge-status lookups in the wrapup plan now run concurrently, one call per repo.

@agentproto/worktree: `removeWorktreeFast`'s non-force cleanliness gate now matches git's real refusal rule (gitignored files such as node_modules are tolerated; untracked files are refused even when `status.showUntrackedFiles=no` hides them; locked worktrees are refused before anything moves). Trash deletion is serialized into one detached deleter per pool (`ensureTrashDeleter`, pid file `WORKTREE_TRASH_PIDFILE`) instead of one `rm -rf` per removal.
