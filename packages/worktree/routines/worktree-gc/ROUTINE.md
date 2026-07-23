---
schema: routine/v1
id: worktree-gc
description: |
  Scheduled garbage collection of merged/integrated git worktrees. Fires the
  `worktree_gc` tool with `apply: true` so worktrees whose branch is merged
  (or fresh) and whose tree is clean are reclaimed hands-off — the worktree is
  removed and its branch deleted. An OPEN PR, live sessions, or anything
  unresolved is always held and never touched; a dirty-but-integrated worktree
  is left in place unless `salvageDirty` is turned on (it is not, here).
  Ships DISABLED (`enabled: false`) — install it into a workspace's `.routines/`
  and flip `enabled: true` to activate.
version: "1.0.0"
schedule:
  kind: cron
  cron: "0 4 * * *"
  timezone: "UTC"
  catchup: skip
target:
  tool: worktree_gc
  inputs:
    apply: true
    salvageDirty: false
retry:
  max_attempts: 1
  backoff: fixed
on_failure:
  create_work_item: true
  fire_event: worktree.gc.failed
fires_events:
  - worktree.gc.completed
  - worktree.gc.failed
enabled: false
tags: [worktree, gc, maintenance]
---

# Worktree GC Routine

Runs daily at **04:00 UTC** and invokes the `worktree_gc` tool (shipped in
[`@agentproto/worktree`](../../README.md), exposed over MCP + HTTP by the
daemon) with `apply: true`. This reaps merged worktrees automatically so a
long-running workspace doesn't accumulate stale `_worktrees/*` trees and their
dead `wt/*` branches.

## What it does

Each fire re-runs the same plan/apply engine (`planGc` / `applyGc` in
`packages/worktree/src/gc.ts`) that backs `agentproto worktree gc --apply`:

- **`reclaim`** — branch is merged (or fresh/zero-commit) **and** the tree is
  clean → the worktree is removed and its branch deleted.
- **`salvage`** — integrated but the tree is dirty → **held** here, because
  `salvageDirty` is `false`. Turn that input on only if you want dirty
  integrated worktrees archived (snapshot-then-remove) rather than left alone.
- **`hold`** — an open PR, live sessions, or anything unresolved → never
  touched, regardless of any flag.

Every entry is re-classified from scratch immediately before it is acted on,
so a plan that has gone stale between planning and applying is refused rather
than acted on.

## Safety invariants (inherited from the engine)

These are enforced by the engine, not by this manifest — the routine cannot
weaken them:

- **Merge-gated reclaim.** Teardown only fires when integration ∈
  {merged, fresh} **and** the tree is clean.
- **Open = hold.** A worktree with an open PR or live sessions is always held.
- **Dirty = salvage-only.** A dirty integrated worktree is only ever archived
  (never silently discarded), and only when `salvageDirty` is `true`.

## Repo scope at fire time

`target.inputs` carries no `repoRoot`, so the daemon resolves the repo to gc
from the **active workspace** (`resolveWorktreeQueryRoot` →
`getActiveWorkspace`). Pin a specific repo by adding `repoRoot: <abs path>` or
`workspaceSlug: <slug>` to `target.inputs` before enabling — `repoRoot` wins
over `workspaceSlug`, which wins over the active workspace.

## Enabling

This routine is opt-in. To activate it in a workspace:

1. Copy this directory to the workspace's routine library —
   `<workspace>/.routines/worktree-gc/ROUTINE.md` (the path
   `@agentproto/routine`'s `routineSpec.pathOf` expects).
2. Set `enabled: true` in the frontmatter (and, if desired, pin `repoRoot` /
   `workspaceSlug` per above).
3. Reload routines so the daemon registers the schedule.

## Failure routing

If a fire fails, `retry` gives it a single attempt (no backoff), then
`on_failure` opens a work item and fires `worktree.gc.failed`. A clean run
fires `worktree.gc.completed`.
