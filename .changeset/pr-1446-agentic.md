---
"@agentproto/runtime": minor
"@agentproto/workflow-runtime": minor
"@agentproto/worktree": minor
"@agentproto/apps": minor
---

Additive engine features for tolerant fan-outs and cleanup: a spawn circuit breaker for `map`/`pipeline` with `onError: "collect"` (`maxConsecutiveSpawnFailures`, `AgentSpawnError`, `skipped` outcomes, `onStepFailed` hook), workflow-level `finally` cleanup steps, per-step agent `cwd` resolution against the run cwd, the `branch_gc_review_worktree` tool (disposable detached review worktrees), and parallelized/memoized `merge-base` sweeps in branch gc. The maintain workflow caps reviews per run (`maxReviews`, default 40) and runs every reviewer in its own detached worktree.
