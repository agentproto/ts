---
"@agentproto/apps": patch
"@agentproto/worktree": patch
---

Every shipped `worktree_gc` caller now gets the real result instead of a background jobId. Without `wait: true`, the tool falls back to a background job after its 25 s default `waitMs` and returns only `{ jobId, status: "running" }`. On a repo with dozens of worktrees:

- The repo-maintenance `maintain` workflow counted "0 worktree(s) classified", and an `applyMerged: true` apply ran in the background, unreported, after the workflow had finished. Both of its `worktree_gc` steps now pass `wait: true`.
- The `worktree-gc-notify` workflow reported no outcomes. Its `gc` step now passes `wait: true`.
- A `worktree-gc` routine cron run recorded the bare jobId as success, so a failed apply never reached `on_failure`. The routine template now passes `wait: true`.
- The ops panel's Worktrees card showed "0 reclaim … (no linked worktrees)". It now polls `worktree_gc_status` (added to the panel's tool allowlist) until the plan lands, and shows a failed job as an error.

The `session-steward` workflow's two `session_wrapup_apply` steps had the same 25 s fallback. A slow close came back as a bare jobId, and the report showed no outcome for a session that was in fact closed. Both steps now pass `wait: true`.

`branch_gc` already blocks by default and is unchanged.
