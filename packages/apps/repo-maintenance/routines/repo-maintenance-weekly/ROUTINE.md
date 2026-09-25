---
schema: routine/v1
id: repo-maintenance-weekly
description: |
  Weekly plan + review + APPLY pass of the `maintain` workflow —
  `applyMerged: true`, so after the review agent runs, `branch_gc` (reclaim
  class only, includeReviewed false) and `worktree_gc` execute their plans:
  merged/squash-merged/patch-merged/content-merged branches and
  merged-or-fresh+clean worktrees are reclaimed. `review`-class branches and
  anything `hold` are NEVER touched by this routine — recording a verdict
  does not by itself reclaim a branch (see the maintain workflow's
  documented, unwired `approve-reviewed` seam). Ships DISABLED
  (`enabled: false`) — install it into a workspace's `.routines/` and flip
  `enabled: true` to activate.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 5 * * 0"
  timezone: "UTC"
  catchup: skip
target:
  workflow:
    file: /Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts/packages/apps/repo-maintenance/.agentproto/workflows/maintain/WORKFLOW.md
  inputs:
    applyMerged: true
    notify:
      channel: telegram
      address: "<REPLACE_WITH_YOUR_TELEGRAM_CHAT_ID>"
retry:
  max_attempts: 1
  backoff: fixed
on_failure:
  create_work_item: true
  fire_event: repo-maintenance.weekly.failed
fires_events:
  - repo-maintenance.weekly.completed
  - repo-maintenance.weekly.failed
enabled: false
tags: [repo-maintenance, branch-gc, worktree-gc, maintenance]
---

# Repo maintenance — weekly plan + review + apply

Runs weekly, Sunday **05:00 UTC**, firing the same `maintain` workflow as
`repo-maintenance-daily/ROUTINE.md` but with `applyMerged: true`. Every run
does everything the daily routine does (plan, review fan-out, verdict-gap
check), then:

- `branch_gc` applies with `includeReviewed: false` — only `reclaim`-class
  refs (merged / squash-merged / patch-merged / content-merged, by the same
  ladder `branch_gc`'s own doc describes) are deleted. Every entry is
  re-classified from scratch immediately before it's touched, so a plan that
  went stale between the review pass and the apply is refused rather than
  acted on. A restore log (sha + exact re-create command per deleted ref) is
  written before the first delete.
- `worktree_gc` applies with `salvageDirty: false` — only merged/fresh AND
  clean worktrees are reclaimed; a dirty-but-integrated worktree is left in
  place.

**A `review`-class branch is never reclaimed by this routine, agreed verdict
or not.** Recording a verdict via `branch_gc_verdict` is a report, not a
license to delete — reclaiming a reviewed branch needs a human-in-the-loop
gate this codebase deliberately hasn't built yet (`approve-reviewed`, see the
`maintain` WORKFLOW.md's own doc).

## Enabling

Same steps as `repo-maintenance-daily/ROUTINE.md`: copy this directory to
`<workspace>/.routines/repo-maintenance-weekly/`, set `enabled: true`, point
`target.workflow.file` at wherever `maintain/WORKFLOW.md` lives in that
environment, set or drop `target.inputs.notify`, allowlist `bash` +
`AGENTPUSH_API_KEY` if `notify` is kept, then reload routines.

Enable ONLY after you've watched `repo-maintenance-daily` run clean a few
times — this routine deletes branches and worktrees, the daily one never
does.

## Failure routing

Same convention as the daily routine: one retry attempt (no backoff), then
`on_failure` opens a work item and fires `repo-maintenance.weekly.failed`. A
clean run fires `repo-maintenance.weekly.completed`.
