# `agentproto maintain`

```text
agentproto maintain [--repo <dir>]... [--all] [--apply-merged] [--wait] [--json]
```

Convenience shortcut over `agentproto workflow run-file` for the built-in
[`repo-maintenance` app](../../../packages/apps/repo-maintenance/README.md)'s
`maintain` workflow. **Needs a running daemon** (`agentproto serve`) — unlike
[`branch gc`](./branch.md) and [`worktree gc`](./worktree.md), the workflow's
review step spawns real agent sessions.

One run:

1. Plans `worktree_gc` and `branch_gc` (dry run — nothing is touched).
2. Fans a reviewer agent out over the unmerged branch candidates with no
   stored verdict yet — at most `maxReviews` (default 40) per run, newest
   tip first, so daily runs walk a large backlog — one turn per unique tip
   sha: a small model when the candidate's residual is 3 files or fewer, a
   large model otherwise. Each turn records a verdict via
   `branch_gc_verdict` — recording a verdict never deletes anything. A turn
   that ends without a stored verdict gets one same-session re-prompt, then
   one large-model retry.
   Branches held only because they're checked out in a linked worktree
   join the queue too, when that worktree is idle (no live session), clean,
   has no open PR, and its tip is at least 3 days old. Otherwise
   `worktree gc` and `branch gc` would each hold them forever. The report
   lists each such worktree's verdict, plus the `agentproto worktree rm`
   command when the reviewer agreed nothing of value is lost. Removal stays
   manual. The workflow input `reviewHeldWorktrees: false` turns this off.
3. Re-plans `branch_gc` to confirm every candidate got a verdict, and
   reports any gap, the verdict tally, and the `salvage` branches by name.
4. With `--apply-merged`: applies `branch_gc` (reclaim-class only,
   `includeReviewed: false`) and `worktree_gc`. **A `review`-class branch is
   never reclaimed, agreed verdict or not** — see the app's README,
   "Out of scope: the approval gate".
5. Reports a markdown summary.

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | cwd | Any dir inside the repo. **Repeatable** — pass multiple `--repo` flags to target specific repos. Combined with `--all` to supplement discovered repos. |
| `--all` | `false` | Run once per repo: every main repo that owns a worktree under the worktrees root, plus any `--repo` dirs. Prints the discovered repo list first; exits `1` if any run fails. |
| `--apply-merged` | `false` | Apply (reclaim-class only) after review. When used with `--all`, applies to every repo. |
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

# Run for every repo that owns worktrees under the worktrees root
agentproto maintain --all --apply-merged

# Block until done and print the report
agentproto maintain --repo ~/code/my-app --wait
```

## Scheduling it

`packages/apps/repo-maintenance/routines/` ships two AIP-41 `ROUTINE.md`
templates targeting the same `maintain` workflow, both `enabled: false`:
`repo-maintenance-daily` (plan + review, no apply) and
`repo-maintenance-weekly` (`applyMerged: true`). See that directory's
README for how to enable one per workspace.
