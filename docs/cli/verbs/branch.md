# `agentproto branch`

```text
agentproto branch gc           [--repo <dir>] [--base <ref>] [--scopes local,remote,orphan]
                               [--min-age-days N] [--include-reviewed] [--anchor <sha>]
                               [--apply] [--json]
agentproto branch review-queue [--repo <dir>] [--base <ref>] [--min-age-days N] [--all]
```

Classify and clean up a repo's branches. It's the sibling of
[`worktree gc`](./worktree.md#gc) and follows the same contract: a dry run by
default, a classified plan, and an apply that re-checks every entry right
before touching it. It runs locally over `@agentproto/worktree` and needs no
daemon. The daemon exposes the same engine as the `branch_gc` /
`branch_gc_verdict` MCP tools and as `POST /branches/gc[/verdict]`.

The summary counts refs per kind (`byClass`, `byStatus`) and, in `distinct`,
branch names across kinds: a local branch and its remote twin are one branch
with two refs, so "132 branches (149 refs)".

The `branch_gc` MCP reply is compact by default: the summary, the plan
metadata and one page of entries (name, kind, sha, class, status, plus
`reclaimReason`, `mergedPr`, `mergedPrMatch`, `holdReason`,
`lineCoverage.pct` and `verdictGuard` when set), 100 rows per page. Pass
`page.nextCursor` back as `cursor` to read the next page of the same run
without re-running it. `classes` filters the entries, `fields` keeps only the
named keys of each full entry, and `full: true` returns whole entries (alone,
the whole unpaged result). An apply always returns every outcome and the
restore log. `POST /branches/gc` and `--json` still return the full result.

## Ref kinds

| Kind | Refs |
|------|------|
| `local` | `refs/heads/*` |
| `remote` | `refs/remotes/<remote>/*` for the base's own remote (`origin` for `origin/main`) |
| `orphan` | `refs/remotes/<ns>/*` where `<ns>` is no longer a configured remote. Nothing ever prunes these. `only-copy` means no local or remote ref contains the tip, so deleting it lets `git gc` destroy the commits. |

Refs of *other* configured remotes are never classified or touched.

## Sandbox checkpoint branches

A sandbox session snapshots uncommitted work onto a force-pushed remote
branch `agentproto-checkpoint/<work-branch>` (see
`packages/runtime/src/sandbox-delivery.ts`). That snapshot commit never
merges, so the ladder on its own tip proves nothing: a remote ref under
`agentproto-checkpoint/` is classified against its **work branch**, pinned
to the snapshot's parent commit (`<checkpoint>^`, the work-branch HEAD the
box snapshotted on — branch names get reused, so "the branch is merged"
alone may prove a different generation landed):

- the parent landed (it equals or is an ancestor of a merged work-branch
  tip, or it equals a merged PR's head that landed the same branch name
  while the branch itself is gone) ⇒ `reclaim` (`checkpoint-superseded`);
- the work branch is the head of an open PR ⇒ `hold` (`open-pr`);
- anything else — including a parentless snapshot or a failed parent
  lookup — ⇒ `review`, never auto-reclaimed: a dead box's checkpoint may be
  the only copy of its work.

`young` and `protected` holds apply first.

The runtime deletes the checkpoint branch itself once it is no longer
needed — a delivery whose checkout is clean and whose work branch is safe
on the remote (pushed, or nothing ahead) runs
`git push origin --delete agentproto-checkpoint/<branch>` (a missing ref
counts as success). Branch GC only ever reclaims **leftovers** a delivery
missed, and only when the work branch is merged.

## Subverbs

### `gc`

| Class | Definition | `--apply` does |
|-------|-----------|----------------|
| `reclaim` | The work is provably in base: **merged** (the tip is an ancestor), **squash-merged** (`git merge-tree` result == base tree), **patch-merged** (`git cherry` all `-`, only tried when merge-tree conflicts), or **content-merged** (every file the branch changed is in base's tree by blob at any path, or gitignored, with no evolved/unique/deleted files). With `--include-reviewed`, also an unmerged ref whose stored verdict has `gate.agree` for the same tip sha. A sandbox checkpoint branch whose work branch is merged reclaims as **checkpoint-superseded** (see [Sandbox checkpoint branches](#sandbox-checkpoint-branches)). | Deletes it: `git branch -D` for local refs, `git push <remote> --delete` in batches of 50 plus `fetch --prune` for remote refs, `git update-ref -d` for orphans. |
| `review` | Unmerged, older than `--min-age-days`, not protected. Carries coverage, the files not provably in base, and the push state. | **Never touched.** |
| `hold` | Base or a protected name; a branch checked out in a worktree and its remote twin; an open PR head; every local/remote ref when open-PR detection is unavailable; unmerged and younger than `--min-age-days`. | **Never touched.** |

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | cwd | Any dir inside the repo. |
| `--base <ref>` | `origin/main` | The ref the work must be in. |
| `--scopes <kinds>` | all three | Comma-separated kinds. **Required with `--apply`.** |
| `--min-age-days N` | `3` | Unmerged refs younger than this are held. |
| `--include-reviewed` | `false` | Reclaim reviewed refs whose gate agreed (see `review-queue`). An agreeing verdict under `--min-line-coverage` is refused unless it carries an `operator` block (see below), which bypasses the guard and is shown as `bypassed by operator <by>`. |
| `--anchor <sha>` | auto | Old-history twin of a re-rooted base's root. It's auto-detected when base has a single root and some tips share no history with it. |
| `--apply` | `false` | Execute the plan for `--scopes`. |
| `--json` | `false` | Emit `{ plan, summary }` (or `{ outcomes, restoreLog }` with `--apply`) as JSON. |

Before each delete, `--apply` lists the refs again and re-classifies the entry
from scratch. A tip that moved, vanished, or now classifies differently is
aborted instead of deleted. The restore log
(`~/.agentproto/branch-gc/<repo>/restore-<ts>.json`, with the sha and exact
re-create command per ref) is written before the first delete.

### `review-queue`

Prints the `review` candidates as JSON, one per unique tip sha (a branch and
its remote twin share one review). Each candidate carries what a reviewer
needs: base sha, compare base, merge base, merged tree (or `null` when the
merge conflicts), coverage, and the residual files. Tips that already have a
verdict are skipped unless you pass `--all`. Reviewers record verdicts with the
`branch_gc_verdict` MCP tool. Verdicts are keyed by repo and tip sha in
`~/.agentproto/branch-gc-verdicts.json`, and a verdict for a tip that later
moves is ignored. Concurrent `branch_gc_verdict` calls are safe in-process and
across processes: the store serialises writers with an in-process mutex plus
an OS lock file, re-reads under the lock, and commits each write with an
atomic rename, so no recorded verdict is lost. `get` also revalidates its
cache against the file's mtime/size, so a long-lived reader observes writes
from another store.

### Operator approval (bypassing the line guard)

An agreeing verdict whose tip is under `--min-line-coverage` (default 95) is
refused by `--include-reviewed`, leaving it in `review` with a `verdictGuard`
reason. That refusal list is the human queue; to clear an entry, record an
operator approval for the **same tip sha** with `branch_gc_verdict`:

```json
{
  "name": "feat/lost",
  "sha": "<full tip sha>",
  "reviewer": "repo-maintenance-reviewer",
  "triage": { "verdict": "superseded", "confidence": 0.9, "reason": "..." },
  "gate": { "agree": true, "verdict": "superseded", "reason": "...", "evidence": ["..."] },
  "operator": { "by": "jeremy", "note": "checked the residual by hand" }
}
```

`operator.by` is required; `note` is optional. The approval is stored with the
verdict's `recordedAt` timestamp. It is accepted only through the operator MCP
surface: `branch_gc_verdict` refuses an operator block when the daemon-verified
caller is an agent session (the `?callerSessionId=` identity or a scoped
mount's owner), and `POST /branches/gc/verdict` refuses it outright because
that loopback route carries no caller identity. `operator.by` must name someone
other than the verdict's `reviewer`, so an automated reviewer cannot
self-certify the override it is guarded against. An operator block without
`gate.agree: true` is not an approval. With
`includeReviewed: true` a same-tip
verdict that has `gate.agree: true` **and** an `operator` block reclaims
despite the guard; the plan entry carries
`verdictGuard: "bypassed by operator <by>...: <guard reason>"`, the apply
still writes its restore log before deleting, and a reviewer-only verdict
stays refused exactly as before.

## Examples

```bash
# What would go, what needs review, what's protected
agentproto branch gc

# Delete merged local branches and orphan tracking refs; keep remote branches
agentproto branch gc --apply --scopes local,orphan

# Hand the unmerged ones to reviewers
agentproto branch review-queue > candidates.json
```
