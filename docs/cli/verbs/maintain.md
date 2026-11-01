# `agentproto maintain`

```text
agentproto maintain [--repo <dir>]... [--all] [--apply-merged] [--apply-reviewed] [--review-preset <name>] [--max-reviews <n>] [--wait] [--json]
```

Convenience shortcut over `agentproto workflow run-file` for the built-in
[`repo-maintenance` app](../../../packages/apps/repo-maintenance/README.md)'s
`maintain` workflow. **Needs a running daemon** (`agentproto serve`) — unlike
[`branch gc`](./branch.md) and [`worktree gc`](./worktree.md), the workflow's
review step spawns real agent sessions.

One run:

1. Plans `worktree_gc`, `branch_gc`, and `sandbox_checkpoint_gc` (dry run —
   nothing is touched; the checkpoint plan classifies the stale
   `agentproto-checkpoint/*` refs a dead sandbox left on the remote as
   safe / keep / unknown).
2. Fans a reviewer agent out over the unmerged branch candidates with no
   stored verdict yet — at most `maxReviews` (`--max-reviews`, default 40)
   per run, newest
   tip first, so daily runs walk a large backlog — one turn per unique tip
   sha: a small model when the candidate's residual is 3 files or fewer, a
   large model otherwise. Each turn records a verdict via
   `branch_gc_verdict` — recording a verdict never deletes anything. A turn
   that ends without a stored verdict gets one same-session re-prompt, then
   one large-model retry. A reviewer model role's configured `profile` and
   `route` ride the spawn too (`access.profileRef` / `route`), so an
   `opencode-go/...` reviewer can bill a named profile instead of ambient
   auth.
   Branches held only because they're checked out in a linked worktree
   join the queue too, when that worktree is idle (no live session), clean,
   has no open PR, and its tip is at least 3 days old. Otherwise
   `worktree gc` and `branch gc` would each hold them forever. The report
   lists each such worktree's verdict, plus the `agentproto worktree rm`
   command when the reviewer agreed nothing of value is lost. Removal stays
   manual. The workflow input `reviewHeldWorktrees: false` turns this off.
3. Re-plans `branch_gc` to confirm every candidate got a verdict, and
   reports any gap, the verdict tally, and the `salvage` branches by name.
4. With `--apply-merged`: applies `branch_gc` (reclaim-class only by
   default), `worktree_gc`, and `sandbox_checkpoint_gc` (stale checkpoint
   refs; the engine re-plans and re-classifies every ref immediately before
   deleting it). Adding `--apply-reviewed` runs the branch apply
   with `includeReviewed: true`, so a `review`-class branch whose stored
   verdict agreed for the same tip is reclaimed too. `branch_gc` still
   enforces its deterministic line-coverage guard (default 95%): an approval
   below it is refused (`refused-guard`) and listed in the report's "Human
   decision queue" with its coverage percentage. That queue is never
   capped: every refused branch is listed, lowest coverage first, followed by
   the `branch_gc_verdict` call that approves one (there is no CLI command
   for it). Other lists in the report stop at 20 names and say where the
   full list is in the run output. Without `--apply-reviewed`,
   a `review`-class branch is never reclaimed.
5. Reports a markdown summary.

Verdicts are recorded with `branch_gc_verdict`, which also accepts an
`operator: { by, note? }` block. A reviewer verdict under the line-coverage
guard is refused by `branch_gc`; an operator approval for the same tip sha is
the human exit from that queue and lets `includeReviewed` reclaim it despite
the guard (the plan shows `verdictGuard: bypassed by operator <by>`). The
maintain workflow applies with `includeReviewed: $input.applyReviewed` —
false unless `--apply-reviewed` is passed (with `--apply-merged`), so by
default it records and reports verdicts but never deletes a `review`-class
branch.

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | cwd | Any dir inside the repo. **Repeatable** — pass multiple `--repo` flags to target specific repos. Combined with `--all` to supplement discovered repos. |
| `--all` | `false` | Run once per repo: every main repo that owns a worktree under the worktrees root, plus any `--repo` dirs. Prints the discovered repo list first; exits `1` if any run fails. |
| `--apply-merged` | `false` | Apply (reclaim-class only) after review. When used with `--all`, applies to every repo. |
| `--apply-reviewed` | `false` | With `--apply-merged`, also reclaim `review`-class branches whose stored verdict agreed (`includeReviewed: true`). `branch_gc` refuses approvals below its line-coverage guard (default 95%) and reports them; ignored without `--apply-merged`. |
| `--review-preset <name>` | daemon `modelRolePreset` | Reviewer model set for this run: `opus`, `sonnet`, `haiku`, `go-free`, `free-sonnet` (see [`modelRolePreset`](../reference/config-schema.md#modelrolepreset-string)). Each reviewer spawns on the adapter its model needs, so `go-free` runs on opencode. |
| `--max-reviews <n>` | workflow `maxReviews` (`40`) | Cap how many unmerged branches this run sends to a reviewer (newest tip first). Must be a positive integer, else exit `2` before any daemon contact. Branches with a stored verdict are never re-reviewed, so repeated runs walk the backlog. |
| `--wait` | `false` | Block until each run ends, then print its markdown report. Exit `0` when all done, `1` when any failed or was cancelled. |
| `--json` | `false` | Print the raw `workflow_run_file` reply (with `--wait`: the finished run records, one per repo). |

This starts the run and returns immediately (the run executes in the
background) — poll it with:

```bash
agentproto workflow status <runId>
```

Or pass `--wait` to block until it finishes and print the report inline.

## Examples

```bash
# Plan + review only, nothing deleted
agentproto maintain --repo ~/code/my-app

# Plan + review, then apply reclaim-class branch/worktree gc
agentproto maintain --repo ~/code/my-app --apply-merged

# Also apply agreed reviewed branches (line-coverage guard still applies)
agentproto maintain --repo ~/code/my-app --apply-merged --apply-reviewed

# Run for every repo that owns worktrees under the worktrees root
agentproto maintain --all --apply-merged

# Block until done and print the report
agentproto maintain --repo ~/code/my-app --wait
```

## Scheduling it

`packages/apps/repo-maintenance/routines/` ships two AIP-41 `ROUTINE.md`
templates targeting the same `maintain` workflow, both `enabled: false`:
`repo-maintenance-daily` (plan + review, no apply) and
`repo-maintenance-weekly` (`applyMerged: true` + `applyReviewed: true`; drop
`applyReviewed` to keep the weekly apply reclaim-class only). See that
directory's README for how to enable one per workspace.
