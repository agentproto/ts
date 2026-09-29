---
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Refactored branch_gc's background-job machinery into a shared `createBackgroundJobRegistry` (`background-jobs.ts`) and extended background mode + `*_status` polling to `worktree_gc` and `session_wrapup_plan`: new `worktree_gc_status` / `session_wrapup_status` tools, new optional `wait`/`waitMs` params on `worktree_gc` and `session_wrapup_plan`, and new `worktreeGcJobsDir`/`sessionWrapupJobsDir` runtime options (`@agentproto/runtime`).

`removeWorktreeFast`'s cleanliness gate is now re-derived from git's real worktree-removal refusal rule (ignored files tolerated, untracked files refused even under `status.showUntrackedFiles=no`, locked worktrees refused), and trash deletion is serialized into a single detached deleter per pool: new exported `ensureTrashDeleter` / `WORKTREE_TRASH_PIDFILE`, new `spawnDeleter` options, and changed non-force removal-refusal semantics (`@agentproto/worktree`).
