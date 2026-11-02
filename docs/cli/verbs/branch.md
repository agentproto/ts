# `agentproto branch`

```text
agentproto branch gc           [--repo <dir>] [--base <ref>] [--scopes local,remote,orphan]
                               [--min-age-days N] [--include-reviewed] [--min-line-coverage PCT]
                               [--require-operator-below-guard] [--anchor <sha>] [--apply] [--json]
agentproto branch gc approve   <sha|branch>... --by <name> [--note <text>] [--repo <dir>]
                               [--dry-run] [--json]
agentproto branch gc restore   <restore-log> [--sha <sha>...] [--local-only] [--keep-approval]
                               [--dry-run] [--json]
agentproto branch review-queue [--repo <dir>] [--base <ref>] [--min-age-days N] [--all]
```

Classify and clean up a repo's branches. It's the sibling of
[`worktree gc`](./worktree.md#gc) and follows the same contract: a dry run by
default, a classified plan, and an apply that re-checks every entry right
before touching it. It runs locally over `@agentproto/worktree` and needs no
daemon, except `gc approve`, which records through the running daemon (see
[`gc approve`](#gc-approve)). The daemon exposes the same engine as the
`branch_gc` / `branch_gc_verdict` / `branch_gc_restore` MCP tools and as `POST /branches/gc[/verdict]`.

The summary counts refs per kind (`byClass`, `byStatus`) and, in `distinct`,
branch names across kinds: a local branch and its remote twin are one branch
with two refs, so "132 branches (149 refs)".

The `branch_gc` MCP reply is compact by default: the summary, the plan
metadata and one page of entries (name, kind, sha, class, status, plus
`reclaimReason`, `mergedPr`, `mergedPrMatch`, `holdReason`,
`lineCoverage.pct`, `verdictGuard` and `verifiedPrRefusal` when set), 100 rows per page. Pass
`page.nextCursor` back as `cursor` to read the next page of the same run
without re-running it. `classes` filters the entries, `fields` keeps only the
named keys of each full entry, and `full: true` returns whole entries (alone,
the whole unpaged result). An apply pages its outcomes by default (pass
`section: "entries"` to page the plan entries instead) and keeps the restore
log and `applySummary`; `full: true` returns every outcome. A `branch_gc`
cursor keeps the `section`, `classes`, `limit` and `full` it was created with and is
not interchangeable with `branch_gc_status`'s cursor. `POST /branches/gc` and
`--json` still return the full result.

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
| `--include-reviewed` | `false` | Reclaim reviewed refs whose gate agreed (see `review-queue`). An agreeing verdict under `--min-line-coverage` is refused unless the [verified-pr pass](#verified-pr-pass) proves it, or it carries an `operator` block (see below), which bypasses the guard and is shown as `bypassed by operator <by>`. |
| `--min-line-coverage PCT` | `95` | The line-coverage guard: the share of a tip's added lines that must already be in base. |
| `--require-operator-below-guard` | `false` | Turn the verified-pr pass off: below the guard only an operator approval reclaims. |
| `--anchor <sha>` | auto | Old-history twin of a re-rooted base's root. It's auto-detected when base has a single root and some tips share no history with it. |
| `--apply` | `false` | Execute the plan for `--scopes`. |
| `--json` | `false` | Emit `{ plan, summary }` (or `{ outcomes, restoreLog }` with `--apply`) as JSON. |

Before each delete, `--apply` lists the refs again and re-classifies the entry
from scratch. A tip that moved, vanished, or now classifies differently is
aborted instead of deleted. The restore log
(`~/.agentproto/branch-gc/<repo>/restore-<ts>.json`, with the sha and exact
re-create command per ref) is written before the first delete. Undo it with
[`gc restore`](#gc-restore).

#### Verified-pr pass

Most refusals of the line-coverage guard are false positives: the reviewer
says the branch is `superseded` by the PR that squash-merged its work, and the
lines not verbatim in base sit in a consumed `.changeset/*.md`, in a file base
later moved (`driver/agent-cli` to `packages/harness`), or in lines base
reworded after the merge. So, with `--include-reviewed`, a guard-refused
verdict still reclaims when this deterministic check holds (no LLM involved):

1. the verdict's triage and gate both say `superseded`, and the gate agreed;
2. it cites PRs: `landedIn: [{ pr, commit? }]` when the reviewer filled it,
   else every `#N` in `gate.reason` and `gate.evidence`;
3. the forge confirms at least one cited PR is MERGED into base's branch (no
   usable forge, or a lookup that fails, refuses);
4. every file with uncovered added lines is explained: a merged cited PR
   touched that path, it is a `.changeset/*.md`, or base deleted or moved the
   path in a commit that descends from a merged cited PR's merge commit (a path
   base dropped before the work landed explains nothing).

A pass is recorded as `verdictGuard: "passed by verified-pr #N: <guard>"` and
`verifiedPr: { prs, files: [{ file, why, pr? }] }` on the plan entry, and as
`guard: "verified-pr"` + `verifiedPr` on the apply outcome and the restore log
entry. A refusal keeps the entry in `review`; `verifiedPrRefusal` on the entry
and the `refused-guard` outcome names the condition that failed (for example
`1 uncovered file(s) not explained by #1101: src/new.ts`). Checkpoint refs never
take this pass.

Residual risk, accepted by design: "touched that path" is file-level. A
verdict that cites a merged PR which edited the same files passes even when
the branch's own lines never landed, so the check relies on the reviewer
citing the PR that actually landed the work; what it adds over the reviewer
alone is that the citation is a real PR, merged into base, covering every
file the guard flagged. Run with `--require-operator-below-guard` where that
is not enough, and [`gc restore`](#gc-restore) undoes any deletion.

`--require-operator-below-guard` (`requireOperatorBelowGuard`
on `branch_gc` / `POST /branches/gc`) turns it off; apply keeps the plan's
setting.

### `gc restore`

```text
agentproto branch gc restore <restore-log> [--repo <dir>] [--sha <sha>...] [--local-only] [--keep-approval] [--dry-run] [--json]
```

Re-creates the refs an apply deleted, from its restore log, into `--repo`
(default: the repo of the current directory), which must be the repo the log
names, or the restore refuses. Every command is rebuilt from the entry's
validated fields (full sha, valid branch name and ref, a configured remote, a
ref that matches its kind and name), never run from the `argv` stored in the
log; an entry that fails that check is `invalid-entry` and nothing runs for
it. A local ref is re-created with
`git branch`, a remote ref by pushing the sha back to its remote (and updating
the tracking ref), an orphan ref with `git update-ref` (a forge mirror is
re-fetched from its PR head). `--sha` (repeatable; full sha or a 7+ char
prefix) restores only those tips; a `--sha` that matches no entry is reported.
`--local-only` re-creates a remote-kind ref as a local branch of the same name
instead of pushing it.

It never overwrites: a ref with that name at another sha is
`refused-conflict`, one already at the sha is `already-present`, and a sha no
longer in the object database is `missing-commit`. Each line prints the git
command it ran. The exit code is 1 when anything was refused or failed.

Restoring also drops the operator approval from the stored verdict of every
restored tip (the reviewer verdict stays): otherwise the next
`gc --include-reviewed --apply` would delete it again on that approval,
instead of re-judging it through the line guard and the verified-pr pass.
`--keep-approval` keeps it. The daemon exposes the same as the
`branch_gc_restore` MCP tool (`repoRoot` or `workspaceSlug`, `logPath`,
`shas`, `localOnly`, `dryRun`, `keepApproval`).

```bash
# Put back two tips deleted on an approval, as local branches, and let the next run re-judge them
agentproto branch gc restore ~/.agentproto/branch-gc/ts/restore-2026-11-02T10-00-00-000Z.json \
  --repo ~/code/ts --sha 5f1c2e9a --sha 0b7d4410 --local-only
```

### `gc approve`

```text
agentproto branch gc approve <sha|branch>... --by <name> [--note <text>] [--repo <dir>] [--dry-run] [--json]
```

Records an operator approval (see [below](#operator-approval-bypassing-the-line-guard))
without retyping the verdict: for each target it reads the stored verdict, copies
it, and adds `operator: { by, note }`. A target is a full tip sha, or a branch
name whose current tip has a stored verdict (pass the sha when its local and
remote refs point at two different reviewed tips). It refuses, and records
nothing, when:

- no verdict is stored for that tip (`no-verdict`), or no branch has that name (`no-ref`);
- the stored `gate.agree` is not `true` (`not-agreed`);
- no ref named in the verdict still points at its sha (`tip-moved`): the review was of an older tip;
- `--by` names the verdict's reviewer (`by-is-reviewer`, case-insensitive).

A tip that already carries an operator block is reported as `already` and left
as it is. `--dry-run` prints the verdict it would record. The exit code is 1
when any target is refused. Approving deletes nothing; the next
`gc --include-reviewed --apply` does.

Unlike `gc`, this goes through the running daemon (`POST /branches/gc/approve`),
because the approval is the operator trust boundary. That route accepts only
`Authorization: Bearer <token>` with the per-boot token from `runtime.json`
(no loopback bypass, no allowlisted `Origin`, no `?token=`), and refuses any
request carrying a session identity: a session token, or a caller-session
claim in the query or the `x-agentproto-caller-session-id` header. The CLI
forwards `$AGENTPROTO_SESSION_ID` in that header, so running the command from
inside an agent session is refused by the daemon. No MCP tool reaches the
route.

```bash
agentproto branch gc approve 5f1c...e2 feat/lost --by jeremy --note "residual checked by hand"
```

### `review-queue`

Prints the `review` candidates as JSON, one per unique tip sha (a branch and
its remote twin share one review). Each candidate carries what a reviewer
needs: base sha, compare base, merge base, merged tree (or `null` when the
merge conflicts), coverage, and the residual files. Tips that already have a
verdict are skipped unless you pass `--all`. Reviewers record verdicts with the
`branch_gc_verdict` MCP tool; a `superseded` verdict may add
`landedIn: [{ pr, commit? }]` for the [verified-pr pass](#verified-pr-pass)
(refused on any other verdict). Verdicts are keyed by repo and tip sha in
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
operator approval for the **same tip sha**. From a shell, run
[`agentproto branch gc approve <sha> --by <name>`](#gc-approve), which copies the
stored verdict for you. From the operator MCP surface, call `branch_gc_verdict`
with the whole stored verdict plus the `operator` block:

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
verdict's `recordedAt` timestamp. It is accepted only from the operator: the
bearer-only `POST /branches/gc/approve` behind `gc approve`, or the operator MCP
surface. `branch_gc_verdict` refuses an operator block when the daemon-verified
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
