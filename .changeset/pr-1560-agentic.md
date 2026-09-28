---
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Extend background-mode + `*_status` polling to `worktree_gc` and
`session_wrapup_plan` (new `worktree_gc_status` / `session_wrapup_status`
tools, optional `wait`/`waitMs` params, new `worktreeGcJobsDir` /
`sessionWrapupJobsDir` runtime options), backed by a shared
`createBackgroundJobRegistry` extracted from `branch_gc`'s previously ad-hoc
background-job machinery.

On the worktree side, `removeWorktreeFast`'s cleanliness gate is re-derived
from git's real refusal rule (ignored files are tolerated, untracked files
are refused even under `status.showUntrackedFiles=no`, and locked worktrees
are refused), and trash deletion is serialized into one detached deleter per
pool via the newly exported `ensureTrashDeleter` / `WORKTREE_TRASH_PIDFILE`
and new `spawnDeleter` options.
