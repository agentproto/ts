# Repo Maintenance

A built-in agentproto app on top of `@agentproto/worktree`'s `branch_gc` /
`branch_gc_verdict` / `worktree_gc` tools. It ships as a hand-authored
bundled app (`.agentproto/APP.md` + `agents/` + `workflows/`) rather than a
`defineApp()`/`.emit()`-generated one, because the `maintain` workflow's
`review` map step needs a real run-time function to pick the reviewer's
model per candidate — see `workflows/maintain/entry.mjs`'s docblock for why
that requires the `entry:` loader path.

## What it does

The `maintain` workflow, one run:

1. `worktree_gc` + `branch_gc` plan (dry run — nothing is touched).
2. Fans the `@agentproto/repo-maintenance-reviewer` agent out over every
   unmerged branch candidate (one turn per unique tip sha, parallelism 4):
   haiku when the candidate's residual is 3 files or fewer, sonnet
   otherwise. Each turn records a verdict via `branch_gc_verdict` —
   recording a verdict never deletes anything.
3. Re-plans `branch_gc` to confirm every candidate got a verdict, and
   reports any gap.
4. If `applyMerged` is true: `branch_gc` applies with `includeReviewed:
   false` (reclaim-class refs only — merged / squash-merged / patch-merged /
   content-merged) and `worktree_gc` applies (`salvageDirty: false`).
   **A `review`-class branch is never reclaimed by this workflow, agreed
   verdict or not** — see "Out of scope" below.
5. Reports a markdown summary, and (only when `notify` is set AND there's a
   reclaimable ref or a review candidate) sends it to an agentpush target.

## Out of scope: the approval gate

Recording a verdict via `branch_gc_verdict` is a report, not a license to
delete. Reclaiming a `review`-class branch whose stored verdict agreed
(`branch_gc`'s `includeReviewed: true`) needs a human-in-the-loop
approval/escalation gate — deliberately not built here. `approve-reviewed`
is the documented, unwired seam for that gate; the workflow applies nothing
beyond `reclaim` refs, and only when `applyMerged` is true.

## Installing

```bash
agentproto app install packages/apps/repo-maintenance
```

(or wherever this directory lands once installed from an npm-published
`@agentproto/apps` — see that package's README for the general install
story.) Then run it once ad-hoc:

```bash
agentproto maintain --repo <path>              # dry run: plan + review
agentproto maintain --repo <path> --apply-merged
```

or via the daemon directly:

```bash
agentproto workflow run-file \
  packages/apps/repo-maintenance/.agentproto/workflows/maintain/WORKFLOW.md \
  --input-json '{"repoRoot": "<path>", "applyMerged": false}'
```

## Routines

`routines/repo-maintenance-daily` (plan + review, `applyMerged: false`) and
`routines/repo-maintenance-weekly` (`applyMerged: true`) are AIP-41
`ROUTINE.md` templates targeting the `maintain` workflow, shipped
`enabled: false`. Each documents its own enabling steps — copy the directory
into a workspace's `.routines/`, point `target.workflow.file` at wherever
`maintain/WORKFLOW.md` lives in that environment, set `enabled: true`, and
reload routines. Enable the daily one first and watch it run clean a few
times before enabling weekly — only weekly deletes anything.
