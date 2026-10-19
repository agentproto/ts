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
2. Fans the `@agentproto/repo-maintenance-reviewer` agent out over the
   unmerged branch candidates with no stored verdict yet — at most
   `maxReviews` (default 40) per run, newest tip first, then the larger
   residual; the rest wait for the next run (one turn per unique tip sha,
   parallelism 4, each reviewer in its own disposable detached worktree
   under the OS tmp dir, never the live checkout): sonnet when the
   candidate's residual is 3 files or fewer, opus otherwise — by default;
   the models are the `review.small` / `review.large` **model roles** (an
   explicit `reviewModelSmall`/`reviewModelLarge` input wins, then the repo's
   `agentproto.json` `models`, then the daemon config `models`, then the
   built-in default — see `@agentproto/runtime`'s `model-roles.ts`; inspect
   with the `model_roles` tool, change with `config_set models.review.small`).
   A role's configured `profile` and `route` ride the reviewer spawn too
   (`access.profileRef` / `route`), so e.g. an `opencode-go/...` reviewer can
   bill a named profile instead of ambient auth. Three spawn
   failures in a row stop the fan-out (the engine's circuit breaker) and
   the report lists every distinct failure reason. Each turn records a verdict via `branch_gc_verdict` —
   recording a verdict never deletes anything. A turn that ends without a
   stored verdict for its tip (checked via `branch_gc_verdict_get`) gets
   one re-prompt in the same session, then one retry on the large model.
3. Re-plans `branch_gc` to confirm every candidate got a verdict, and
   reports any gap, the verdict tally, and the `salvage` branches by name.
4. If `applyMerged` is true: `worktree_gc` applies first (`salvageDirty:
   false`) — removing a merged worktree frees its branch — then `branch_gc`
   applies. By default `includeReviewed` is false, so only reclaim-class refs
   (merged / squash-merged / patch-merged / content-merged) are touched. With
   `applyReviewed: true` (only meaningful together with `applyMerged: true`)
   it also reclaims `review`-class branches whose stored verdict agreed for
   the same tip — subject to `branch_gc`'s deterministic line-coverage guard
   (default 95%), which refuses an approval below the threshold.
5. Reports a markdown summary, and (only when `notify` is set AND there's a
   reclaimable ref or a review candidate) sends it through the daemon's
   provider-agnostic outbound primitive, `transmit_message` (`bind: false`,
   so it needs no session). The `notify` input is
   `{ provider?, alias?, address? }`: `provider` defaults to `telegram` and
   the legacy `channel` field is accepted as an alias of it, `alias` names
   the imported MCP alias (agentpush) or bot-token alias (telegram), and
   `address` is the recipient chat id / `contact_ref`. No `bash` allowlist or
   `AGENTPUSH_API_KEY` is involved. A provider that is not configured on the
   daemon does not fail the run: the report ends with
   `notify skipped: <reason>`. The report lists the reviewed branches
   reclaimed and any approvals the line-coverage guard refused.

## Applying agreed verdicts

Recording a verdict via `branch_gc_verdict` is a report, not a license to
delete. The opt-in `applyReviewed: true` is the gate: with `applyMerged: true`
it runs `branch_gc` with `includeReviewed: true`, so a `review`-class branch
whose stored verdict agreed (`gate.agree: true` for that exact tip) can be
reclaimed. This is safe because `branch_gc` re-classifies every ref
immediately before touching it and enforces `lineCoverageGuard`: an agreeing
verdict under the minimum line coverage (95% by default) is refused
(`refused-guard`) and stays a `review` branch. The report lists those as a
separate "Human decision queue" with their coverage percentage — the
reviewer's `gate.agree` remains its honest safety judgement, not a statement
that the guard's policy threshold should be applied by the reviewer. The
default is false; the weekly routine template enables it, while daily never
applies.

### Operator approvals

`branch_gc_verdict` accepts an optional `operator: { by, note? }` block. A
reviewer verdict whose tip falls under `branch_gc`'s line-coverage guard
(default 95%) is refused and stays in `review` — that refused list is the
human queue. Recording an operator approval for the **same tip sha**
(`gate.agree: true` plus the `operator` block, stored with `recordedAt`) is
the human exit: `branch_gc` with `includeReviewed: true` then reclaims it
despite the guard, and the plan entry shows
`verdictGuard: "bypassed by operator <by>..."` with who approved. Apply still
writes the restore log before deleting. These verdicts are shared with any
other `includeReviewed`-enabled run (for example the weekly routine); this
workflow's own apply step stays `includeReviewed: false`.

Verdict recording is safe under concurrency: an in-process mutex plus an OS
lock file serialise writers, the file is re-read under the lock, and each
write lands with an atomic rename, so the parallelism-4 review fan-out cannot
lose a verdict. Readers revalidate against the file's mtime/size, so a
long-lived store also observes writes made elsewhere.

The approval is accepted only through the operator MCP surface:
`branch_gc_verdict` refuses an `operator` block when the daemon-verified caller
is an agent session (including a scoped mount's owner), `POST
/branches/gc/verdict` refuses it because that route carries no caller identity,
and `operator.by` must name someone other than the verdict's `reviewer`. The
reviewer agent therefore cannot self-certify the override it is guarded
against. An operator block without `gate.agree: true` is not an approval.

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
agentproto maintain --all                      # every repo that owns a
                                               # worktree under the
                                               # worktrees root, one
                                               # workflow run per repo
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
