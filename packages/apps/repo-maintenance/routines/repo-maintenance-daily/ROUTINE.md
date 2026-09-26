---
schema: routine/v1
id: repo-maintenance-daily
description: |
  Daily plan + review pass of the `maintain` workflow — `applyMerged: false`,
  so it only classifies branches/worktrees and fans the reviewer agent out
  over unmerged candidates; nothing is ever deleted by this routine. Notifies
  only when there's something to report (a reclaimable ref or a review
  candidate) and `notify` is configured. Ships DISABLED (`enabled: false`) —
  install it into a workspace's `.routines/` and flip `enabled: true` to
  activate.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 5 * * *"
  timezone: "UTC"
  catchup: skip
target:
  workflow:
    file: <absolute-path-to-agentproto-ts>/packages/apps/repo-maintenance/.agentproto/workflows/maintain/WORKFLOW.md
  inputs:
    applyMerged: false
    notify:
      channel: telegram
      address: "<REPLACE_WITH_YOUR_TELEGRAM_CHAT_ID>"
retry:
  max_attempts: 1
  backoff: fixed
on_failure:
  create_work_item: true
  fire_event: repo-maintenance.daily.failed
fires_events:
  - repo-maintenance.daily.completed
  - repo-maintenance.daily.failed
enabled: false
tags: [repo-maintenance, branch-gc, worktree-gc, maintenance]
---

# Repo maintenance — daily plan + review

Runs daily at **05:00 UTC**, firing the `maintain` workflow
(`../../.agentproto/workflows/maintain/WORKFLOW.md`) via `workflow_run_file`
with `applyMerged: false`. Every run:

1. Plans `worktree_gc` and `branch_gc` (dry run — nothing is touched).
2. Fans the `@agentproto/repo-maintenance-reviewer` agent out over every
   unmerged branch candidate (haiku when its residual is 3 files or fewer,
   sonnet otherwise), one turn per unique tip sha. Each turn records a
   verdict via `branch_gc_verdict` — recording never deletes anything.
3. Re-plans to confirm every candidate got a verdict, and reports the gaps.
4. Reports a markdown summary, and notifies (when `notify` is configured)
   ONLY if there was a reclaimable ref or a review candidate — a clean sweep
   over an already-tidy repo doesn't page anyone.

Nothing this routine does can delete a branch, a worktree, or apply a
recorded verdict — see `repo-maintenance-weekly/ROUTINE.md` for the
apply-enabled sibling, and the `maintain` WORKFLOW.md's own doc for the
documented-but-unwired `approve-reviewed` seam.

## Enabling

1. Copy this directory to `<workspace>/.routines/repo-maintenance-daily/`.
2. Set `enabled: true`, update `target.workflow.file` to wherever this repo's
   `maintain/WORKFLOW.md` actually lives in that environment, and either
   replace `target.inputs.notify` with your own agentpush target or delete
   the `notify` key entirely to run silently (report only, no page).
3. If `notify` is kept, allowlist `bash` in that workspace's
   `.agentproto/allowed-commands.json` (the workflow's `notify` step needs
   it) and set `AGENTPUSH_API_KEY` in the daemon's environment.
4. Reload routines so the daemon registers the schedule, or fire it once
   ad-hoc via `routine_trigger` without waiting for the schedule.

## Failure routing

One retry attempt (no backoff), then `on_failure` opens a work item and
fires `repo-maintenance.daily.failed`. A clean run fires
`repo-maintenance.daily.completed`.
