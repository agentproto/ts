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

## Ref kinds

| Kind | Refs |
|------|------|
| `local` | `refs/heads/*` |
| `remote` | `refs/remotes/<remote>/*` for the base's own remote (`origin` for `origin/main`) |
| `orphan` | `refs/remotes/<ns>/*` where `<ns>` is no longer a configured remote. Nothing ever prunes these. `only-copy` means no local or remote ref contains the tip, so deleting it lets `git gc` destroy the commits. |

Refs of *other* configured remotes are never classified or touched.

## Subverbs

### `gc`

| Class | Definition | `--apply` does |
|-------|-----------|----------------|
| `reclaim` | The work is provably in base: **merged** (the tip is an ancestor), **squash-merged** (`git merge-tree` result == base tree), **patch-merged** (`git cherry` all `-`, only tried when merge-tree conflicts), or **content-merged** (every file the branch changed is in base's tree by blob at any path, or gitignored, with no evolved/unique/deleted files). With `--include-reviewed`, also an unmerged ref whose stored verdict has `gate.agree` for the same tip sha. | Deletes it: `git branch -D` for local refs, `git push <remote> --delete` in batches of 50 plus `fetch --prune` for remote refs, `git update-ref -d` for orphans. |
| `review` | Unmerged, older than `--min-age-days`, not protected. Carries coverage, the files not provably in base, and the push state. | **Never touched.** |
| `hold` | Base or a protected name; a branch checked out in a worktree and its remote twin; an open PR head; every local/remote ref when open-PR detection is unavailable; unmerged and younger than `--min-age-days`. | **Never touched.** |

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | cwd | Any dir inside the repo. |
| `--base <ref>` | `origin/main` | The ref the work must be in. |
| `--scopes <kinds>` | all three | Comma-separated kinds. **Required with `--apply`.** |
| `--min-age-days N` | `3` | Unmerged refs younger than this are held. |
| `--include-reviewed` | `false` | Reclaim reviewed refs whose gate agreed (see `review-queue`). |
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
moves is ignored.

## Examples

```bash
# What would go, what needs review, what's protected
agentproto branch gc

# Delete merged local branches and orphan tracking refs; keep remote branches
agentproto branch gc --apply --scopes local,orphan

# Hand the unmerged ones to reviewers
agentproto branch review-queue > candidates.json
```
