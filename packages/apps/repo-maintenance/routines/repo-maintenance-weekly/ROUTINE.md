---
schema: routine/v1
id: repo-maintenance-weekly
description: |
  Weekly plan + review + APPLY pass of the `maintain` workflow —
  `applyMerged: true` + `applyReviewed: true`, so after the review agent
  runs, `branch_gc` and `worktree_gc` execute their plans:
  merged/squash-merged/patch-merged/content-merged branches,
  review-class branches whose stored verdict agreed (subject to branch_gc's
  line-coverage guard, default 95% — refused approvals are reported and
  stay), and merged-or-fresh+clean worktrees are reclaimed. Anything `hold`
  is never touched. Set `applyReviewed: false` (or omit it) to keep the
  apply reclaim-class only. Ships DISABLED (`enabled: false`) — install it
  into a workspace's `.routines/` and flip `enabled: true` to activate.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 5 * * 0"
  timezone: "UTC"
  catchup: skip
target:
  workflow:
    file: <absolute-path-to-agentproto-ts>/packages/apps/repo-maintenance/.agentproto/workflows/maintain/WORKFLOW.md
  inputs:
    applyMerged: true
    # Opt in to reclaiming review-class branches whose stored verdict agreed.
    # branch_gc still refuses an approval below its line-coverage guard (95%).
    # Drop this key (or set false) to apply reclaim-class refs only.
    applyReviewed: true
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

- `branch_gc` applies with `includeReviewed: true` (because this template
  sets `applyReviewed: true`): `reclaim`-class refs (merged / squash-merged /
  patch-merged / content-merged) AND `review`-class refs whose stored verdict
  agreed for the same tip are deleted. `branch_gc`'s deterministic
  line-coverage guard still outranks the reviewer: an agreeing verdict under
  the threshold (default 95%) is refused (`refused-guard`), stays a review
  branch, and is listed in the run report. Every entry is re-classified from
  scratch immediately before it's touched, so a plan that went stale between
  the review pass and the apply is refused rather than acted on. A restore
  log (sha + exact re-create command per deleted ref) is written before the
  first delete.
- `worktree_gc` applies with `salvageDirty: false` — only merged/fresh AND
  clean worktrees are reclaimed; a dirty-but-integrated worktree is left in
  place.

Recording a verdict via `branch_gc_verdict` is still only a report; nothing
is reclaimed unless this routine opts in with `applyReviewed: true`. Set it
to `false` (or drop the key) if you want the apply pass to touch only
`reclaim`-class refs.

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
