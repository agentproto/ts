---
"@agentproto/runtime": minor
---

Per-session git worktrees on a shared sandbox box. A spawn that attaches to a box other sessions may be using (`sandbox.reuse`) now gives the session its own git worktree of the shared per-workspace clone at `<home>/.worktrees/<workspaceSlug>/<slug>` instead of re-checking out that clone and switching the branch (and mixing uncommitted files) out from under the other sessions. Concurrent mutators on the shared clone serialize on an in-box `flock`; the base clone's checkout is not re-pointed at a session's branch. On detach from a still-shared box the session's worktree is removed through the box's exec, but only when it is clean and its branch is fully pushed — leftover work keeps the worktree and logs a notice. A session alone on a fresh box keeps the previous checkout behaviour.
