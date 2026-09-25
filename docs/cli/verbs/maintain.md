# `agentproto maintain`

```text
agentproto maintain [--repo <dir>] [--apply-merged] [--json]
```

Convenience shortcut over `agentproto workflow run-file` for the built-in
[`repo-maintenance` app](../../../packages/apps/repo-maintenance/README.md)'s
`maintain` workflow. **Needs a running daemon** (`agentproto serve`) — unlike
[`branch gc`](./branch.md) and [`worktree gc`](./worktree.md), the workflow's
review step spawns real agent sessions.

One run:

1. Plans `worktree_gc` and `branch_gc` (dry run — nothing is touched).
2. Fans a reviewer agent out over every unmerged branch candidate, one turn
   per unique tip sha: a small model when the candidate's residual is 3
   files or fewer, a large model otherwise. Each turn records a verdict via
   `branch_gc_verdict` — recording a verdict never deletes anything.
3. Re-plans `branch_gc` to confirm every candidate got a verdict, and
   reports any gap.
4. With `--apply-merged`: applies `branch_gc` (reclaim-class only,
   `includeReviewed: false`) and `worktree_gc`. **A `review`-class branch is
   never reclaimed, agreed verdict or not** — see the app's README,
   "Out of scope: the approval gate".
5. Reports a markdown summary.

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | cwd | Any dir inside the repo. |
| `--apply-merged` | `false` | Apply (reclaim-class only) after review. |
| `--json` | `false` | Print the raw `workflow_run_file` reply. |

This starts the run and returns immediately (the run executes in the
background) — poll it with:

```bash
agentproto workflow status <runId>
```

## Examples

```bash
# Plan + review only, nothing deleted
agentproto maintain --repo ~/code/my-app

# Plan + review, then apply reclaim-class branch/worktree gc
agentproto maintain --repo ~/code/my-app --apply-merged
```

## Scheduling it

`packages/apps/repo-maintenance/routines/` ships two AIP-41 `ROUTINE.md`
templates targeting the same `maintain` workflow, both `enabled: false`:
`repo-maintenance-daily` (plan + review, no apply) and
`repo-maintenance-weekly` (`applyMerged: true`). See that directory's
README for how to enable one per workspace.
