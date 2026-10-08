---
"@agentproto/apps": patch
"@agentproto/worktree": patch
---

The repo-maintenance `maintain` workflow and the `worktree-gc-notify` routine workflow now call `worktree_gc` with `wait: true`. Without it the tool falls back to a background job after its 25 s default `waitMs` and returns only `{ jobId, status: "running" }`. On a repo with dozens of worktrees, the maintain report then counted "0 worktree(s) classified", and an `applyMerged: true` apply ran in the background, unreported, after the workflow had finished. `branch_gc` already blocks by default and is unchanged.
