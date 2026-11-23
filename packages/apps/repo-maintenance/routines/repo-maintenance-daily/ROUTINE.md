---
schema: routine/v1
id: repo-maintenance-daily
description: |
  Daily maintain pass over every repo the daemon config's `maintain` section
  names (`maintain_run` with `all: true`), `applyMerged: true`: plan, review
  unmerged candidates, then reclaim only reclaim-class refs (merged /
  squash-merged / patch-merged / content-merged branches, merged-or-fresh
  clean worktrees). Review-class branches are never deleted by this routine.
  Notifies only when there's something to report and `maintain.notify` is
  configured. Ships DISABLED (`enabled: false`): install it into a
  workspace's `.routines/` and flip `enabled: true` to activate.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 5 * * *"
  timezone: "UTC"
  catchup: skip
target:
  tool: maintain_run
  inputs:
    all: true
    applyMerged: true
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

# Repo maintenance — daily plan + review + reclaim

Runs daily at **05:00 UTC**, calling the daemon tool `maintain_run` with
`all: true` and `applyMerged: true`. `maintain_run` resolves the repo list
from the daemon's user config (`~/.agentproto/config.json`, section
`maintain`) and starts one run of the repo-maintenance app's `maintain`
workflow per repo, in the background. Every run:

1. Plans `worktree_gc` and `branch_gc`.
2. Fans the `@agentproto/repo-maintenance-reviewer` agent out over every
   unmerged branch candidate, one turn per unique tip sha. Each turn records
   a verdict via `branch_gc_verdict`; recording never deletes anything.
3. Re-plans to confirm every candidate got a verdict, and reports the gaps.
4. Applies reclaim-class only: merged / squash-merged / patch-merged /
   content-merged branches, and merged-or-fresh clean worktrees. A
   `review`-class branch is never deleted by this routine (no
   `applyReviewed`), whatever its stored verdict.
5. Reports a markdown summary, and notifies (when `maintain.notify` is
   configured) ONLY if there was a reclaimable ref or a review candidate.

See `repo-maintenance-weekly/ROUTINE.md` for the sibling that also applies
agreed verdicts (`applyReviewed`), under `branch_gc`'s line-coverage guard.

## Configuring (per user, never in this file)

Nothing personal lives in this routine. The repos are the ones agentproto
already manages: every workspace registered with `agentproto workspace add
<path>` (a repo root, not app-owned), plus repos owning a worktree under the
worktrees root. Take a repo out with `maintain.exclude`. Extra repos and
where the report goes are read from the daemon's user config, which each
operator edits for themselves:

```jsonc
// ~/.agentproto/config.json
{
  "worktrees": { "extraRoots": ["~/code/_worktrees"] },
  "maintain": {
    "workspaces": true,               // registered workspaces (agentproto workspace add), default true
    "discover": true,                  // repos owning a worktree under worktrees.root + extraRoots (default true)
    "repos": ["~/code/my-app"],        // added on top of discovery
    "exclude": ["~/code/scratch"],     // left out
    "maxReviews": 10,                  // optional
    "reviewPreset": "sonnet",          // optional
    "notify": { "provider": "telegram", "address": "<your chat id>" }  // optional
  }
}
```

`agentproto maintain --all` resolves the same list, so
`agentproto maintain --all` (no `--apply-merged`, no `--wait`) is the way to
see which repos the routine will cover.

## Enabling

1. Copy this directory to `<workspace>/.routines/repo-maintenance-daily/`
   and set `enabled: true`. The workspace only hosts the schedule: the repo
   list comes from the config above, not from the workspace.
2. If `maintain.notify` is set, make sure its provider is configured on the
   daemon. The notify step goes through `transmit_message` (`bind: false`):
   `provider: telegram` needs a bot token from `telegram_bot_token_set`;
   `provider: agentpush` needs the imported MCP alias in `notify.alias`, the
   agentpush channel in `notify.source`, and the recipient in
   `notify.address`. An unconfigured provider does not fail the run: the
   report ends with `notify skipped: <reason>`.
3. Reload routines so the daemon registers the schedule, or fire it once
   ad-hoc via `routine_trigger` without waiting for the schedule.

`maintain_run` returns as soon as the runs are queued (`runs: [{repo,
runId}]`), so the cron tick never waits on a review. Poll a run with
`workflow_status <runId>`. A repo that fails to start is listed with its
error and the others still run.

## Failure routing

One retry attempt (no backoff), then `on_failure` opens a work item and
fires `repo-maintenance.daily.failed`. A clean run fires
`repo-maintenance.daily.completed`. `maintain_run` fails only when no run
could start (no repo resolved, an invalid `maintain` config, or the app
could not be installed).
