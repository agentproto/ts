/**
 * `branch gc`: the sibling of worktree `gc` (`gc.ts`) for refs instead of
 * worktrees — local branches (`refs/heads`), the base remote's tracking
 * branches (`refs/remotes/<remote>`), and ORPHAN tracking refs
 * (`refs/remotes/<ns>/*` whose `<ns>` is no longer a configured remote, which
 * nothing — not even `fetch --prune` — ever cleans up). Same contract as
 * worktree `gc`:
 *
 *   1. `planBranchGc` is pure read: every ref is classified `reclaim` /
 *      `review` / `hold` and nothing is mutated. A dry run IS "call this,
 *      print it, stop."
 *   2. `applyBranchGc` re-lists the refs and re-classifies every entry from
 *      scratch immediately before touching it; a tip that moved, vanished or
 *      now classifies differently is refused, never acted on.
 *   3. `hold` is never touched and `review` is never touched — only
 *      `reclaim`. A reviewed-unmerged ref only becomes `reclaim` via
 *      `includeReviewed` + a stored gate verdict that agreed for the SAME tip
 *      sha; this module stores and reads verdicts, it never decides them.
 *   4. Every deletion is written to a restore log (sha + exact re-create
 *      command) BEFORE the delete runs, so every apply is undoable.
 *
 * `reclaim` means "the work is provably in base", by a ladder of increasingly
 * expensive checks (`classifyTip`), ported from the audited
 * `branch-hygiene.mjs` maintenance script that first cleaned a 460-ref repo:
 *
 *   pr-merged       the tip's work went through a MERGED PR (`mergedPrMatch`):
 *                   `head` the tip IS the PR's head commit (`headRefOid`),
 *                   `ancestor` the tip is an ancestor of it (the PR kept
 *                   going after this branch stopped), `patch` every non-merge
 *                   commit of the tip has a patch-equivalent commit (same
 *                   `git patch-id --stable`, same author time + email) in
 *                   some merged PR's history (the branch was rebased, or its
 *                   commits landed split across stacked PRs). That work was
 *                   reviewed and merged, and the forge keeps every PR's
 *                   commits at `refs/pull/<N>/head`, so nothing is lost
 *                   (forge shortcut in `classifyRef`: the ladder still runs,
 *                   but an "unmerged" verdict is overridden before any
 *                   reclaim/hold decision, skipping the push-state/verdict
 *                   lookups below it). Only merged PR heads present in the
 *                   local object database count: the plan never fetches.
 *   merged          tip is an ancestor of base
 *   squash-merged   `git merge-tree --write-tree base tip` == base's tree
 *                   (merging it changes nothing)
 *   patch-merged    `git cherry` reports every commit as already applied —
 *                   ONLY tried when merge-tree conflicts (cherry patch-ids
 *                   every base commit since the merge-base: seconds per
 *                   branch on a busy base, and a clean merge with a
 *                   non-empty residual is unmerged regardless)
 *   content-merged  every path the branch changed is, BY BLOB, somewhere in
 *                   base's tree (any path — survives moves/reorgs) or
 *                   gitignored there, with zero `evolved` (same basename in
 *                   base, other content), zero `unique`, zero `deletes`
 *   forge-mirror    (orphan refs only, checked BEFORE the ladder) the tip IS a
 *                   `refs/pull/<N>/head` of the base remote (one `git
 *                   ls-remote` per plan). GitHub keeps those forever, so the
 *                   ref is a mirror, never the only copy — agents create them
 *                   in bulk with `git fetch origin '+refs/pull/N/head:refs/remotes/pr/N'`.
 *                   Its restore command re-fetches the PR head (the local
 *                   commits may have been gc'd). ls-remote failing = no
 *                   shortcut, the ladder runs as usual.
 *
 * Anything else is `unmerged` and — once older than `minAgeDays` and not
 * protected — becomes `review`, carrying everything a reviewer needs (coverage
 * summary, the files NOT provably in base, the share of added lines already in
 * base, push state).
 *
 * LINE-COVERAGE GUARD. `evolved` only says "a file with that name exists in
 * base" — always true for a file both sides edited — which a reviewer can
 * mistake for "the change landed". So every unmerged tip also carries
 * `lineCoverage`: of the non-trivial lines it adds to its evolved + unique
 * files, the share found verbatim in base's version of the same path. A stored
 * verdict with `gate.agree: true` only reclaims (`includeReviewed`) when that
 * share is at least `minLineCoverage` (default 95); below it the entry stays
 * `review` with `verdictGuard` saying why, and apply reports it as
 * `refused-guard`. Ported from the reference script after a flash-model
 * reviewer approved 158/167 tips citing "base has foo.ts", some at 0-15%
 * line coverage.
 *
 * VERIFIED-PR PASS. Most guard refusals of a `superseded` verdict are false
 * positives of the line measure: the work landed through a squash-merged PR,
 * and the lines not verbatim in base sit in a consumed `.changeset/*.md`, in
 * a file base later moved, or in lines base reworded after the merge. So a
 * refused tip still reclaims (`verdictGuard: "passed by verified-pr ..."`,
 * `verifiedPr` on the entry, the apply outcome and the restore log) when a
 * second, deterministic proof holds (`verifiedPrCheck`, no LLM): both triage
 * and gate say `superseded` and agree, the verdict cites PRs (`landedIn`, else
 * `#N` in gate.reason/evidence), the forge confirms at least one of them
 * MERGED into base's branch, and every file carrying uncovered added lines
 * was touched by such a PR, is a `.changeset/*.md`, is a path base
 * deleted or moved after such a PR merged, or is proven line by line by the
 * DEP-BUMP per-file rules below (`manifest-proven`). Anything else, or no forge, keeps the refusal
 * (`verifiedPrRefusal` says which condition failed). On by default;
 * `requireOperatorBelowGuard` turns it off. Never for checkpoint refs.
 *
 * DEP-BUMP PASS. Automated dependency-bump branches fail the line guard by
 * construction: their only added lines are version specs, a lockfile and a
 * changeset, and base moves those same specs on by the time anyone looks.
 * When `verified-pr` refuses, a tip with an agreeing `obsolete` or
 * `superseded` verdict still reclaims (`verdictGuard: "passed by dep-bump
 * ..."`, `depBump` on the entry, the apply outcome and the restore log) when
 * `depBumpCheck` proves, from git objects only, that every line it adds is
 * regenerable or already superseded on base: `pnpm-lock.yaml`, a
 * `.changeset/*.md`, or a `package.json` change that is only dependency
 * entries base declares at an equal or higher lower bound, a `version`
 * base already reached, or a `packageManager` pin base declares at the same
 * or a newer version (hash ignored). Anything else keeps the refusal (`depBumpRefusal`
 * names the first unexplained line). Same switch, same exclusions as
 * `verified-pr`.
 *
 * HISTORY-COVERED PASS. The next most common false positive is a tip whose
 * missing lines are older wording base has since rewritten (a stale
 * generated snapshot, a revert to a value base once had). When `dep-bump`
 * refuses too, an agreeing `obsolete` or `superseded` verdict still reclaims
 * (`verdictGuard: "passed by history-covered ..."`, `historyCovered` on the
 * entry, the apply outcome and the restore log) when `historyCoveredCheck`
 * proves every changed file is either proven by the `dep-bump` per-file rules
 * or a text file whose every uncovered added line was ADDED to that same path
 * (or the path base moved it to) by some commit reachable from base, and that
 * deletes no line base still has: every line is recoverable from base's own
 * history. Bounded per tip; past the bound it refuses. Anything else keeps
 * the refusal (`historyRefusal`). Same switch, same exclusions as `dep-bump`.
 *
 * One ref family is classified against something other than base: a SANDBOX
 * CHECKPOINT branch (remote kind, name `agentproto-checkpoint/<work>` — the
 * force-pushed snapshot of a sandbox box's uncommitted work). Its tip is a
 * snapshot commit that never merges, so the ladder on the tip proves nothing;
 * instead the branch is judged by its WORK branch, pinned to the snapshot's
 * PARENT commit (`<checkpoint>^`, the work-branch HEAD the box snapshotted
 * on — branch names get reused, so "the branch is merged" alone may prove a
 * different generation landed): reclaim (`checkpoint-superseded`) only when
 * that parent landed too (equals/is an ancestor of a merged work-branch tip,
 * or equals a merged PR head that landed the same name while the branch is
 * gone), work is the head of an open PR ⇒ `hold` (`open-pr`), anything else
 * — including a parentless snapshot or a failed parent lookup — ⇒ `review`,
 * a dead box's checkpoint may be the only copy of its work.
 * `young`/`protected` holds still apply first.
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import semver from "semver"
import { z } from "zod"
import { execArgv, type ExecResult } from "./exec.js"
import type { ForgeClient, ForgePullRequestFacts } from "./forge.js"
import { listGitWorktrees } from "./status.js"
import { repoLabel } from "./services/context.js"

// ── types ────────────────────────────────────────────────────────────

export const BRANCH_GC_SCOPES = ["local", "remote", "orphan"] as const
/** `local` = refs/heads, `remote` = the base remote's tracking refs, `orphan` = refs/remotes/<ns>/* of a remote that no longer exists. */
export type BranchRefKind = (typeof BRANCH_GC_SCOPES)[number]

/** Remote-branch namespace a sandbox session snapshots uncommitted work into
 *  (`agentproto-checkpoint/<work-branch>`) — `sandbox-delivery.ts`'s
 *  `CHECKPOINT_BRANCH_PREFIX`, duplicated here so the worktree package keeps
 *  no runtime dependency. A remote ref under this prefix is classified
 *  against its WORK branch, not against base. */
export const CHECKPOINT_BRANCH_PREFIX = "agentproto-checkpoint/"

/** The verdict for one tip, in order of increasing cost (`pr-merged` is the forge shortcut that overrides an "unmerged" ladder verdict, not a check that skips the ladder; `forge-mirror` is the orphan-only shortcut that DOES skip it). */
export type BranchStatus = "pr-merged" | "forge-mirror" | "merged" | "squash-merged" | "patch-merged" | "content-merged" | "unmerged"

/**
 * How a `pr-merged` tip matched a merged PR: `head` the tip IS its head
 * commit, `ancestor` the tip is an ancestor of that head, `patch` every
 * non-merge commit of the tip is patch-equivalent to a commit of a merged PR.
 */
export type MergedPrMatch = "head" | "ancestor" | "patch"

/**
 * `current`: the tip shares history with base. `pre-rewrite`: it doesn't, but
 * base was re-rooted and an anchor (the old-history twin of base's root)
 * answers for it. `unrelated`: no shared history and no anchor — unmerged by
 * definition, since nothing can prove it landed.
 */
export type BranchHistory = "current" | "pre-rewrite" | "unrelated"

export type BranchGcClass = "reclaim" | "review" | "hold"

/**
 * Why a `reclaim` entry is reclaimable: one of the ladder's proven tiers, a
 * stored gate verdict (`includeReviewed`), or a sandbox checkpoint branch
 * whose work branch is merged (`checkpoint-superseded`).
 */
export type BranchGcReclaimReason = Exclude<BranchStatus, "unmerged"> | "reviewed" | "checkpoint-superseded"

/**
 * Why an entry is `hold`:
 *   - `protected`: base or a well-known protected name (main, master, …)
 *   - `worktree`: checked out in a worktree — the local branch AND its remote
 *     twin (a live worktree may still push to it)
 *   - `open-pr`: the head of an open PR
 *   - `pr-check-unavailable`: open-PR detection could not run, so every
 *     local/remote ref is held rather than silently losing that protection
 *   - `young`: unmerged and younger than `minAgeDays`
 */
export type BranchGcHoldReason = "protected" | "worktree" | "open-pr" | "pr-check-unavailable" | "young"

/**
 * Where else an unmerged tip lives — matters because deleting the only copy
 * lets `git gc` destroy the commits. Local refs: `same-tip-on-remote` /
 * `contained-in-remote` / `diverged-from-remote` / `local-only`. Orphan refs:
 * `contained-elsewhere` / `only-copy`.
 */
export type BranchPushState =
  | "same-tip-on-remote"
  | "contained-in-remote"
  | "diverged-from-remote"
  | "local-only"
  | "contained-elsewhere"
  | "only-copy"

/**
 * Content coverage of everything the branch changed (merge-base..tip), file
 * by file, against base's CONTENT rather than its history:
 *   covered   the exact blob exists somewhere in base (moved or copied)
 *   ignored   gitignored in the repo (generated output)
 *   evolved   a same-named file exists in base with other content
 *   unique    no trace in base
 *   deletes   the branch deletes a path base still has (an unlanded intent)
 * evolved + unique + deletes == 0 → nothing but history is lost by deleting.
 */
export interface BranchCoverage {
  residual: number
  covered: number
  ignored: number
  evolved: number
  unique: number
  deletes: number
}

/**
 * Of the non-trivial lines (≥ 8 chars once trimmed) a tip adds to its evolved
 * and unique files (`git diff -U0 mergeBase..tip`; lockfiles, images and
 * `*.enc.env` skipped — their lines never match), how many exist verbatim in
 * base's version of the same path. `pct` is 100 when nothing was added.
 */
export interface BranchLineCoverage {
  added: number
  inBase: number
  /** One decimal, e.g. 87.5. */
  pct: number
  /** Up to 12 added lines NOT in base (each cut to 120 chars), in residual-file order. */
  missing: Array<{ file: string; line: string }>
  /** EVERY file with at least one added line not in base (uncapped): what the `verified-pr` pass must explain. Absent on a plan from before it existed. */
  missingFiles?: string[]
}

export interface TipClassification {
  status: BranchStatus
  history: BranchHistory
  /** Commits on the tip not in the compare base; `null` for an unrelated tip. */
  ahead: number | null
  /** Commits in the compare base not on the tip; `null` when not computed. */
  behind: number | null
  /** Set once merge-tree ran: `true` when merging into base conflicts. */
  conflicts?: boolean
  /** Base, or the anchor for a pre-rewrite tip — what ancestry/cherry ran against. Set for `unmerged`. */
  compareBase?: string
  mergeBase?: string
  /** Tree of base-with-the-branch-merged, `null` when the merge conflicts. Set for `unmerged`. */
  mergedTree?: string | null
  coverage?: BranchCoverage
  /** The files a reviewer must look at: unique, then evolved, then deletes. Capped at 200. */
  residualFiles?: string[]
  residualFileCount?: number
  /** Set for `unmerged`: see {@link BranchLineCoverage}. */
  lineCoverage?: BranchLineCoverage
  /** Set for `unmerged`: `git cherry` against the compare base — commits with no patch-equivalent there. */
  cherry?: { total: number; unmatched: number }
}

export interface BranchRef {
  kind: BranchRefKind
  /** Short name: `feat/x` for local/remote, `<ns>/feat/x` for an orphan. */
  name: string
  /** Full ref, e.g. `refs/remotes/origin/feat/x`. */
  ref: string
  sha: string
  /** Committer date of the tip, ISO-8601. */
  date: string
  author: string
  subject: string
  /** The remote a `remote`-kind ref belongs to. */
  remote?: string
}

/**
 * The forge's PR for a branch, looked up by HEAD BRANCH NAME in the bulk PR
 * lists (no per-branch call): its open PR, else its newest merged PR, else its
 * newest PR closed without merging, else `none`. By name only, so a `merged`
 * here says a PR from this branch name merged, not that this tip landed (an
 * exact-head match is `mergedPr` instead). Absent when a list it needed was
 * unavailable or hit the 1000-PR cap: no answer is never reported as `none`.
 */
export interface BranchHeadPr {
  state: "open" | "merged" | "closed-unmerged" | "none"
  /** The PR number; absent for `none`. */
  number?: number
}

/** Summary of a stored verdict for this exact tip, when one exists. */
export interface BranchVerdictSummary {
  triage: BranchTriageVerdict
  agree: boolean | null
  reviewer: string
  /** Human operator approval that overrides the line-coverage guard, when present. */
  operator?: { by: string; note?: string }
  /** The gate's verdict, when the verdict has a gate. */
  gateVerdict?: BranchTriageVerdict
  /** The PRs the verdict cites ({@link citedPrsOf}): what the `verified-pr` pass would check. */
  citedPrs: number[]
  /** The stored record's {@link BranchVerdictRecord.revision}, when it replaced an earlier verdict. */
  revision?: number
}

/**
 * Why one file carrying uncovered added lines does not block the
 * `verified-pr` pass: `pr-touched` a cited PR merged into base touched that
 * path (`pr`), `changeset` it is a `.changeset/*.md` (consumed at release),
 * `gone-on-base` base deleted or moved that path AFTER cited PR `pr` merged,
 * `manifest-proven` the `dep-bump` per-file rules ({@link depBumpFileRefusal})
 * prove every line the tip changes in it (a `package.json` version base
 * already reached, for example).
 */
export interface VerifiedPrFile {
  file: string
  why: "pr-touched" | "changeset" | "gone-on-base" | "manifest-proven"
  pr?: number
}

/** The deterministic second proof that let a guard-refused verdict reclaim. */
export interface VerifiedPrProof {
  /** The cited PRs the forge confirmed merged into base's branch. */
  prs: number[]
  files: VerifiedPrFile[]
}

/** One file whose uncovered added lines the `history-covered` pass found in base's history of that path. */
export interface HistoryCoveredFile {
  file: string
  /** Uncovered added lines found as added lines in base's history. */
  lines: number
  /** Of the newest base commits that added each matched line, the oldest and the newest. */
  oldest: string
  newest: string
  /** The paths base moved this one to, whose history was searched too (absent when base still has the path or never moved it). */
  movedTo?: string[]
}

/** What the `history-covered` pass checked before it let a guard-refused verdict reclaim. */
export interface HistoryCoveredProof {
  /** Files the tip changes (merge-base to tip), every one checked. */
  filesChecked: number
  /** Uncovered added lines found in base's history, across `files`. */
  linesMatched: number
  files: HistoryCoveredFile[]
}

/** What the `dep-bump` pass checked before it let a guard-refused verdict reclaim. */
export interface DepBumpProof {
  /** Dependency entries (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, `pnpm.overrides`) the tip changed, each declared on base at an equal or higher lower bound (or gone from every base package). */
  dependencies: number
  /** `version` fields (and `packageManager` pins) the tip changed that base already reached. */
  versions: number
  /** Lines added to `pnpm-lock.yaml` files (regenerable). */
  lockfileLines: number
  /** Lines added to `.changeset/*.md` files (consumed at release). */
  changesetLines: number
  /** The `package.json` files checked. */
  packageFiles: string[]
  /** Of those, the ones whose package base no longer has anywhere (no base `package.json` with that `name`). */
  goneOnBase?: string[]
}

export interface BranchGcPlanEntry extends BranchRef, TipClassification {
  ageDays: number
  class: BranchGcClass
  reclaimReason?: BranchGcReclaimReason
  holdReason?: BranchGcHoldReason
  /** Human detail for a hold: the worktree path, `PR #n`, or why the PR check failed. */
  holdDetail?: string
  /** Set when the status is `pr-merged`: the number of the merged PR that carried this tip's work (the first one, for `patch`). */
  mergedPr?: number
  /** Set when the status is `pr-merged`: how the tip matched that PR. */
  mergedPrMatch?: MergedPrMatch
  /** Set when the status is `forge-mirror`: the PR whose `refs/pull/<N>/head` IS this tip. */
  forgePr?: number
  /** Set for unmerged local and remote refs: see {@link BranchHeadPr}. */
  headPr?: BranchHeadPr
  /** Set for unmerged local and orphan refs. */
  pushed?: BranchPushState
  verdict?: BranchVerdictSummary
  /**
   * `includeReviewed` guard outcome: why an agreeing verdict was refused
   * (`review` class, e.g. line coverage under `minLineCoverage`), or
   * `bypassed by operator <by>: <why>` when an operator approval reclaimed it
   * despite the guard, or `passed by verified-pr #N: <why>` when the
   * `verified-pr` pass reclaimed it.
   */
  verdictGuard?: string
  /** Set when the `verified-pr` pass reclaimed a guard-refused verdict. */
  verifiedPr?: VerifiedPrProof
  /** Set when the guard refused and the `verified-pr` pass did too: the condition that failed. */
  verifiedPrRefusal?: string
  /** Set when the `dep-bump` pass reclaimed a guard-refused verdict. */
  depBump?: DepBumpProof
  /** Set when the guard, `verified-pr` and the `dep-bump` pass all refused: the first line `dep-bump` could not explain. */
  depBumpRefusal?: string
  /** Set when the `history-covered` pass reclaimed a guard-refused verdict. */
  historyCovered?: HistoryCoveredProof
  /** Set when the `history-covered` pass refused too: the first file or line it could not find in base's history. */
  historyRefusal?: string
}

export interface BranchGcPlan {
  repoRoot: string
  repoName: string
  base: string
  baseSha: string
  baseTree: string
  /** The remote whose tracking refs are `remote`-kind — the base's own remote. `null` when base isn't a remote ref and there is no `origin`. */
  remote: string | null
  /** Old-history twin of base's root for a re-rooted base, else `null`. */
  anchor: string | null
  prCheck: { available: boolean; reason?: string }
  scopes: BranchRefKind[]
  minAgeDays: number
  includeReviewed: boolean
  /** An agreeing verdict only reclaims when the tip's line coverage is at least this (percent). */
  minLineCoverage: number
  /** true = no `verified-pr`, `dep-bump` or `history-covered` pass: below the line guard only an operator approval reclaims. Absent on an older plan (= false). */
  requireOperatorBelowGuard?: boolean
  /** `git ls-remote <remote> refs/pull/<N>/head` for the forge-mirror shortcut: unavailable = no shortcut. */
  forgeMirrorCheck: { available: boolean; reason?: string }
  generatedAt: string
  /** Refs of OTHER configured remotes: never classified, never touched. */
  otherRemoteRefs: number
  /** true = `git fetch --prune` of the base remote succeeded; false = it failed; null = skipped (opt-out or no remote). */
  fetched: boolean | null
  entries: BranchGcPlanEntry[]
}

// ── git plumbing ─────────────────────────────────────────────────────

function git(repoRoot: string, args: readonly string[], env?: Record<string, string>): Promise<ExecResult> {
  return execArgv("git", ["-C", repoRoot, ...args], repoRoot, env ? { env } : {})
}

async function gitOk(repoRoot: string, args: readonly string[]): Promise<string> {
  const res = await git(repoRoot, args)
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`)
  }
  return res.stdout
}

async function pool<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return results
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const basenameOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1)

// ── the ladder ───────────────────────────────────────────────────────

/** Base content index, built once per base: path→blob, every blob, every basename. */
export interface TreeIndex {
  byPath: Map<string, string>
  blobs: Set<string>
  names: Set<string>
}

async function indexTree(repoRoot: string, sha: string): Promise<TreeIndex> {
  const byPath = new Map<string, string>()
  for (const rec of (await gitOk(repoRoot, ["ls-tree", "-r", "-z", sha])).split("\0")) {
    const tab = rec.indexOf("\t")
    if (tab < 0) continue
    const blob = rec.slice(0, tab).split(" ")[2]
    if (blob) byPath.set(rec.slice(tab + 1), blob)
  }
  const names = new Set([...byPath.keys()].map(basenameOf))
  return { byPath, blobs: new Set(byPath.values()), names }
}

export interface LadderContext {
  repoRoot: string
  baseSha: string
  baseTree: string
  anchor: string | null
  /** Built lazily: only content coverage needs it. */
  index: () => Promise<TreeIndex>
  /** Tip sha → "shares history with `baseSha`", when already known (the
   *  plan's anchor detection asks the same question of every tip) — saves
   *  the ladder's first `merge-base` per tip. */
  related?: ReadonlyMap<string, boolean>
  /** Tip sha → `git merge-base baseSha tip`, filled by the same pass as
   *  `related` — saves the ladder's second `merge-base` per related tip. */
  mergeBases?: ReadonlyMap<string, string>
  /**
   * Memoized `git patch-id --stable` of non-merge commits (the key `git
   * cherry` matches on), batched and shared across tips: `git cherry` re-did
   * the patch-id of every base commit since the merge-base for EVERY tip.
   * `null` for a commit with no patch (empty diff) and `null` for the whole
   * call when git failed — both mean "ask `git cherry` itself".
   */
  patchIds?: (shas: readonly string[]) => Promise<Map<string, string | null> | null>
  /**
   * Memoized set of every commit reachable from `cmp` (at most two distinct
   * values: `baseSha` and the anchor) — ONE `git rev-list <cmp>` replaces one
   * `merge-base --is-ancestor` per tip. `null` above 500 000 commits (or on a
   * git failure) = fall back to the per-tip call.
   */
  ancestorsOf?: (cmp: string) => Promise<Set<string> | null>
}

export async function createLadderContext(
  repoRoot: string,
  baseRef: string,
  anchor: string | null,
  related?: ReadonlyMap<string, boolean>,
  mergeBases?: ReadonlyMap<string, string>,
): Promise<LadderContext> {
  const baseSha = (await gitOk(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim()
  const baseTree = (await gitOk(repoRoot, ["rev-parse", `${baseSha}^{tree}`])).trim()
  let idx: Promise<TreeIndex> | null = null
  const ancestors = new Map<string, Promise<Set<string> | null>>()
  const ancestorsOf = (cmp: string): Promise<Set<string> | null> => {
    let p = ancestors.get(cmp)
    if (!p) {
      p = (async () => {
        const res = await git(repoRoot, ["rev-list", cmp])
        if (res.exitCode !== 0) return null
        const shas = res.stdout.split("\n")
        if (shas.length > 500_000) return null
        return new Set(shas.filter(Boolean))
      })()
      ancestors.set(cmp, p)
    }
    return p
  }
  const patchIdCache = new Map<string, Promise<string | null>>()
  const patchIds = async (shas: readonly string[]): Promise<Map<string, string | null> | null> => {
    const fresh = [...new Set(shas)].filter((sha) => !patchIdCache.has(sha))
    if (fresh.length) {
      // Claim every sha BEFORE computing: concurrent tips ask for overlapping
      // base commits, and each must be hashed once.
      const settle = new Map<string, { resolve: (id: string | null) => void; reject: (e: unknown) => void }>()
      for (const sha of fresh) {
        const p = new Promise<string | null>((resolve, reject) => settle.set(sha, { resolve, reject }))
        p.catch(() => patchIdCache.delete(sha))
        patchIdCache.set(sha, p)
      }
      await pool(chunk(fresh, PATCH_ID_BATCH), 2, async (batch) => {
        try {
          const got = await patchIdsOf(repoRoot, batch)
          for (const sha of batch) settle.get(sha)?.resolve(got.get(sha) ?? null)
        } catch (err) {
          for (const sha of batch) settle.get(sha)?.reject(err)
        }
      })
    }
    try {
      const out = new Map<string, string | null>()
      for (const sha of shas) out.set(sha, (await patchIdCache.get(sha)) ?? null)
      return out
    } catch {
      return null
    }
  }
  return {
    repoRoot,
    baseSha,
    baseTree,
    anchor,
    index: () => (idx ??= indexTree(repoRoot, baseSha)),
    ancestorsOf,
    patchIds,
    ...(related ? { related } : {}),
    ...(mergeBases ? { mergeBases } : {}),
  }
}

const PATCH_ID_BATCH = 500

/**
 * `git log -p | git patch-id --stable` over exactly `shas`. Options mirror what
 * `git cherry` hashes (no rename detection, no external/textconv diff, default
 * prefixes); `--stable` matches cherry's file-order-independent id. Streams —
 * a base commit's patch can be large.
 */
function patchIdsOf(repoRoot: string, shas: readonly string[]): Promise<Map<string, string>> {
  return new Promise((resolvePromise, reject) => {
    const log = spawn(
      "git",
      [
        "-C", repoRoot,
        "-c", "diff.noprefix=false",
        "-c", "diff.mnemonicPrefix=false",
        "log", "--no-walk=unsorted", "--stdin", "-p", "--no-color", "--no-renames", "--no-textconv", "--no-ext-diff",
      ],
      { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
    )
    const pid = spawn("git", ["-C", repoRoot, "patch-id", "--stable"], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] })
    let out = ""
    let logCode: number | null = null
    let pidCode: number | null = null
    let failed = false
    const fail = (err: unknown): void => {
      if (failed) return
      failed = true
      log.kill()
      pid.kill()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const done = (): void => {
      if (failed || logCode === null || pidCode === null) return
      if (logCode !== 0 || pidCode !== 0) return fail(new Error(`patch-id batch failed (log exit ${logCode}, patch-id exit ${pidCode})`))
      const ids = new Map<string, string>()
      for (const line of out.split("\n")) {
        const [id, commit] = line.split(" ")
        if (id && commit) ids.set(commit, id)
      }
      resolvePromise(ids)
    }
    log.stdout.pipe(pid.stdin)
    log.stdout.on("error", fail)
    pid.stdin.on("error", () => {})
    pid.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")))
    log.stderr.resume()
    pid.stderr.resume()
    log.on("error", fail)
    pid.on("error", fail)
    log.on("close", (code) => {
      logCode = code ?? -1
      done()
    })
    pid.on("close", (code) => {
      pidCode = code ?? -1
      done()
    })
    log.stdin.on("error", () => {})
    log.stdin.end(shas.join("\n") + "\n")
  })
}

/**
 * Does every non-merge commit `cmp..tip` have a patch-equivalent among the
 * non-merge commits `tip..cmp`? Same question `git cherry cmp tip` answers
 * ("no `+` line"), from memoized patch-ids. `false` is definitive ("there is a
 * `+`"); `true`/`null` (cannot tell: git failed, or a commit has no patch-id)
 * are only candidates and the caller confirms with `git cherry` itself — so a
 * discrepancy here can only cost a missed shortcut, never a wrong reclaim.
 */
async function allPatchEquivalent(ctx: LadderContext, cmp: string, tip: string): Promise<boolean | null> {
  if (!ctx.patchIds) return null
  const lines = async (range: string): Promise<string[]> =>
    (await gitOk(ctx.repoRoot, ["rev-list", "--no-merges", range])).split("\n").filter(Boolean)
  const [tipOnly, upstreamOnly] = await Promise.all([lines(`${cmp}..${tip}`), lines(`${tip}..${cmp}`)])
  const ids = await ctx.patchIds([...tipOnly, ...upstreamOnly])
  if (!ids) return null
  const upstream = new Set<string>()
  for (const sha of upstreamOnly) {
    const id = ids.get(sha)
    if (id) upstream.add(id)
  }
  let unknown = false
  for (const sha of tipOnly) {
    const id = ids.get(sha)
    if (!id) unknown = true
    else if (!upstream.has(id)) return false
  }
  return unknown ? null : true
}

const NULL_SHA_RE = /^0+$/

/** Per changed path (merge-base..tip, no rename detection): the tip's blob, or `null` when the tip deletes it. */
async function changedBlobs(repoRoot: string, mergeBase: string, tip: string): Promise<Map<string, string | null>> {
  const out = await gitOk(repoRoot, ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", mergeBase, tip])
  const parts = out.split("\0")
  const changed = new Map<string, string | null>()
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i] ?? ""
    const path = parts[i + 1] ?? ""
    if (!meta.startsWith(":") || !path) continue
    const dst = meta.slice(1).split(" ")[3] ?? ""
    changed.set(path, NULL_SHA_RE.test(dst) ? null : dst)
  }
  return changed
}

/** `git <args>` with `input` on stdin (`execArgv` has no stdin). */
function gitWithInput(repoRoot: string, args: readonly string[], input: string): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", repoRoot, ...args], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }))
    child.stdin.end(input)
  })
}

/** `git check-ignore --no-index` over a path list (NUL-delimited both ways, so odd filenames survive). */
async function ignoredPaths(repoRoot: string, paths: readonly string[]): Promise<Set<string>> {
  const res = await gitWithInput(repoRoot, ["check-ignore", "--no-index", "--stdin", "-z"], paths.join("\0") + "\0")
  // exit 1 = none of these are ignored — a valid answer, not an error.
  if (res.exitCode !== 0 && res.exitCode !== 1) return new Set()
  return new Set(res.stdout.split("\0").filter(Boolean))
}

interface CoverageDetail extends BranchCoverage {
  evolvedFiles: string[]
  uniqueFiles: string[]
  deletedFiles: string[]
}

async function coverage(ctx: LadderContext, tip: string, mergeBase: string): Promise<CoverageDetail> {
  const idx = await ctx.index()
  const changed = await changedBlobs(ctx.repoRoot, mergeBase, tip)
  const c: CoverageDetail = { residual: 0, covered: 0, ignored: 0, evolved: 0, unique: 0, deletes: 0, evolvedFiles: [], uniqueFiles: [], deletedFiles: [] }
  const pending: string[] = []
  for (const [p, tipBlob] of changed) {
    const baseBlob = idx.byPath.get(p) ?? null
    if (tipBlob === baseBlob) continue
    c.residual++
    if (tipBlob === null) c.deletedFiles.push(p)
    else if (idx.blobs.has(tipBlob)) c.covered++
    else pending.push(p)
  }
  const ignored = pending.length ? await ignoredPaths(ctx.repoRoot, pending) : new Set<string>()
  for (const p of pending) {
    if (ignored.has(p)) c.ignored++
    else if (idx.names.has(basenameOf(p))) c.evolvedFiles.push(p)
    else c.uniqueFiles.push(p)
  }
  c.evolved = c.evolvedFiles.length
  c.unique = c.uniqueFiles.length
  c.deletes = c.deletedFiles.length
  return c
}

export const DEFAULT_MIN_LINE_COVERAGE = 95
/** Lockfiles, images and sops-encrypted envs: their lines never match by construction. */
const LINE_SKIP_RE = /(\.lock|lock\.ya?ml|package-lock\.json|\.enc\.env|\.(png|jpe?g|gif|webp|svg|ico|pdf))$/
const LINE_MIN_LENGTH = 8
const LINE_MISSING_CAP = 12

/**
 * {@link BranchLineCoverage} of `files` (the tip's evolved + unique files):
 * per file, the `+` lines of `git diff -U0 mergeBase tip` against the set of
 * trimmed lines of base's blob at the SAME path (none for a unique file). A
 * file whose diff fails is skipped, never counted as covered.
 */
async function lineCoverage(ctx: LadderContext, tip: string, mergeBase: string, files: readonly string[]): Promise<BranchLineCoverage> {
  const idx = await ctx.index()
  const perFile = await pool(
    files.filter((f) => !LINE_SKIP_RE.test(f)),
    4,
    async (file) => {
      const d = await git(ctx.repoRoot, ["--literal-pathspecs", "diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", mergeBase, tip, "--", file])
      if (d.exitCode !== 0) return null
      const blob = idx.byPath.get(file)
      const baseLines = new Set<string>()
      if (blob) {
        const shown = await git(ctx.repoRoot, ["cat-file", "blob", blob])
        if (shown.exitCode === 0) for (const l of shown.stdout.split("\n")) baseLines.add(l.trim())
      }
      let added = 0
      let inBase = 0
      const missing: BranchLineCoverage["missing"] = []
      let inHunk = false
      for (const l of d.stdout.split("\n")) {
        // Everything before the first `@@` is the file header (`+++ b/…`).
        if (l.startsWith("@@")) inHunk = true
        if (!inHunk || !l.startsWith("+")) continue
        const line = l.slice(1).trim()
        if (line.length < LINE_MIN_LENGTH) continue
        added++
        if (baseLines.has(line)) inBase++
        else if (missing.length < LINE_MISSING_CAP) missing.push({ file, line: line.slice(0, 120) })
      }
      return { file, added, inBase, missing }
    },
  )
  let added = 0
  let inBase = 0
  const missing: BranchLineCoverage["missing"] = []
  const missingFiles: string[] = []
  for (const r of perFile) {
    if (!r) continue
    added += r.added
    inBase += r.inBase
    if (r.inBase < r.added) missingFiles.push(r.file)
    for (const m of r.missing) if (missing.length < LINE_MISSING_CAP) missing.push(m)
  }
  return { added, inBase, pct: added ? Math.round((1000 * inBase) / added) / 10 : 100, missing, missingFiles }
}

/** Why an agreeing verdict must NOT reclaim this entry, or `null` when its line coverage backs it (or was never computed). */
export function lineCoverageGuard(lc: BranchLineCoverage | undefined, minLineCoverage: number): string | null {
  if (!lc || lc.pct >= minLineCoverage) return null
  return `line coverage ${lc.pct}% of ${lc.added} added lines (< ${minLineCoverage}%)`
}

/**
 * Run the ladder for one tip against `ctx`'s base. Pure read. A tip with no
 * history in common with base is checked against the anchor when there is one
 * (ancestry/cherry against the anchor; merge-tree with
 * `--merge-base=merge-base(anchor, tip)`), else it is `unmerged`/`unrelated`.
 */
export async function classifyTip(ctx: LadderContext, tip: string): Promise<TipClassification> {
  const { repoRoot, baseSha, baseTree, anchor } = ctx
  let relatedMergeBase = ctx.mergeBases?.get(tip)
  let related = ctx.related?.get(tip)
  if (related === undefined) {
    const res = await git(repoRoot, ["merge-base", baseSha, tip])
    related = res.exitCode === 0
    if (related) relatedMergeBase = res.stdout.trim()
  }
  if (!related && !anchor) return { status: "unmerged", history: "unrelated", conflicts: true, ahead: null, behind: null }
  const cmp = related ? baseSha : (anchor as string)
  // A tip unrelated to the anchor too (e.g. a ref fetched from another repo)
  // has no merge-base to diff or merge-tree from: unrelated, not pre-rewrite.
  let anchorMergeBase: string | undefined
  if (!related) {
    const res = await git(repoRoot, ["merge-base", cmp, tip])
    if (res.exitCode !== 0) return { status: "unmerged", history: "unrelated", conflicts: true, ahead: null, behind: null }
    anchorMergeBase = res.stdout.trim()
  }
  const history: BranchHistory = related ? "current" : "pre-rewrite"
  const ancestors = ctx.ancestorsOf ? await ctx.ancestorsOf(cmp) : null
  const isAncestor = ancestors
    ? ancestors.has(tip)
    : (await git(repoRoot, ["merge-base", "--is-ancestor", tip, cmp])).exitCode === 0
  if (isAncestor) {
    return { status: "merged", history, ahead: 0, behind: null }
  }
  const counts = (await gitOk(repoRoot, ["rev-list", "--left-right", "--count", `${cmp}...${tip}`])).trim().split(/\s+/)
  const behind = Number(counts[0])
  const ahead = Number(counts[1])
  const mergeBase = (related ? relatedMergeBase : anchorMergeBase) ?? (await git(repoRoot, ["merge-base", cmp, tip])).stdout.trim()
  const mtArgs = related ? [baseSha, tip] : [`--merge-base=${mergeBase}`, baseSha, tip]
  const mt = await git(repoRoot, ["merge-tree", "--write-tree", "--no-messages", ...mtArgs])
  const mergedTree = (mt.stdout.split("\n")[0] ?? "").trim()
  const conflicts = mt.exitCode !== 0
  if (!conflicts && mergedTree === baseTree) return { status: "squash-merged", history, ahead, behind, conflicts }
  // `false` = a `+` for sure: skip the (slow) `git cherry`. Otherwise it is
  // only a candidate — confirm with the real thing.
  if (conflicts && (await allPatchEquivalent(ctx, cmp, tip)) !== false) {
    const cherry = await gitOk(repoRoot, ["cherry", cmp, tip])
    if (!cherry.split("\n").some((l) => l.startsWith("+"))) return { status: "patch-merged", history, ahead, behind, conflicts }
  }
  const cov = await coverage(ctx, tip, mergeBase)
  const summary: BranchCoverage = {
    residual: cov.residual,
    covered: cov.covered,
    ignored: cov.ignored,
    evolved: cov.evolved,
    unique: cov.unique,
    deletes: cov.deletes,
  }
  if (cov.evolved + cov.unique + cov.deletes === 0) {
    return { status: "content-merged", history, ahead, behind, conflicts, coverage: summary }
  }
  const residualFiles = [...cov.uniqueFiles, ...cov.evolvedFiles, ...cov.deletedFiles]
  const cherryRun = await git(repoRoot, ["cherry", cmp, tip])
  const cherryLines =
    cherryRun.exitCode === 0 ? cherryRun.stdout.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")) : null
  return {
    status: "unmerged",
    history,
    ahead,
    behind,
    conflicts,
    compareBase: cmp,
    mergeBase,
    mergedTree: conflicts ? null : mergedTree,
    coverage: summary,
    residualFiles: residualFiles.slice(0, 200),
    residualFileCount: residualFiles.length,
    lineCoverage: await lineCoverage(ctx, tip, mergeBase, [...cov.uniqueFiles, ...cov.evolvedFiles]),
    ...(cherryLines ? { cherry: { total: cherryLines.length, unmatched: cherryLines.filter((l) => l.startsWith("+")).length } } : {}),
  }
}

/** Per-(repo, base sha) ladder contexts for `classifyTipAgainstBase` — the base index is the expensive part and is shared. */
const contextCache = new Map<string, Promise<LadderContext>>()

/**
 * One-shot ladder for a caller that has a single tip and no plan (worktree
 * `gc`'s content-merged promotion). No anchor: a pre-rewrite tip reads
 * `unrelated`/`unmerged` here, which only ever errs toward keeping.
 */
export async function classifyTipAgainstBase(repoRoot: string, baseRef: string, tip: string): Promise<TipClassification> {
  const baseSha = (await gitOk(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim()
  const key = `${repoRoot}\u0000${baseSha}`
  let ctx = contextCache.get(key)
  if (!ctx) {
    ctx = createLadderContext(repoRoot, baseSha, null)
    contextCache.set(key, ctx)
    ctx.catch(() => contextCache.delete(key))
  }
  return classifyTip(await ctx, tip)
}

// ── re-rooted base: anchor detection ───────────────────────────────────

/**
 * A re-rooted base (history rewritten into a fresh snapshot commit) shares no
 * ancestor with branches cut before the rewrite. The ANCHOR is the
 * old-history commit whose tree the snapshot was taken from: searched in the
 * unrelated tips' history within 3 days before the root's date, closest tree
 * to the root wins, accepted only when fewer than 200 files apart.
 */
export async function detectAnchor(
  repoRoot: string,
  baseSha: string,
  tips: readonly string[],
  /** Filled with every tip's answer (`true` = shares history with base) for
   *  the ladder to reuse — see {@link LadderContext.related}. */
  related?: Map<string, boolean>,
  /** Filled with `merge-base baseSha tip` for every related tip — see {@link LadderContext.mergeBases}. */
  mergeBases?: Map<string, string>,
): Promise<string | null> {
  const roots = (await gitOk(repoRoot, ["rev-list", "--max-parents=0", baseSha])).trim().split("\n").filter(Boolean)
  if (roots.length !== 1) return null
  const root = roots[0] as string
  // One `merge-base` per unique tip — pure reads, so run them in parallel
  // (sequential, this alone was ~2 min of a ~900-ref plan).
  const unique = [...new Set(tips)]
  const bases = await pool(unique, 8, async (sha) => {
    const res = await git(repoRoot, ["merge-base", baseSha, sha])
    return res.exitCode === 0 ? res.stdout.trim() : null
  })
  const unrelated = unique.filter((_, i) => bases[i] === null)
  if (related) unique.forEach((sha, i) => related.set(sha, bases[i] !== null))
  if (mergeBases) unique.forEach((sha, i) => bases[i] !== null && mergeBases.set(sha, bases[i] as string))
  if (!unrelated.length) return null
  const rootDate = (await gitOk(repoRoot, ["log", "-1", "--format=%cI", root])).trim()
  const since = new Date(new Date(rootDate).getTime() - 3 * 86_400_000).toISOString()
  const cands = (await gitOk(repoRoot, ["log", "--format=%H", `--since=${since}`, `--until=${rootDate}`, ...unrelated]))
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 60)
  let best: { sha: string; n: number } | null = null
  for (const c of cands) {
    const n = (await gitOk(repoRoot, ["diff", "--numstat", c, root])).trim().split("\n").filter(Boolean).length
    if (!best || n < best.n) best = { sha: c, n }
  }
  return best && best.n < 200 ? best.sha : null
}

// ── ref discovery ────────────────────────────────────────────────────

const PROTECTED_NAMES = new Set(["main", "master", "develop", "HEAD", "gh-pages"])

async function configuredRemotes(repoRoot: string): Promise<Set<string>> {
  return new Set((await gitOk(repoRoot, ["remote"])).trim().split("\n").filter(Boolean))
}

/** The remote whose tracking refs are `remote`-kind: base's own remote when base is `<remote>/…`, else `origin` if configured. */
function baseRemoteOf(base: string, remotes: ReadonlySet<string>): string | null {
  const slash = base.indexOf("/")
  if (slash > 0 && remotes.has(base.slice(0, slash))) return base.slice(0, slash)
  return remotes.has("origin") ? "origin" : null
}

interface RefListing {
  refs: BranchRef[]
  otherRemoteRefs: number
}

async function listBranchRefs(repoRoot: string, remote: string | null, remotes: ReadonlySet<string>): Promise<RefListing> {
  const fmt = "%(refname)%09%(objectname)%09%(committerdate:iso-strict)%09%(authorname)%09%(subject)"
  const out = await gitOk(repoRoot, ["for-each-ref", `--format=${fmt}`, "refs/heads", "refs/remotes"])
  const refs: BranchRef[] = []
  let otherRemoteRefs = 0
  for (const line of out.split("\n")) {
    if (!line) continue
    const [ref = "", sha = "", date = "", author = "", ...subj] = line.split("\t")
    const rest = { ref, sha, date, author, subject: subj.join("\t") }
    let entry: BranchRef
    if (ref.startsWith("refs/heads/")) {
      entry = { kind: "local", name: ref.slice("refs/heads/".length), ...rest }
    } else {
      const ns = ref.split("/")[2] ?? ""
      if (remote && ns === remote) {
        entry = { kind: "remote", name: ref.slice(`refs/remotes/${remote}/`.length), remote, ...rest }
      } else if (remotes.has(ns)) {
        otherRemoteRefs++
        continue
      } else {
        entry = { kind: "orphan", name: ref.slice("refs/remotes/".length), ...rest }
      }
    }
    if (entry.name === "HEAD" || entry.name.endsWith("/HEAD")) continue
    refs.push(entry)
  }
  return { refs, otherRemoteRefs }
}

/** branch name → worktree path, for every worktree (main checkout included — its branch is live too). */
async function worktreeBranches(repoRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const w of await listGitWorktrees(repoRoot)) if (w.branch) map.set(w.branch, w.path)
  return map
}

interface OpenPrHeads {
  available: boolean
  reason?: string
  heads: Map<string, number>
  /** The list came back under {@link FORGE_LIST_CAP}: a name missing from it has no open PR. */
  complete?: boolean
}

/** Both forge clients stop a bulk PR list at 1000 PRs (`gh pr list --limit
 *  1000`, 10 REST pages of 100). A list that long may be cut off, so a name
 *  missing from it proves nothing: `headPr` then says unknown, never `none`. */
const FORGE_LIST_CAP = 1000

async function openPrHeads(forge: ForgeClient | undefined): Promise<OpenPrHeads> {
  if (!forge) return { available: false, reason: "no forge client", heads: new Map() }
  if (!forge.listOpenPullRequests) {
    return { available: false, reason: "forge client cannot list open PRs", heads: new Map() }
  }
  try {
    const prs = await forge.listOpenPullRequests()
    const heads = new Map<string, number>()
    for (const pr of prs) if (pr.state === "open") heads.set(pr.headRefName, pr.number)
    return { available: true, heads, complete: prs.length < FORGE_LIST_CAP }
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "forge error"
    return { available: false, reason, heads: new Map() }
  }
}

/**
 * Merged PRs, indexed two ways for the `pr-merged` shortcut and for
 * checkpoint classification: head sha → PR number, and head ref name →
 * { number, headRefOid } (a checkpoint whose work branch is GONE is still
 * superseded when a merged PR landed that branch by name AND the snapshot's
 * parent is that PR's exact head — the name alone proves nothing, names get
 * reused). On any error or a forge without `listMergedPullRequests` both
 * maps are empty — never throws: unavailable just means "no shortcut", not
 * "no merged PRs", and the ladder still classifies every ref on its own.
 */
interface MergedPrIndex {
  /** The merged list was read, and came back under {@link FORGE_LIST_CAP}: an absent name means no merged PR. */
  available: boolean
  shas: Map<string, number>
  names: Map<string, { number: number; headRefOid: string }>
  /** Head ref name → its NEWEST merged PR number (`headPr`). */
  newestByName: Map<string, number>
}

async function mergedPrIndex(forge: ForgeClient | undefined): Promise<MergedPrIndex> {
  const none = (): MergedPrIndex => ({ available: false, shas: new Map(), names: new Map(), newestByName: new Map() })
  if (!forge?.listMergedPullRequests) return none()
  try {
    const shas = new Map<string, number>()
    const names = new Map<string, { number: number; headRefOid: string }>()
    const newestByName = new Map<string, number>()
    const merged = await forge.listMergedPullRequests()
    for (const pr of merged) {
      shas.set(pr.headRefOid, pr.number)
      names.set(pr.headRefName, { number: pr.number, headRefOid: pr.headRefOid })
      newestByName.set(pr.headRefName, Math.max(pr.number, newestByName.get(pr.headRefName) ?? 0))
    }
    return { available: merged.length < FORGE_LIST_CAP, shas, names, newestByName }
  } catch {
    return none()
  }
}

interface ClosedUnmergedPrHeads {
  available: boolean
  /** Head ref name → its NEWEST PR closed without merging. */
  names: Map<string, number>
}

/** PRs closed without merging, by head ref name, for `headPr`. Never throws:
 *  a failure or a forge without the bulk list just leaves `headPr` unknown. */
async function closedUnmergedPrHeads(forge: ForgeClient | undefined): Promise<ClosedUnmergedPrHeads> {
  if (!forge?.listClosedUnmergedPullRequests) return { available: false, names: new Map() }
  try {
    const names = new Map<string, number>()
    const closed = await forge.listClosedUnmergedPullRequests()
    for (const pr of closed) {
      if (pr.merged) continue
      names.set(pr.headRefName, Math.max(pr.number, names.get(pr.headRefName) ?? 0))
    }
    // Hits still answer; only a cut-off list stops a miss meaning `none`.
    return { available: closed.length < FORGE_LIST_CAP, names }
  } catch {
    return { available: false, names: new Map() }
  }
}

/** {@link BranchHeadPr} for branch `name` from the bulk lists. A hit in any
 *  list is an answer; `none` needs all three lists read in full (each under
 *  {@link FORGE_LIST_CAP}). */
function headPrOf(name: string, env: ClassifyEnv): BranchHeadPr | undefined {
  const open = env.prs.heads.get(name)
  if (open !== undefined) return { state: "open", number: open }
  const merged = env.mergedPrNewestByName.get(name)
  if (merged !== undefined) return { state: "merged", number: merged }
  const closed = env.closedUnmergedPrs.names.get(name)
  if (closed !== undefined) return { state: "closed-unmerged", number: closed }
  if (env.prs.complete === true && env.mergedPrsAvailable && env.closedUnmergedPrs.available) return { state: "none" }
  return undefined
}

interface ForgePrHeads {
  available: boolean
  reason?: string
  /** `refs/pull/<N>/head` sha → N. */
  heads: Map<string, number>
}

/**
 * Every `refs/pull/<N>/head` of `remote`, by tip sha — ONE `git ls-remote` per
 * snapshot. GitHub keeps these refs forever, so an orphan ref whose tip is one
 * of them is a mirror, never the only copy. Never throws: a failure (offline,
 * no auth, a forge without pull refs) just means no forge-mirror shortcut.
 */
async function forgePrHeadsOf(repoRoot: string, remote: string | null): Promise<ForgePrHeads> {
  if (!remote) return { available: false, reason: "no base remote", heads: new Map() }
  try {
    const res = await git(repoRoot, ["ls-remote", remote, "refs/pull/*/head"], { GIT_TERMINAL_PROMPT: "0" })
    if (res.exitCode !== 0) {
      return { available: false, reason: (res.stderr.trim().split("\n")[0] ?? "") || `ls-remote exit ${res.exitCode}`, heads: new Map() }
    }
    const heads = new Map<string, number>()
    for (const line of res.stdout.split("\n")) {
      const [sha, ref] = line.split("\t")
      const m = ref ? /^refs\/pull\/(\d+)\/head$/.exec(ref) : null
      if (sha && m) heads.set(sha, Number(m[1]))
    }
    return { available: true, heads }
  } catch (err) {
    return { available: false, reason: (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "ls-remote error", heads: new Map() }
  }
}

// ── classification of one ref ──────────────────────────────────────────

/** For a remote checkpoint ref (`agentproto-checkpoint/<work>`), the WORK
 *  branch it snapshots; `undefined` for every other ref. */
function checkpointWorkBranchOf(b: BranchRef): string | undefined {
  if (b.kind !== "remote" || !b.name.startsWith(CHECKPOINT_BRANCH_PREFIX)) return undefined
  const work = b.name.slice(CHECKPOINT_BRANCH_PREFIX.length)
  return work.length > 0 ? work : undefined
}

/** The snapshot's parent (`<checkpoint>^`) — the work-branch HEAD the box
 *  snapshotted on. `undefined` for a root commit or a failed lookup: such a
 *  checkpoint is never reclaimed. */
async function checkpointParent(env: ClassifyEnv, sha: string): Promise<string | undefined> {
  try {
    const res = await git(env.ctx.repoRoot, ["rev-parse", "--verify", "--quiet", `${sha}^`])
    if (res.exitCode !== 0) return undefined
    const parent = res.stdout.trim()
    return parent.length > 0 ? parent : undefined
  } catch {
    return undefined
  }
}

/** `maybeAncestor === tip` or a real ancestor of it (`git merge-base --is-ancestor`). */
async function isAncestorOf(env: ClassifyEnv, maybeAncestor: string, tip: string): Promise<boolean> {
  if (maybeAncestor === tip) return true
  try {
    const res = await git(env.ctx.repoRoot, ["merge-base", "--is-ancestor", maybeAncestor, tip])
    return res.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Every commit reachable from a merged PR head that is NOT in base (nor in
 * the anchor's history): the `ancestor` and `patch` pr-merged matches.
 */
interface MergedPrCommits {
  /** Commit → the merged PR whose head reaches it. */
  prOf: Map<string, number>
  /** `<author time>\t<author email>` → the non-merge commits with that key (the `patch` match's pre-filter). */
  byAuthor: Map<string, string[]>
}

/** Above this many commits the merged-PR history is abandoned: no `ancestor`/`patch` match, the ladder decides alone. */
const MAX_MERGED_PR_COMMITS = 200_000
/** A tip with more unique non-merge commits than this is never `patch`-matched. */
const MAX_PATCH_MATCH_COMMITS = 500

function excludeBaseRevs(ctx: LadderContext): string[] {
  return [ctx.baseSha, ...(ctx.anchor ? [ctx.anchor] : [])].map((s) => `^${s}`)
}

/**
 * ONE `git log --stdin` over every merged PR head, minus base: each commit
 * with the PR head that reached it (`%S`). Heads absent from the local
 * object database are skipped (`--ignore-missing`): the plan never fetches,
 * so a PR whose commits were never fetched just offers no match. Never
 * throws: `null` = no `ancestor`/`patch` match available.
 */
async function buildMergedPrCommits(ctx: LadderContext, heads: ReadonlyMap<string, number>): Promise<MergedPrCommits | null> {
  if (heads.size === 0) return null
  try {
    const res = await gitWithInput(
      ctx.repoRoot,
      ["-c", "log.showSignature=false", "log", "--ignore-missing", "--stdin", "--no-color", "--format=%H%x09%P%x09%at%x09%ae%x09%S"],
      [...heads.keys(), ...excludeBaseRevs(ctx)].join("\n") + "\n",
    )
    if (res.exitCode !== 0) return null
    const prOf = new Map<string, number>()
    const byAuthor = new Map<string, string[]>()
    for (const line of res.stdout.split("\n")) {
      const [commit, parents, at, ae, source] = line.split("\t")
      if (!commit || source === undefined) continue
      const pr = heads.get(source)
      if (pr === undefined) continue
      prOf.set(commit, pr)
      if (prOf.size > MAX_MERGED_PR_COMMITS) return null
      if (parents && parents.includes(" ")) continue // a merge: no patch to match
      const key = `${at}\t${ae}`
      byAuthor.set(key, [...(byAuthor.get(key) ?? []), commit])
    }
    return { prOf, byAuthor }
  } catch {
    return null
  }
}

/**
 * `patch` match: every non-merge commit `base..tip` has a commit in some
 * merged PR's history with the same author time + email AND the same `git
 * patch-id --stable` (what `git cherry` matches on). The author key only
 * narrows which PR commits get hashed: a rebase or cherry-pick keeps it. A
 * merge commit in `base..tip` must itself be in a merged PR's history. A tip
 * with no unique non-merge commit, or any commit left unmatched, is no
 * match.
 */
async function patchMatchMergedPr(ctx: LadderContext, idx: MergedPrCommits, tip: string): Promise<number | null> {
  if (idx.byAuthor.size === 0 || !ctx.patchIds) return null
  const res = await git(ctx.repoRoot, ["log", "--format=%H%x09%P%x09%at%x09%ae", tip, ...excludeBaseRevs(ctx), "--"])
  if (res.exitCode !== 0) return null
  const tipCommits: Array<{ sha: string; candidates: string[] }> = []
  for (const line of res.stdout.split("\n")) {
    const [commit, parents, at, ae] = line.split("\t")
    if (!commit) continue
    // A merge has no patch-id, but its conflict resolution may be the only
    // copy of some work: accept it only when that exact merge is in a merged
    // PR's history (unlike `git cherry`, which skips merges).
    if (parents && parents.includes(" ")) {
      if (!idx.prOf.has(commit)) return null
      continue
    }
    const candidates = idx.byAuthor.get(`${at}\t${ae}`)
    if (!candidates) return null
    tipCommits.push({ sha: commit, candidates })
    if (tipCommits.length > MAX_PATCH_MATCH_COMMITS) return null
  }
  if (tipCommits.length === 0) return null
  const ids = await ctx.patchIds(tipCommits.flatMap((c) => [c.sha, ...c.candidates]))
  if (!ids) return null
  let first: number | null = null
  for (const c of tipCommits) {
    const id = ids.get(c.sha)
    if (!id) return null
    const hit = c.candidates.find((cand) => ids.get(cand) === id)
    if (hit === undefined) return null
    first ??= idx.prOf.get(hit) ?? null
  }
  return first
}

/**
 * The merged PR that carried an unmerged tip's work, if any: its exact head
 * (`head`), a head it is an ancestor of (`ancestor`), or patch-equivalent
 * commits (`patch`). Memoized per tip — a local branch and its remote twin
 * share one answer. Never throws.
 */
function mergedPrMatchOf(env: ClassifyEnv, sha: string): Promise<{ pr: number; match: MergedPrMatch } | null> {
  const head = env.mergedPrShas.get(sha)
  if (head !== undefined) return Promise.resolve({ pr: head, match: "head" })
  let pending = env.prMatches.get(sha)
  if (!pending) {
    pending = (async () => {
      try {
        const idx = env.mergedPrCommits ? await env.mergedPrCommits() : null
        if (!idx) return null
        const ancestorOf = idx.prOf.get(sha)
        if (ancestorOf !== undefined) return { pr: ancestorOf, match: "ancestor" as const }
        const patchPr = await patchMatchMergedPr(env.ctx, idx, sha)
        return patchPr === null ? null : { pr: patchPr, match: "patch" as const }
      } catch {
        return null
      }
    })()
    env.prMatches.set(sha, pending)
  }
  return pending
}

/** Stamp the stored verdict for `sha` onto `entry` (`BranchVerdictSummary` shape), if one exists, and return the full record. */
async function stampVerdict(entry: BranchGcPlanEntry, sha: string, env: ClassifyEnv): Promise<BranchVerdictRecord | null> {
  const stored = env.verdicts ? await env.verdicts.get(env.repoName, sha) : null
  if (!stored) return null
  entry.verdict = {
    triage: stored.triage.verdict,
    agree: stored.gate ? stored.gate.agree : null,
    reviewer: stored.reviewer,
    ...(stored.operator ? { operator: stored.operator } : {}),
    ...(stored.gate ? { gateVerdict: stored.gate.verdict } : {}),
    citedPrs: citedPrsOf(stored),
    ...(stored.revision ? { revision: stored.revision } : {}),
  }
  return stored
}

/** A consumed-at-release changeset: losing its text loses nothing. */
const CHANGESET_RE = /(^|\/)\.changeset\/[^/]+\.md$/
const PR_REF_RE = /#(\d{1,9})\b/g
/** Bound on the PRs one verdict can make the `verified-pr` pass look up. */
const MAX_CITED_PRS = 10

/**
 * The PRs a verdict says landed its work: `landedIn` when the reviewer filled
 * it, else every `#N` in `gate.reason` and `gate.evidence` (verdicts from
 * before `landedIn` existed). First-seen order, at most 10.
 */
export function citedPrsOf(v: Pick<BranchVerdict, "gate" | "landedIn">): number[] {
  const out: number[] = []
  const add = (n: number): void => {
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n) && out.length < MAX_CITED_PRS) out.push(n)
  }
  if (v.landedIn?.length) {
    for (const l of v.landedIn) add(l.pr)
    return out
  }
  for (const text of [v.gate?.reason ?? "", ...(v.gate?.evidence ?? [])]) {
    for (const m of text.matchAll(PR_REF_RE)) add(Number(m[1]))
  }
  return out
}

type VerifiedPrResult = { ok: true; proof: VerifiedPrProof } | { ok: false; reason: string }

/** The facts of PR `n`, one forge lookup per PR per snapshot. Rejects when the forge cannot answer. */
function prFactsOf(env: ClassifyEnv, n: number): Promise<ForgePullRequestFacts | null> {
  let pending = env.prFacts.get(n)
  if (!pending) {
    const forge = env.forge as Required<Pick<ForgeClient, "pullRequestFacts">>
    pending = forge.pullRequestFacts(n)
    env.prFacts.set(n, pending)
  }
  return pending
}

/**
 * The cited PR after whose merge base deleted (or moved away) `file`: the
 * last commit of base that deleted the path (no rename detection, so a move
 * counts as a delete of the old path) must descend from that PR's merge
 * commit. A path base dropped BEFORE the work landed, or a PR whose merge
 * commit is unknown, explains nothing.
 */
async function goneAfterMerge(env: ClassifyEnv, file: string, merged: readonly ForgePullRequestFacts[]): Promise<number | undefined> {
  const res = await git(env.ctx.repoRoot, [
    "--literal-pathspecs", "log", "-1", "--no-renames", "--diff-filter=D", "--format=%H", env.ctx.baseSha, "--", file,
  ])
  const deletedIn = res.exitCode === 0 ? res.stdout.trim() : ""
  if (!deletedIn) return undefined
  for (const f of merged) {
    if (f.mergeCommitOid && (await isAncestorOf(env, f.mergeCommitOid, deletedIn))) return f.number
  }
  return undefined
}

function describePr(n: number, f: ForgePullRequestFacts | null, baseName: string): string {
  if (!f) return `#${n} not found`
  if (!f.merged) return `#${n} ${f.state === "open" ? "open" : "closed unmerged"}`
  return `#${n} merged into ${f.baseRefName}, not ${baseName}`
}

/**
 * The `verified-pr` pass: may a verdict the line guard refused reclaim
 * anyway? Deterministic, no LLM, every condition must hold:
 *   1. triage AND gate say `superseded`, and the gate agreed;
 *   2. the verdict cites PRs (`citedPrsOf`);
 *   3. the forge confirms at least one cited PR MERGED into base's branch
 *      (no forge, or a lookup that fails, refuses);
 *   4. every file with uncovered added lines (`lineCoverage.missingFiles`) is
 *      explained: one of those merged PRs touched it, it is a
 *      `.changeset/*.md`, base deleted/moved the path after one of those
 *      PRs merged, or the `dep-bump` per-file rules prove every line the tip
 *      changes in it (`depBumpFileRefusal`, `manifest-proven`).
 * The refusal reason names the first condition that failed. Residual risk,
 * accepted by design: "touched the path" is file-level, so a verdict citing a
 * PR that merely edited the same files passes even when the branch's own
 * lines never landed; the citation must still be a real merged PR.
 */
async function verifiedPrCheck(entry: BranchGcPlanEntry, record: BranchVerdictRecord, env: ClassifyEnv): Promise<VerifiedPrResult> {
  const refuse = (reason: string): VerifiedPrResult => ({ ok: false, reason })
  const gate = record.gate
  if (record.triage.verdict !== "superseded" || gate?.verdict !== "superseded") {
    return refuse(`verdict is ${record.triage.verdict}${gate && gate.verdict !== record.triage.verdict ? ` (gate ${gate.verdict})` : ""}, not superseded`)
  }
  if (gate.agree !== true) return refuse("gate did not agree")
  const cited = citedPrsOf(record)
  if (cited.length === 0) return refuse("no PR cited (landedIn, or #N in gate.reason/evidence)")
  const missingFiles = entry.lineCoverage?.missingFiles
  if (!missingFiles) return refuse("no per-file line coverage to explain")
  if (!env.forge?.pullRequestFacts) return refuse("forge unavailable: no PR lookup")
  const facts: Array<ForgePullRequestFacts | null> = []
  for (const n of cited) {
    try {
      facts.push(await prFactsOf(env, n))
    } catch (err) {
      return refuse(`forge unavailable: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`)
    }
  }
  const merged = facts.filter((f): f is ForgePullRequestFacts => f !== null && f.merged && f.baseRefName === env.baseName)
  if (merged.length === 0) {
    return refuse(`no cited PR merged into ${env.baseName}: ${cited.map((n, i) => describePr(n, facts[i] ?? null, env.baseName)).join(", ")}`)
  }
  const touchedBy = merged.map((f) => ({ pr: f.number, files: new Set(f.files) }))
  const idx = await env.ctx.index()
  const files: VerifiedPrFile[] = []
  const unexplained: string[] = []
  let changed: Map<string, ChangedFile> | null | undefined
  const uncovered = new Set(missingFiles)
  for (const file of missingFiles) {
    const pr = touchedBy.find((t) => t.files.has(file))?.pr
    if (pr !== undefined) files.push({ file, why: "pr-touched", pr })
    else if (CHANGESET_RE.test(file)) files.push({ file, why: "changeset" })
    else {
      const after = idx.byPath.has(file) ? undefined : await goneAfterMerge(env, file, merged)
      if (after !== undefined) {
        files.push({ file, why: "gone-on-base", pr: after })
        continue
      }
      if (changed === undefined) changed = await changedFilesOf(env, entry)
      const row = changed?.get(file)
      if (row && (await depBumpFileRefusal(env, entry, row, uncovered, newDepBumpTally())) === null) files.push({ file, why: "manifest-proven" })
      else unexplained.push(file)
    }
  }
  if (unexplained.length > 0) {
    const shown = unexplained.slice(0, 5).join(", ")
    return refuse(
      `${unexplained.length} uncovered file(s) not explained by ${merged.map((f) => `#${f.number}`).join(", ")}: ${shown}` +
        (unexplained.length > 5 ? `, … and ${unexplained.length - 5} more` : ""),
    )
  }
  return { ok: true, proof: { prs: merged.map((f) => f.number), files } }
}

const PNPM_LOCK_RE = /(^|\/)pnpm-lock\.yaml$/
const PACKAGE_JSON_RE = /(^|\/)package\.json$/
const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
const DEP_BUMP_VERDICTS: ReadonlySet<string> = new Set(["obsolete", "superseded"])

type DepBumpResult = { ok: true; proof: DepBumpProof } | { ok: false; reason: string }
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
const isObject = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Every `package.json` of base: package names, dependency names, `pnpm.overrides` keys. */
interface BasePackages {
  names: Set<string>
  dependencies: Set<string>
  overrides: Set<string>
}

const basePackagesCache = new WeakMap<ClassifyEnv, Promise<BasePackages>>()

/** {@link BasePackages} of base, read once per snapshot. An unreadable or unparseable file counts as declaring everything, so nothing is "gone". */
function basePackagesOf(env: ClassifyEnv): Promise<BasePackages> {
  let pending = basePackagesCache.get(env)
  if (!pending) {
    pending = (async () => {
      const idx = await env.ctx.index()
      const out: BasePackages = { names: new Set(), dependencies: new Set(), overrides: new Set() }
      const blobs = [...idx.byPath].filter(([path]) => PACKAGE_JSON_RE.test(path)).map(([, blob]) => blob)
      const parsed = await pool(blobs, 4, (blob) => jsonOfBlob(env.ctx.repoRoot, blob))
      for (const pkg of parsed) {
        if (!isObject(pkg)) throw new Error("unreadable package.json on base")
        if (typeof pkg.name === "string") out.names.add(pkg.name)
        for (const section of DEP_SECTIONS) if (isObject(pkg[section])) for (const d of Object.keys(pkg[section])) out.dependencies.add(d)
        const overrides = isObject(pkg.pnpm) ? pkg.pnpm.overrides : undefined
        if (isObject(overrides)) for (const k of Object.keys(overrides)) out.overrides.add(k)
      }
      return out
    })()
    basePackagesCache.set(env, pending)
  }
  return pending
}

/** The parsed JSON of a blob (`<rev>:<path>` or a blob sha), `undefined` when it does not exist or does not parse. */
async function jsonOfBlob(repoRoot: string, spec: string): Promise<Json | undefined> {
  const res = await git(repoRoot, ["cat-file", "blob", spec])
  if (res.exitCode !== 0) return undefined
  try {
    return JSON.parse(res.stdout) as Json
  } catch {
    return undefined
  }
}

/** The lower bound of a semver range, or `null` when `spec` is not a plain registry range (`workspace:`, `catalog:`, `npm:`, git, url, file, tag). */
export function rangeLowerBound(spec: unknown): semver.SemVer | null {
  if (typeof spec !== "string" || spec.includes(":") || spec.includes("/")) return null
  try {
    return semver.validRange(spec) ? semver.minVersion(spec) : null
  } catch {
    return null
  }
}

/** Every leaf path where `a` and `b` differ, recursing through objects (a missing side counts as an empty object). */
function changedLeaves(a: Json | undefined, b: Json | undefined, path: string[] = []): string[][] {
  if ((isObject(a) || a === undefined) && (isObject(b) || b === undefined) && (isObject(a) || isObject(b))) {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
    return [...keys].flatMap((k) => changedLeaves((a as Record<string, Json> | undefined)?.[k], (b as Record<string, Json> | undefined)?.[k], [...path, k]))
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [path]
}

function at(v: Json | undefined, path: readonly string[]): Json | undefined {
  let cur = v
  for (const k of path) cur = isObject(cur) ? cur[k] : undefined
  return cur
}

/** The first added line of `file` (merge-base..tip) not verbatim in base's file at the same path, for a refusal message. */
async function firstUncoveredLine(env: ClassifyEnv, entry: BranchGcPlanEntry, file: string): Promise<string | undefined> {
  const known = entry.lineCoverage?.missing.find((m) => m.file === file)
  if (known) return known.line
  const d = await git(env.ctx.repoRoot, ["--literal-pathspecs", "diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", entry.mergeBase as string, entry.sha, "--", file])
  if (d.exitCode !== 0) return undefined
  const blob = (await env.ctx.index()).byPath.get(file)
  const base = blob ? new Set((await git(env.ctx.repoRoot, ["cat-file", "blob", blob])).stdout.split("\n").map((l) => l.trim())) : new Set<string>()
  const lines = d.stdout.split("\n")
  const first = lines.findIndex((l) => l.startsWith("@@"))
  if (first < 0) return undefined
  for (const l of lines.slice(first)) {
    if (!l.startsWith("+")) continue
    const line = l.slice(1).trim()
    if (line.length >= LINE_MIN_LENGTH && !base.has(line)) return line.slice(0, 120)
  }
  return undefined
}

/** The first non-blank line the tip deletes from `file` (merge-base..tip) that base's file at the same path still has, trimmed and cut to 120 chars. */
async function firstDeletedLineOnBase(env: ClassifyEnv, entry: BranchGcPlanEntry, file: string): Promise<string | undefined> {
  const blob = (await env.ctx.index()).byPath.get(file)
  if (!blob) return undefined
  const d = await git(env.ctx.repoRoot, ["--literal-pathspecs", "diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", entry.mergeBase as string, entry.sha, "--", file])
  // Fail closed: a diff we cannot read proves nothing.
  if (d.exitCode !== 0) return `(diff of ${file} failed)`
  const shown = await git(env.ctx.repoRoot, ["cat-file", "blob", blob])
  if (shown.exitCode !== 0) return `(base blob of ${file} unreadable)`
  const base = new Set(shown.stdout.split("\n").map((l) => l.trim()))
  const lines = d.stdout.split("\n")
  const first = lines.findIndex((l) => l.startsWith("@@"))
  if (first < 0) return undefined
  for (const l of lines.slice(first)) {
    if (!l.startsWith("-")) continue
    const line = l.slice(1).trim()
    if (line && base.has(line)) return line.slice(0, 120)
  }
  return undefined
}

/** `<name>@<semver>[+<hash>]` of a `packageManager` field, hash dropped; `null` when it does not parse. */
function packageManagerOf(v: Json | undefined): { name: string; version: string } | null {
  if (typeof v !== "string") return null
  const m = /^((?:@[^@/]+\/)?[^@/]+)@([^+]+)(?:\+.*)?$/.exec(v)
  const version = m ? semver.valid(m[2] as string) : null
  return m && version ? { name: m[1] as string, version } : null
}

/**
 * Why one `package.json` change of the tip is not a proven dependency bump,
 * or `null` when every key it changed (merge-base → tip) is explained:
 *   - the tip's value equals base's at the same key (it landed);
 *   - a dependency entry (`DEP_SECTIONS`, or `pnpm.overrides`) whose base
 *     spec (same key; for a dependency, any of base's dependency sections of
 *     the same file) has a lower bound >= the tip's, both plain semver
 *     ranges (`rangeLowerBound`);
 *   - a dependency (not an override) base dropped from this file AND from
 *     every other base `package.json`;
 *   - a `version` base already reached (`semver.gte`);
 *   - a `packageManager` `<name>@<version>[+<hash>]` where base declares the
 *     same `<name>` at a version >= the tip's (the hash is ignored).
 * A dependency the tip removes but base still has, an override base lacks,
 * or any other key is not proven. A file base no longer has at that path is
 * explained as a whole only when no base `package.json` carries the tip's
 * package `name` (the package is gone, not moved); otherwise not proven.
 */
async function packageJsonRefusal(
  env: ClassifyEnv,
  entry: BranchGcPlanEntry,
  file: string,
  counts: { dependencies: number; versions: number; goneOnBase: string[] },
): Promise<string | null> {
  const repoRoot = env.ctx.repoRoot
  const tip = await jsonOfBlob(repoRoot, `${entry.sha}:${file}`)
  if (!isObject(tip)) return `${file}: not a JSON object on the tip`
  const fork = await jsonOfBlob(repoRoot, `${entry.mergeBase as string}:${file}`)
  if (fork !== undefined && !isObject(fork)) return `${file}: not a JSON object at the merge base`
  const baseBlob = (await env.ctx.index()).byPath.get(file)
  if (!baseBlob) {
    let pkgs: BasePackages
    try {
      pkgs = await basePackagesOf(env)
    } catch {
      return `${file}: gone on base, and base's package.json files could not all be read`
    }
    if (typeof tip.name !== "string" || !tip.name) return `${file}: gone on base, and the tip's package has no name to look for`
    if (pkgs.names.has(tip.name)) return `${file}: gone on base, but base still has package ${tip.name} elsewhere`
    counts.goneOnBase.push(file)
    return null
  }
  const base = await jsonOfBlob(repoRoot, baseBlob)
  if (!isObject(base)) return `${file}: not a JSON object on base`
  for (const path of changedLeaves(fork, tip)) {
    const key = path.join(".")
    const tipValue = at(tip, path)
    const baseValue = at(base, path)
    if (JSON.stringify(tipValue) === JSON.stringify(baseValue)) {
      if (path.length === 2 && (DEP_SECTIONS as readonly string[]).includes(path[0] as string)) counts.dependencies++
      continue
    }
    const isDep = path.length === 2 && (DEP_SECTIONS as readonly string[]).includes(path[0] as string)
    const isOverride = path.length === 3 && path[0] === "pnpm" && path[1] === "overrides"
    if (isDep || isOverride) {
      const name = path[path.length - 1] as string
      if (tipValue === undefined) return `${file}: ${key} removed on the tip, base still declares ${JSON.stringify(baseValue ?? "it")}`
      const tipMin = rangeLowerBound(tipValue)
      if (!tipMin) return `${file}: ${key} ${JSON.stringify(tipValue)} is not a plain semver range`
      let baseSpec: Json | undefined = baseValue
      if (baseSpec === undefined && isDep) baseSpec = DEP_SECTIONS.map((s) => at(base, [s, name])).find((v) => v !== undefined)
      if (baseSpec === undefined) {
        if (isOverride) return `${file}: ${key} ${JSON.stringify(tipValue)}, base has no such override`
        let pkgs: BasePackages
        try {
          pkgs = await basePackagesOf(env)
        } catch {
          return `${file}: ${key} ${JSON.stringify(tipValue)} dropped on base, and base's package.json files could not all be read`
        }
        if (pkgs.dependencies.has(name)) return `${file}: ${key} ${JSON.stringify(tipValue)} dropped here on base, but another base package still depends on ${name}`
        counts.dependencies++
        continue
      }
      const baseMin = rangeLowerBound(baseSpec)
      if (!baseMin) return `${file}: ${key} ${JSON.stringify(tipValue)}, base ${JSON.stringify(baseSpec)} is not a plain semver range`
      if (semver.lt(baseMin, tipMin)) return `${file}: ${key} ${JSON.stringify(tipValue)}, base has older ${JSON.stringify(baseSpec)}`
      counts.dependencies++
      continue
    }
    if (key === "packageManager") {
      const show = (v: Json | undefined): string => JSON.stringify(v)?.slice(0, 80) ?? "nothing"
      const t = packageManagerOf(tipValue)
      const b = packageManagerOf(baseValue)
      if (!t || !b) return `${file}: packageManager ${show(tipValue)} vs base ${show(baseValue)} is not comparable`
      if (t.name !== b.name) return `${file}: packageManager ${show(tipValue)} is ${t.name}, base declares ${b.name}`
      if (semver.lt(b.version, t.version)) return `${file}: packageManager ${show(tipValue)}, base is still ${show(baseValue)}`
      counts.versions++
      continue
    }
    if (key === "version") {
      const t = typeof tipValue === "string" ? semver.valid(tipValue) : null
      const b = typeof baseValue === "string" ? semver.valid(baseValue) : null
      if (!t || !b) return `${file}: version ${JSON.stringify(tipValue)} vs base ${JSON.stringify(baseValue)} is not comparable`
      if (semver.lt(b, t)) return `${file}: version ${JSON.stringify(tipValue)}, base is still ${JSON.stringify(baseValue)}`
      counts.versions++
      continue
    }
    return `${file}: ${key} changed to ${JSON.stringify(tipValue)?.slice(0, 80) ?? "nothing"} (not a dependency entry)`
  }
  return null
}

/** One file the tip changes (merge-base → tip), from `git diff --numstat`: `added` is `null` for a binary. */
interface ChangedFile {
  file: string
  added: number | null
  deleted: number
}

/** What {@link depBumpFileRefusal} counted, across the files it proved. */
interface DepBumpTally {
  dependencies: number
  versions: number
  goneOnBase: string[]
  lockfileLines: number
  changesetLines: number
  packageFiles: string[]
}

const newDepBumpTally = (): DepBumpTally => ({ dependencies: 0, versions: 0, goneOnBase: [], lockfileLines: 0, changesetLines: 0, packageFiles: [] })

/** Every file the tip changes (merge-base → tip), by path; `null` when git cannot list them. */
async function changedFilesOf(env: ClassifyEnv, entry: BranchGcPlanEntry): Promise<Map<string, ChangedFile> | null> {
  if (!entry.mergeBase) return null
  const numstat = await git(env.ctx.repoRoot, ["diff", "--numstat", "-z", "--no-renames", entry.mergeBase, entry.sha])
  if (numstat.exitCode !== 0) return null
  const out = new Map<string, ChangedFile>()
  for (const row of numstat.stdout.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(row)
    if (!m) continue
    const file = m[3] as string
    out.set(file, { file, added: m[1] === "-" ? null : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) })
  }
  return out
}

/**
 * The `dep-bump` rules for one changed file: why it is not proven, or `null`
 * when it is (counted into `tally`). Shared by `depBumpCheck` (every changed
 * file) and `verifiedPrCheck` (an uncovered file no cited PR touched):
 *   - a `pnpm-lock.yaml` (regenerable) or a `.changeset/*.md`;
 *   - a `package.json` whose every changed key `packageJsonRefusal` accepts;
 *   - a lockfile or binary the line guard does not read, identical to base's;
 *   - any other file only when none of its added lines is uncovered
 *     (`uncovered`) and it deletes no non-blank line base's file at the same
 *     path still has.
 */
async function depBumpFileRefusal(
  env: ClassifyEnv,
  entry: BranchGcPlanEntry,
  row: ChangedFile,
  uncovered: ReadonlySet<string>,
  tally: DepBumpTally,
): Promise<string | null> {
  const { file, added, deleted } = row
  const sameAsBase = async (): Promise<boolean> =>
    (await git(env.ctx.repoRoot, ["rev-parse", "--verify", "--quiet", `${entry.sha}:${file}`])).stdout.trim() === (await env.ctx.index()).byPath.get(file)
  if (added === null) return (await sameAsBase()) ? null : `${file}: binary, not proven`
  if (added === 0 && deleted === 0) return null
  if (PNPM_LOCK_RE.test(file)) tally.lockfileLines += added
  else if (CHANGESET_RE.test(file)) tally.changesetLines += added
  else if (PACKAGE_JSON_RE.test(file)) {
    tally.packageFiles.push(file)
    return packageJsonRefusal(env, entry, file, tally)
  } else if (LINE_SKIP_RE.test(file)) {
    if (!(await sameAsBase())) return `${file}: not line-checked (lockfile or binary), not proven`
  } else {
    if (added > 0 && uncovered.has(file)) {
      const line = await firstUncoveredLine(env, entry, file)
      return `${file}: ${line ? JSON.stringify(line) : "an added line"} is not a dependency, lockfile or changeset line`
    }
    // A deletion of work base still carries is a change too: never proven here.
    if (deleted > 0) {
      const line = await firstDeletedLineOnBase(env, entry, file)
      if (line !== undefined) return `${file}: deletes ${JSON.stringify(line)}, which base still has`
    }
  }
  return null
}

/**
 * The `dep-bump` pass: may a verdict the line guard (and `verified-pr`)
 * refused reclaim anyway? Deterministic, git objects only, every condition
 * must hold:
 *   1. triage AND gate say `obsolete` or `superseded`, and the gate agreed;
 *   2. every file the tip changes (merge-base → tip) is explained:
 *      a `pnpm-lock.yaml` (regenerable), a `.changeset/*.md`, a
 *      `package.json` whose every changed key `packageJsonRefusal` accepts,
 *      or a file whose added lines the line guard found in base already and
 *      that deletes no non-blank line base's file at the same path still
 *      has (so a deletion-only file never passes vacuously). A lockfile or
 *      binary the line guard does not read (`LINE_SKIP_RE`, other than
 *      `pnpm-lock.yaml`) must be identical to base's.
 * The refusal reason names the first unexplained line. Residual limit,
 * accepted by design: line matching is per file and order-free, so an added
 * line counts as "in base" when base has that text anywhere in the same
 * path, and a deleted line counts as "gone from base" when base has it
 * nowhere in that path.
 */
async function depBumpCheck(entry: BranchGcPlanEntry, record: BranchVerdictRecord, env: ClassifyEnv): Promise<DepBumpResult> {
  const refuse = (reason: string): DepBumpResult => ({ ok: false, reason })
  const gate = record.gate
  if (!DEP_BUMP_VERDICTS.has(record.triage.verdict) || !gate || !DEP_BUMP_VERDICTS.has(gate.verdict)) {
    return refuse(`verdict is ${record.triage.verdict}${gate && gate.verdict !== record.triage.verdict ? ` (gate ${gate.verdict})` : ""}, not obsolete or superseded`)
  }
  if (gate.agree !== true) return refuse("gate did not agree")
  const missingFiles = entry.lineCoverage?.missingFiles
  if (!missingFiles || !entry.mergeBase) return refuse("no per-file line coverage to explain")
  const uncovered = new Set(missingFiles)
  const changed = await changedFilesOf(env, entry)
  if (!changed) return refuse("could not list the tip's changed files")
  const tally = newDepBumpTally()
  for (const row of changed.values()) {
    const why = await depBumpFileRefusal(env, entry, row, uncovered, tally)
    if (why) return refuse(why)
  }
  return {
    ok: true,
    proof: {
      dependencies: tally.dependencies,
      versions: tally.versions,
      lockfileLines: tally.lockfileLines,
      changesetLines: tally.changesetLines,
      packageFiles: tally.packageFiles,
      ...(tally.goneOnBase.length ? { goneOnBase: tally.goneOnBase } : {}),
    },
  }
}

/** Bound on the files one tip can make the `history-covered` pass search base's history for. */
const HISTORY_MAX_FILES = 50
/** Bound on the `git log -p` bytes one tip can make the `history-covered` pass read (summed over its paths, cached or not). */
const HISTORY_MAX_BYTES = 32 * 1024 * 1024
/** Bound on how many times the pass follows a path base moved (a move of a move ...). */
const HISTORY_MAX_MOVES = 3

/** Base's history of one path: every non-trivial added line, mapped to the newest commit (index into `commits`, newest first) that added it. `time` is the committer time, comparable across paths. */
interface PathHistory {
  bytes: number
  /** Set when the history exceeds {@link HISTORY_MAX_BYTES} or git failed: nothing in it can be trusted. */
  error?: "too-large" | "unreadable"
  commits: Array<{ sha: string; time: number }>
  lines: Map<string, number>
}

const pathHistoryCache = new WeakMap<ClassifyEnv, Map<string, Promise<PathHistory>>>()

/**
 * {@link PathHistory} of `path` on base: `git log -p -U0` over the commits
 * reachable from base that touch that exact path (no rename following, no
 * merge diffs), the `+` lines trimmed with the line guard's normalization.
 * Read once per snapshot, aborted past {@link HISTORY_MAX_BYTES}.
 */
function pathHistoryOf(env: ClassifyEnv, path: string): Promise<PathHistory> {
  let cache = pathHistoryCache.get(env)
  if (!cache) pathHistoryCache.set(env, (cache = new Map()))
  let pending = cache.get(path)
  if (!pending) {
    pending = (async () => {
      const abort = new AbortController()
      let bytes = 0
      const res = await execArgv(
        "git",
        [
          "-C", env.ctx.repoRoot, "--literal-pathspecs", "log", "-p", "-U0", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv",
          "--format=%x01%H %ct", env.ctx.baseSha, "--", path,
        ],
        env.ctx.repoRoot,
        {
          signal: abort.signal,
          killGraceMs: 1000,
          onOutput: (text, stream) => {
            if (stream !== "stdout") return
            bytes += Buffer.byteLength(text)
            if (bytes > HISTORY_MAX_BYTES && !abort.signal.aborted) abort.abort()
          },
        },
      )
      const out: PathHistory = { bytes, commits: [], lines: new Map() }
      if (abort.signal.aborted) return { ...out, error: "too-large" }
      if (res.exitCode !== 0) return { ...out, error: "unreadable" }
      let inHunk = false
      for (const l of res.stdout.split("\n")) {
        if (l.startsWith("\u0001")) {
          const [sha = "", time = "0"] = l.slice(1).trim().split(" ")
          out.commits.push({ sha, time: Number(time) })
          inHunk = false
        } else if (l.startsWith("diff --git ")) inHunk = false
        else if (l.startsWith("@@")) inHunk = true
        else if (inHunk && l.startsWith("+")) {
          const line = l.slice(1).trim()
          // Newest first: the first commit seen is the newest that added it.
          if (line.length >= LINE_MIN_LENGTH && !out.lines.has(line)) out.lines.set(line, out.commits.length - 1)
        }
      }
      return out
    })()
    cache.set(path, pending)
  }
  return pending
}

/**
 * The paths base moved `file` to, when base no longer has it: the newest base
 * commit that deleted the path, read with rename detection, names where it
 * went; repeated while that path is gone too, at most
 * {@link HISTORY_MAX_MOVES} times. Empty when base still has it, deleted it
 * outright, or never had it.
 */
async function movedOnBase(env: ClassifyEnv, file: string): Promise<string[]> {
  const idx = await env.ctx.index()
  const out: string[] = []
  let cur = file
  for (let hop = 0; hop < HISTORY_MAX_MOVES && !idx.byPath.has(cur); hop++) {
    const del = await git(env.ctx.repoRoot, ["--literal-pathspecs", "log", "-1", "--no-renames", "--diff-filter=D", "--format=%H", env.ctx.baseSha, "--", cur])
    const commit = del.exitCode === 0 ? del.stdout.trim() : ""
    if (!commit) break
    const tree = await git(env.ctx.repoRoot, ["diff-tree", "-r", "-M", "-z", "--name-status", "--no-commit-id", commit])
    if (tree.exitCode !== 0) break
    const parts = tree.stdout.split("\0")
    let next: string | undefined
    for (let i = 0; i < parts.length; ) {
      const status = parts[i] ?? ""
      if (status.startsWith("R") || status.startsWith("C")) {
        if (status.startsWith("R") && parts[i + 1] === cur) next = parts[i + 2]
        i += 3
      } else i += 2
    }
    if (!next || out.includes(next) || next === file) break
    out.push(next)
    cur = next
  }
  return out
}

/** The tip's added lines of `file` (merge-base to tip) not in base's file at the same path, with the line guard's normalization; `null` when the diff fails. */
async function uncoveredLinesOf(env: ClassifyEnv, entry: BranchGcPlanEntry, file: string): Promise<string[] | null> {
  const d = await git(env.ctx.repoRoot, ["--literal-pathspecs", "diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", entry.mergeBase as string, entry.sha, "--", file])
  if (d.exitCode !== 0) return null
  const blob = (await env.ctx.index()).byPath.get(file)
  const base = new Set<string>()
  if (blob) {
    const shown = await git(env.ctx.repoRoot, ["cat-file", "blob", blob])
    if (shown.exitCode !== 0) return null
    for (const l of shown.stdout.split("\n")) base.add(l.trim())
  }
  const out: string[] = []
  let inHunk = false
  for (const l of d.stdout.split("\n")) {
    if (l.startsWith("@@")) inHunk = true
    if (!inHunk || !l.startsWith("+")) continue
    const line = l.slice(1).trim()
    if (line.length >= LINE_MIN_LENGTH && !base.has(line) && !out.includes(line)) out.push(line)
  }
  return out
}

type HistoryCoveredResult = { ok: true; proof: HistoryCoveredProof } | { ok: false; reason: string }

/**
 * The `history-covered` pass: may a verdict the line guard, `verified-pr` and
 * `dep-bump` refused reclaim anyway? Deterministic, git objects only, every
 * condition must hold:
 *   1. triage AND gate say `obsolete` or `superseded`, and the gate agreed;
 *   2. every file the tip changes (merge-base to tip) is either proven by
 *      `depBumpFileRefusal`, or is a text file the line guard reads that
 *      deletes no non-blank line base's file at the same path still has, and
 *      whose every uncovered added line (`uncoveredLinesOf`) some commit
 *      reachable from base ADDED to that same path (`pathHistoryOf`), or to a
 *      path base later moved it to (`movedOnBase`). Lines from any other path
 *      never count;
 *   3. at most {@link HISTORY_MAX_FILES} files need a history search and
 *      their histories total at most {@link HISTORY_MAX_BYTES}; past that it
 *      refuses rather than slow the run.
 * The refusal reason names the first file or line that failed. Residual
 * limit, accepted by design: as for the line guard, matching is per path and
 * order-free, so a line counts when base added that text to the path at any
 * point, whatever surrounded it then.
 */
async function historyCoveredCheck(entry: BranchGcPlanEntry, record: BranchVerdictRecord, env: ClassifyEnv): Promise<HistoryCoveredResult> {
  const refuse = (reason: string): HistoryCoveredResult => ({ ok: false, reason })
  const gate = record.gate
  if (!DEP_BUMP_VERDICTS.has(record.triage.verdict) || !gate || !DEP_BUMP_VERDICTS.has(gate.verdict)) {
    return refuse(`verdict is ${record.triage.verdict}${gate && gate.verdict !== record.triage.verdict ? ` (gate ${gate.verdict})` : ""}, not obsolete or superseded`)
  }
  if (gate.agree !== true) return refuse("gate did not agree")
  const missingFiles = entry.lineCoverage?.missingFiles
  if (!missingFiles || !entry.mergeBase) return refuse("no per-file line coverage to explain")
  const uncovered = new Set(missingFiles)
  const changed = await changedFilesOf(env, entry)
  if (!changed) return refuse("could not list the tip's changed files")
  const files: HistoryCoveredFile[] = []
  let searched = 0
  let bytes = 0
  for (const row of changed.values()) {
    const { file } = row
    const why = await depBumpFileRefusal(env, entry, row, uncovered, newDepBumpTally())
    if (why === null) continue
    // A binary or a lockfile the line guard does not read has no lines to look up.
    if (row.added === null || LINE_SKIP_RE.test(file)) return refuse(why)
    const deleted = row.deleted > 0 ? await firstDeletedLineOnBase(env, entry, file) : undefined
    if (deleted !== undefined) return refuse(`${file}: deletes ${JSON.stringify(deleted)}, which base still has`)
    const lines = uncovered.has(file) ? await uncoveredLinesOf(env, entry, file) : []
    if (lines === null) return refuse(`${file}: diff unreadable`)
    if (lines.length === 0) continue
    if (++searched > HISTORY_MAX_FILES) return refuse(`history too large to check: more than ${HISTORY_MAX_FILES} files to search`)
    const movedTo = await movedOnBase(env, file)
    const histories: PathHistory[] = []
    for (const path of [file, ...movedTo]) {
      const h = await pathHistoryOf(env, path)
      bytes += h.bytes
      if (h.error === "too-large" || bytes > HISTORY_MAX_BYTES) return refuse(`${file}: history too large to check (> ${HISTORY_MAX_BYTES / (1024 * 1024)} MiB of base history)`)
      if (h.error) return refuse(`${file}: base history of ${path} unreadable`)
      histories.push(h)
    }
    let oldest: { sha: string; time: number } | undefined
    let newest: { sha: string; time: number } | undefined
    for (const line of lines) {
      // The newest commit, across the searched paths, that added this line.
      let hit: { sha: string; time: number } | undefined
      for (const h of histories) {
        const at = h.lines.get(line)
        const c = at === undefined ? undefined : h.commits[at]
        if (c && (!hit || c.time > hit.time)) hit = c
      }
      if (!hit) {
        const where = movedTo.length ? `${file} (or ${movedTo.join(", ")})` : file
        return refuse(`${file}: ${JSON.stringify(line.slice(0, 120))} was never added to ${where} on base`)
      }
      if (!oldest || hit.time < oldest.time) oldest = hit
      if (!newest || hit.time > newest.time) newest = hit
    }
    if (!oldest || !newest) continue
    files.push({ file, lines: lines.length, oldest: oldest.sha, newest: newest.sha, ...(movedTo.length ? { movedTo } : {}) })
  }
  return { ok: true, proof: { filesChecked: changed.size, linesMatched: files.reduce((n, f) => n + f.lines, 0), files } }
}

/**
 * Resolve an unmerged entry that reached the review rung: `includeReviewed`
 * plus an agreeing verdict reclaims it (`reviewed`) unless the deterministic
 * line-coverage guard refuses it (operator approval bypasses the guard and is
 * recorded in `verdictGuard`; so does a passing `verified-pr` check, recorded
 * in `verifiedPr`, or, when that refuses, a passing `dep-bump` check,
 * recorded in `depBump`, or, when that refuses too, a passing
 * `history-covered` check, recorded in `historyCovered`). Otherwise the entry
 * stays `review`.
 *
 * `requireCoverage` makes a missing `lineCoverage` fail closed: checkpoint
 * refs may be the only copy of rescued work, so an agreeing verdict alone must
 * not reclaim one whose added lines were never measured. It also keeps the
 * `verified-pr` pass off checkpoint refs for the same reason.
 */
async function applyReviewedDecision(
  entry: BranchGcPlanEntry,
  record: BranchVerdictRecord | null,
  env: ClassifyEnv,
  opts: { requireCoverage?: boolean } = {},
): Promise<void> {
  if (!(env.includeReviewed && entry.verdict?.agree === true)) {
    entry.class = "review"
    return
  }
  // The deterministic line check outranks the reviewer: an approval of a tip
  // whose added lines are mostly NOT in base is refused, the ref stays review.
  const guard =
    opts.requireCoverage && !entry.lineCoverage
      ? "no line coverage for checkpoint snapshot"
      : lineCoverageGuard(entry.lineCoverage, env.minLineCoverage)
  if (guard) {
    // An operator approval is the human exit from the refusal queue: it
    // overrides the deterministic line guard for this exact tip, and the
    // plan records who bypassed it. A reviewer-only verdict stays refused.
    const operator = entry.verdict.operator
    if (operator) {
      entry.verdictGuard = `bypassed by operator ${operator.by}${operator.note ? ` (${operator.note})` : ""}: ${guard}`
    } else {
      // The deterministic second proof: a superseded verdict whose cited PR
      // the forge confirms merged, with every uncovered file explained.
      const check = opts.requireCoverage || env.requireOperatorBelowGuard || !record ? null : await verifiedPrCheck(entry, record, env)
      if (check?.ok) {
        entry.verdictGuard = `passed by verified-pr ${check.proof.prs.map((n) => `#${n}`).join(", ")}: ${guard}`
        entry.verifiedPr = check.proof
      } else {
        // Then the dependency-bump proof: every added line is a lockfile,
        // changeset or dependency spec base already declares at least as new.
        const bump = check && record ? await depBumpCheck(entry, record, env) : null
        if (bump?.ok) {
          const p = bump.proof
          entry.verdictGuard =
            `passed by dep-bump (${p.dependencies} dependency, ${p.versions} version, ${p.lockfileLines} lockfile, ${p.changesetLines} changeset line(s)): ${guard}`
          entry.depBump = p
        } else {
          // Last, the history proof: every missing line was once on base in
          // the same path, so base's own history keeps it.
          const hist = bump && record ? await historyCoveredCheck(entry, record, env) : null
          if (!hist?.ok) {
            entry.verdictGuard = guard
            if (check) entry.verifiedPrRefusal = check.reason
            if (bump) entry.depBumpRefusal = bump.reason
            if (hist) entry.historyRefusal = hist.reason
            entry.class = "review"
            return
          }
          const p = hist.proof
          entry.verdictGuard = `passed by history-covered (${p.linesMatched} line(s) in base history across ${p.files.length} file(s)): ${guard}`
          entry.historyCovered = p
        }
      }
    }
  }
  entry.class = "reclaim"
  entry.reclaimReason = "reviewed"
}

/**
 * A sandbox checkpoint branch never merges (its tip is a snapshot commit), so
 * the ladder on its OWN tip proves nothing — it is classified against its
 * WORK branch instead, pinned to the snapshot's PARENT commit (`<checkpoint>^`,
 * the work-branch HEAD the box snapshotted on): branch names get reused, so
 * "the branch is merged" alone may prove a DIFFERENT generation of the branch
 * landed. Reclaim (`checkpoint-superseded`) only when that parent landed too —
 * it equals or is an ancestor of a merged work-branch tip (ladder), or equals
 * a merged PR's head that landed the same name while the branch is gone
 * (by-name); the head of an open PR ⇒ `hold` (`open-pr`); anything else —
 * including a parentless snapshot or a failed parent lookup — ⇒ `review`,
 * never auto-reclaimed: a dead box's checkpoint may be the only copy of its
 * uncommitted work. `young` and `protected` holds (on the WORK branch's name)
 * still apply first.
 */
async function classifyCheckpointRef(b: BranchRef, work: string, env: ClassifyEnv): Promise<BranchGcPlanEntry> {
  const ageDays = Math.floor((env.nowMs - new Date(b.date).getTime()) / 86_400_000)
  const workRefs = env.workBranchRefs.get(work) ?? []
  // Classify every distinct work-branch tip through the shared ladder memo;
  // any merged status supersedes the checkpoint (a local twin may have landed
  // while its remote twin lags, or vice versa) — subject to the snapshot's
  // parent having landed too (see below).
  let tip: TipClassification = { status: "unmerged", history: "unrelated", ahead: null, behind: null }
  let mergedLadder: TipClassification | undefined
  const mergedTips: string[] = []
  const seen = new Set<string>()
  for (const wr of workRefs) {
    if (seen.has(wr.sha)) continue
    seen.add(wr.sha)
    let pending = env.tips.get(wr.sha)
    if (!pending) {
      pending = classifyTip(env.ctx, wr.sha)
      env.tips.set(wr.sha, pending)
    }
    let cls = await pending
    if (cls.status === "unmerged" && (await mergedPrMatchOf(env, wr.sha))) cls = { ...cls, status: "pr-merged" }
    if (cls.status !== "unmerged") {
      mergedLadder ??= cls
      if (!mergedTips.includes(wr.sha)) mergedTips.push(wr.sha)
    } else if (tip.status === "unmerged" && tip.ahead === null) tip = cls
  }
  const entry: BranchGcPlanEntry = { ...b, ...tip, ageDays, class: "hold" }
  if (ageDays < env.minAgeDays) {
    entry.holdReason = "young"
    entry.holdDetail = `${ageDays}d < ${env.minAgeDays}d`
    return entry
  }
  if (PROTECTED_NAMES.has(work) || work === env.baseName) {
    entry.holdReason = "protected"
    return entry
  }
  const pr = env.prs.heads.get(work)
  if (pr !== undefined) {
    entry.holdReason = "open-pr"
    entry.holdDetail = `PR #${pr}`
    return entry
  }
  const mergedByName = workRefs.length === 0 ? env.mergedPrNames.get(work) : undefined
  if (mergedLadder || mergedByName !== undefined) {
    // The snapshot's parent is the work-branch HEAD the box was ON when it
    // snapshotted: reclaim only when THAT commit landed, not merely the
    // branch name or some other tip the branch used to have.
    const parent = await checkpointParent(env, b.sha)
    if (parent !== undefined) {
      if (mergedLadder) {
        for (const mergedTip of mergedTips) {
          if (await isAncestorOf(env, parent, mergedTip)) {
            Object.assign(entry, mergedLadder)
            entry.class = "reclaim"
            entry.reclaimReason = "checkpoint-superseded"
            return entry
          }
        }
      }
      if (mergedByName !== undefined && parent === mergedByName.headRefOid) {
        entry.class = "reclaim"
        entry.reclaimReason = "checkpoint-superseded"
        entry.mergedPr = mergedByName.number
        return entry
      }
    }
    return reviewCheckpointRef(entry, b, env)
  }
  return reviewCheckpointRef(entry, b, env)
}

/**
 * A checkpoint ref that stayed on the review rung is treated like any other
 * unmerged branch there: the coverage of the SNAPSHOT TIP itself (not its work
 * branch — the verdict is keyed by the snapshot sha) is used, its stored
 * verdict is stamped, and `includeReviewed` acts on an agreeing one through
 * the same line-coverage guard. A checkpoint snapshot with no measurable
 * coverage is refused rather than reclaimed: a dead box's checkpoint may be
 * the only copy of its work.
 */
async function reviewCheckpointRef(entry: BranchGcPlanEntry, b: BranchRef, env: ClassifyEnv): Promise<BranchGcPlanEntry> {
  if (entry.status !== "unmerged") {
    entry.class = "review"
    return entry
  }
  const snapshotTip = await snapshotTipOf(b.sha, env)
  // The work branch's coverage says nothing about the snapshot the verdict
  // covers: replace it wholesale (and drop it when the snapshot has none).
  if (snapshotTip.lineCoverage) entry.lineCoverage = snapshotTip.lineCoverage
  else delete entry.lineCoverage
  if (snapshotTip.coverage) entry.coverage = snapshotTip.coverage
  else delete entry.coverage
  if (snapshotTip.residualFiles) entry.residualFiles = snapshotTip.residualFiles
  else delete entry.residualFiles
  if (snapshotTip.residualFileCount !== undefined) entry.residualFileCount = snapshotTip.residualFileCount
  else delete entry.residualFileCount
  const record = await stampVerdict(entry, b.sha, env)
  await applyReviewedDecision(entry, record, env, { requireCoverage: true })
  return entry
}

/** The ladder classification of the SNAPSHOT tip, through the shared per-tip memo. */
function snapshotTipOf(sha: string, env: ClassifyEnv): Promise<TipClassification> {
  let pending = env.tips.get(sha)
  if (!pending) {
    pending = classifyTip(env.ctx, sha)
    env.tips.set(sha, pending)
  }
  return pending
}

interface ClassifyEnv {
  ctx: LadderContext
  /** The ladder is a pure function of (ctx, tip sha): run it once per tip,
   *  not once per ref — a local branch and its remote twin share one. */
  tips: Map<string, Promise<TipClassification>>
  remote: string | null
  baseName: string
  worktrees: Map<string, string>
  prs: OpenPrHeads
  /** Merged PR head sha → PR number (`pr-merged` shortcut). Empty = no shortcut available. */
  mergedPrShas: Map<string, number>
  /** Lazily computed, memoized history of every merged PR head (`ancestor`/`patch` matches); absent or `null` = exact-head matches only. */
  mergedPrCommits?: () => Promise<MergedPrCommits | null>
  /** Tip sha → its memoized merged-PR match (`mergedPrMatchOf`). */
  prMatches: Map<string, Promise<{ pr: number; match: MergedPrMatch } | null>>
  /** `refs/pull/<N>/head` of the base remote (forge-mirror shortcut for orphan refs). */
  forgePrHeads: ForgePrHeads
  /** Merged PR head ref name → { number, headRefOid } (checkpoint supersession when the work branch is gone — the snapshot's parent must equal `headRefOid`). */
  mergedPrNames: Map<string, { number: number; headRefOid: string }>
  /** Merged PR head ref name → its newest PR number, and whether the merged list was read (`headPr`). */
  mergedPrNewestByName: Map<string, number>
  mergedPrsAvailable: boolean
  /** PRs closed without merging, by head ref name (`headPr`). */
  closedUnmergedPrs: ClosedUnmergedPrHeads
  /** Work-branch name → its local/remote refs, for classifying checkpoint branches against their work branch. */
  workBranchRefs: Map<string, BranchRef[]>
  remoteShas: Set<string>
  remoteNames: Set<string>
  /**
   * Lazily computed, memoized set of every commit reachable from the base
   * remote's refs — ONE `git rev-list --glob=refs/remotes/<remote>/*`
   * answers every "is this sha contained in a remote ref" question instead
   * of one `for-each-ref --contains` per ref. `null` (or absent) = fall
   * back to the per-ref call.
   */
  remoteReachable?: () => Promise<Set<string> | null>
  /** Same idea for orphan refs: commits reachable from local branches + the base remote's refs. */
  localOrRemoteReachable?: () => Promise<Set<string> | null>
  minAgeDays: number
  includeReviewed: boolean
  minLineCoverage: number
  /** true = no `verified-pr`, `dep-bump` or `history-covered` pass below the line guard. */
  requireOperatorBelowGuard: boolean
  /** The forge the `verified-pr` pass asks for PR facts; absent = that pass refuses. */
  forge?: ForgeClient
  /** PR number → its memoized facts (`verifiedPrCheck`), one forge lookup per PR per snapshot. */
  prFacts: Map<number, Promise<ForgePullRequestFacts | null>>
  verdicts?: BranchVerdictStore
  repoName: string
  nowMs: number
}

function holdFor(b: BranchRef, env: ClassifyEnv): { holdReason: BranchGcHoldReason; holdDetail?: string } | null {
  if (b.kind === "orphan") return null
  if (PROTECTED_NAMES.has(b.name) || b.name === env.baseName) return { holdReason: "protected" }
  const wt = env.worktrees.get(b.name)
  if (wt) return { holdReason: "worktree", holdDetail: wt }
  const pr = env.prs.heads.get(b.name)
  if (pr !== undefined) return { holdReason: "open-pr", holdDetail: `PR #${pr}` }
  if (!env.prs.available) return { holdReason: "pr-check-unavailable", holdDetail: env.prs.reason }
  return null
}

async function pushStateOf(b: BranchRef, env: ClassifyEnv): Promise<BranchPushState | undefined> {
  const { repoRoot } = env.ctx
  if (b.kind === "local") {
    if (env.remoteShas.has(b.sha)) return "same-tip-on-remote"
    if (env.remote) {
      const reachable = env.remoteReachable ? await env.remoteReachable() : null
      if (reachable) {
        if (reachable.has(b.sha)) return "contained-in-remote"
      } else {
        const contained = await git(repoRoot, ["for-each-ref", "--contains", b.sha, "--format=x", `refs/remotes/${env.remote}`])
        if (contained.stdout.trim()) return "contained-in-remote"
      }
    }
    return env.remoteNames.has(b.name) ? "diverged-from-remote" : "local-only"
  }
  if (b.kind === "orphan") {
    const reachable = env.localOrRemoteReachable ? await env.localOrRemoteReachable() : null
    if (reachable) return reachable.has(b.sha) ? "contained-elsewhere" : "only-copy"
    const scopes = ["refs/heads", ...(env.remote ? [`refs/remotes/${env.remote}`] : [])]
    const contained = await git(repoRoot, ["for-each-ref", "--contains", b.sha, "--format=x", ...scopes])
    return contained.stdout.trim() ? "contained-elsewhere" : "only-copy"
  }
  return undefined
}

/** Without the ladder: what is already known about a tip's history. */
function knownHistory(env: ClassifyEnv, sha: string): BranchHistory {
  const related = env.ctx.related?.get(sha)
  if (related === false) return env.ctx.anchor ? "pre-rewrite" : "unrelated"
  return "current"
}

async function classifyRef(b: BranchRef, env: ClassifyEnv): Promise<BranchGcPlanEntry> {
  const checkpointWork = checkpointWorkBranchOf(b)
  if (checkpointWork !== undefined) return classifyCheckpointRef(b, checkpointWork, env)
  // Forge-mirror shortcut, BEFORE the ladder: an orphan ref whose tip is a PR
  // head the forge keeps forever is never the only copy (and a bulk
  // `fetch '+refs/pull/*/head:…'` creates hundreds of them — no ladder, no review).
  const forgePr = b.kind === "orphan" ? env.forgePrHeads.heads.get(b.sha) : undefined
  if (forgePr !== undefined) {
    return {
      ...b,
      status: "forge-mirror",
      history: knownHistory(env, b.sha),
      ahead: null,
      behind: null,
      ageDays: Math.floor((env.nowMs - new Date(b.date).getTime()) / 86_400_000),
      class: "reclaim",
      reclaimReason: "forge-mirror",
      forgePr,
    }
  }
  let pending = env.tips.get(b.sha)
  if (!pending) {
    pending = classifyTip(env.ctx, b.sha)
    env.tips.set(b.sha, pending)
  }
  const tip = await pending
  const ageDays = Math.floor((env.nowMs - new Date(b.date).getTime()) / 86_400_000)
  const entry: BranchGcPlanEntry = { ...b, ...tip, ageDays, class: "hold" }
  // Merged-PR shortcut: an "unmerged" tip whose work went through a MERGED
  // PR (its exact head, an ancestor of its head, or patch-equivalent
  // commits) lost nothing — that work was reviewed and merged. Override the
  // ladder's verdict (and skip its push-state/verdict work below) before any
  // reclaim/hold decision; holds further down still win.
  if (tip.status === "unmerged") {
    const merged = await mergedPrMatchOf(env, b.sha)
    if (merged) {
      entry.status = "pr-merged"
      entry.mergedPr = merged.pr
      entry.mergedPrMatch = merged.match
    }
  }
  let record: BranchVerdictRecord | null = null
  if (entry.status === "unmerged") {
    const pushed = await pushStateOf(b, env)
    if (pushed) entry.pushed = pushed
    record = await stampVerdict(entry, b.sha, env)
    if (b.kind !== "orphan") {
      const headPr = headPrOf(b.name, env)
      if (headPr) entry.headPr = headPr
    }
  }
  const hold = holdFor(b, env)
  if (hold) {
    entry.holdReason = hold.holdReason
    if (hold.holdDetail) entry.holdDetail = hold.holdDetail
    return entry
  }
  if (entry.status !== "unmerged") {
    entry.class = "reclaim"
    entry.reclaimReason = entry.status
    return entry
  }
  if (ageDays < env.minAgeDays) {
    entry.holdReason = "young"
    entry.holdDetail = `${ageDays}d < ${env.minAgeDays}d`
    return entry
  }
  await applyReviewedDecision(entry, record, env)
  return entry
}

interface Snapshot {
  env: ClassifyEnv
  refs: BranchRef[]
  otherRemoteRefs: number
  /** Prune state of the base remote at snapshot time: true ok / false failed / null skipped. */
  fetched: boolean | null
}

async function snapshot(input: {
  repoRoot: string
  repoName: string
  base: string
  anchor: string | null | "auto"
  forge?: ForgeClient
  verdicts?: BranchVerdictStore
  minAgeDays: number
  includeReviewed: boolean
  minLineCoverage: number
  requireOperatorBelowGuard: boolean
  nowMs: number
  /** Default true: `git fetch --prune <baseRemote>` before listing refs (best-effort). */
  fetch?: boolean
}): Promise<Snapshot> {
  const remotes = await configuredRemotes(input.repoRoot)
  const remote = baseRemoteOf(input.base, remotes)
  // Best-effort prune of stale remote-tracking refs BEFORE listing: a fetch
  // failure (offline, no auth) must not throw — classify the refs as they are.
  let fetched: boolean | null = null
  if (remote && input.fetch !== false) {
    fetched = (await git(input.repoRoot, ["fetch", "--prune", "--quiet", remote])).exitCode === 0
  }
  const [{ refs, otherRemoteRefs }, worktrees, prs, mergedPrs, closedUnmergedPrs, forgePrHeads] = await Promise.all([
    listBranchRefs(input.repoRoot, remote, remotes),
    worktreeBranches(input.repoRoot),
    openPrHeads(input.forge),
    mergedPrIndex(input.forge),
    closedUnmergedPrHeads(input.forge),
    forgePrHeadsOf(input.repoRoot, remote),
  ])
  const baseSha = (await gitOk(input.repoRoot, ["rev-parse", "--verify", `${input.base}^{commit}`])).trim()
  let anchor: string | null
  const related = new Map<string, boolean>()
  const mergeBases = new Map<string, string>()
  if (input.anchor === "auto") anchor = await detectAnchor(input.repoRoot, baseSha, refs.map((r) => r.sha), related, mergeBases)
  else if (input.anchor) anchor = (await gitOk(input.repoRoot, ["rev-parse", "--verify", `${input.anchor}^{commit}`])).trim()
  else anchor = null
  const ctx = await createLadderContext(input.repoRoot, baseSha, anchor, related, mergeBases)
  const remoteRefs = refs.filter((r) => r.kind === "remote")
  // Work-branch name → its local/remote refs: a checkpoint branch
  // (`agentproto-checkpoint/<work>`) is classified against THIS, not base.
  const workBranchRefs = new Map<string, BranchRef[]>()
  for (const r of refs) {
    if (r.kind === "orphan") continue
    workBranchRefs.set(r.name, [...(workBranchRefs.get(r.name) ?? []), r])
  }
  // ONE `git rev-list` per question, memoized: every commit reachable from
  // the base remote's refs (for `contained-in-remote`), and from local
  // branches + those refs (for orphan `contained-elsewhere`). Above
  // 500 000 commits the set is abandoned — `null` falls back to the
  // per-ref `for-each-ref --contains` call.
  const MAX_REACHABLE = 500_000
  const revListSet = async (args: readonly string[]): Promise<Set<string> | null> => {
    const res = await git(input.repoRoot, ["rev-list", ...args])
    if (res.exitCode !== 0) return null
    const shas = res.stdout.split("\n")
    if (shas.length > MAX_REACHABLE) return null
    return new Set(shas.filter(Boolean))
  }
  let remoteReachableP: Promise<Set<string> | null> | null = null
  let localOrRemoteP: Promise<Set<string> | null> | null = null
  let mergedPrCommitsP: Promise<MergedPrCommits | null> | null = null
  return {
    refs,
    otherRemoteRefs,
    fetched,
    env: {
      ctx,
      tips: new Map(),
      remote,
      baseName: remote && input.base.startsWith(`${remote}/`) ? input.base.slice(remote.length + 1) : input.base,
      worktrees,
      prs,
      mergedPrShas: mergedPrs.shas,
      mergedPrCommits: () => (mergedPrCommitsP ??= buildMergedPrCommits(ctx, mergedPrs.shas)),
      prMatches: new Map(),
      mergedPrNames: mergedPrs.names,
      mergedPrNewestByName: mergedPrs.newestByName,
      mergedPrsAvailable: mergedPrs.available,
      closedUnmergedPrs,
      forgePrHeads,
      workBranchRefs,
      remoteShas: new Set(remoteRefs.map((r) => r.sha)),
      remoteNames: new Set(remoteRefs.map((r) => r.name)),
      ...(remote
        ? {
            remoteReachable: () => (remoteReachableP ??= revListSet([`--glob=refs/remotes/${remote}/*`])),
            localOrRemoteReachable: () => (localOrRemoteP ??= revListSet(["--branches", `--glob=refs/remotes/${remote}/*`])),
          }
        : {}),
      minAgeDays: input.minAgeDays,
      includeReviewed: input.includeReviewed,
      minLineCoverage: input.minLineCoverage,
      requireOperatorBelowGuard: input.requireOperatorBelowGuard,
      ...(input.forge ? { forge: input.forge } : {}),
      prFacts: new Map(),
      ...(input.verdicts ? { verdicts: input.verdicts } : {}),
      repoName: input.repoName,
      nowMs: input.nowMs,
    },
  }
}

// ── plan ─────────────────────────────────────────────────────────────

export const DEFAULT_BRANCH_GC_MIN_AGE_DAYS = 3

export interface PlanBranchGcInput {
  repoRoot: string
  repoName: string
  /** Default `origin/main`. */
  base?: string
  /** Subset of kinds to classify. Default all three. */
  scopes?: readonly BranchRefKind[]
  /** Unmerged refs younger than this are `hold`. Default 3. */
  minAgeDays?: number
  /** Promote a `review` ref whose stored verdict agreed for the same tip sha to `reclaim` (`reviewed`). Default false. */
  includeReviewed?: boolean
  /** `includeReviewed` refuses an agreeing verdict when the tip's line coverage is below this percent. Default 95. */
  minLineCoverage?: number
  /** Turn the `verified-pr`, `dep-bump` and `history-covered` passes off: below `minLineCoverage` only an operator approval reclaims. Default false. */
  requireOperatorBelowGuard?: boolean
  /** Explicit anchor for a re-rooted base. Omitted → auto-detected. */
  anchor?: string
  /** Open-PR detection (`listOpenPullRequests`). Omitted or unable → every local/remote ref is `hold` (`pr-check-unavailable`). */
  forge?: ForgeClient
  verdicts?: BranchVerdictStore
  /** Clock for `ageDays`. Default `Date.now()`. */
  nowMs?: number
  /** Parallel ladder runs. Default 8. */
  concurrency?: number
  /** Run `git fetch --prune <baseRemote>` before classifying. Default true. */
  fetch?: boolean
}

function normalizeScopes(scopes: readonly BranchRefKind[] | undefined): BranchRefKind[] {
  if (!scopes || scopes.length === 0) return [...BRANCH_GC_SCOPES]
  for (const s of scopes) {
    if (!(BRANCH_GC_SCOPES as readonly string[]).includes(s)) {
      throw new Error(`branch gc: unknown scope "${s}" (expected ${BRANCH_GC_SCOPES.join(", ")})`)
    }
  }
  return BRANCH_GC_SCOPES.filter((s) => scopes.includes(s))
}

/** The dry-run plan: classify every ref in `scopes`, mutate nothing. */
export async function planBranchGc(input: PlanBranchGcInput): Promise<BranchGcPlan> {
  const base = input.base ?? "origin/main"
  const scopes = normalizeScopes(input.scopes)
  const minAgeDays = input.minAgeDays ?? DEFAULT_BRANCH_GC_MIN_AGE_DAYS
  const includeReviewed = Boolean(input.includeReviewed)
  const minLineCoverage = input.minLineCoverage ?? DEFAULT_MIN_LINE_COVERAGE
  if (!Number.isFinite(minLineCoverage) || minLineCoverage < 0 || minLineCoverage > 100) {
    throw new Error(`branch gc: minLineCoverage must be a percent in [0, 100], got ${minLineCoverage}`)
  }
  const nowMs = input.nowMs ?? Date.now()
  const requireOperatorBelowGuard = input.requireOperatorBelowGuard === true
  const snap = await snapshot({
    repoRoot: input.repoRoot,
    repoName: input.repoName,
    base,
    anchor: input.anchor ?? "auto",
    ...(input.forge ? { forge: input.forge } : {}),
    ...(input.verdicts ? { verdicts: input.verdicts } : {}),
    minAgeDays,
    includeReviewed,
    minLineCoverage,
    requireOperatorBelowGuard,
    nowMs,
    ...(input.fetch === false ? { fetch: false } : {}),
  })
  const inScope = snap.refs.filter((r) => scopes.includes(r.kind))
  const entries = await pool(inScope, input.concurrency ?? 8, (r) => classifyRef(r, snap.env))
  return {
    repoRoot: input.repoRoot,
    repoName: input.repoName,
    base,
    baseSha: snap.env.ctx.baseSha,
    baseTree: snap.env.ctx.baseTree,
    remote: snap.env.remote,
    anchor: snap.env.ctx.anchor,
    prCheck: snap.env.prs.available ? { available: true } : { available: false, ...(snap.env.prs.reason ? { reason: snap.env.prs.reason } : {}) },
    scopes,
    minAgeDays,
    includeReviewed,
    minLineCoverage,
    requireOperatorBelowGuard,
    forgeMirrorCheck: snap.env.forgePrHeads.available
      ? { available: true }
      : { available: false, ...(snap.env.forgePrHeads.reason ? { reason: snap.env.forgePrHeads.reason } : {}) },
    generatedAt: new Date(nowMs).toISOString(),
    otherRemoteRefs: snap.otherRemoteRefs,
    fetched: snap.fetched,
    entries,
  }
}

export interface BranchGcSummary {
  /** kind → class → count. */
  byClass: Record<BranchRefKind, Record<BranchGcClass, number>>
  /**
   * kind → (status | "protected") → count, where "protected" = held for
   * base/protected, worktree, or open PR. Same buckets as the reference
   * script's audit summary, so the two can be compared line for line.
   */
  byStatus: Record<BranchRefKind, Record<string, number>>
  /**
   * The same counts keyed by branch NAME across kinds: a local branch and its
   * remote twin are one branch with two refs. A name whose refs land in
   * different classes (or statuses) counts once in each, so these buckets can
   * sum to more than `branches`. Optional so existing `BranchGcSummary`
   * literals stay assignable; a summary from this engine always sets it.
   */
  distinct?: BranchGcDistinctSummary
}

export interface BranchGcDistinctSummary {
  /** Distinct branch names across every kind. */
  branches: number
  /** Refs those names carry: one per plan entry. NOT the sum of `byClass`,
   *  which counts distinct names and so undercounts names spanning classes. */
  refs: number
  /** class → distinct names with at least one ref in that class. */
  byClass: Record<BranchGcClass, number>
  /** (status | "protected") → distinct names with at least one ref in it. */
  byStatus: Record<string, number>
}

export function summarizeBranchGcPlan(plan: BranchGcPlan): BranchGcSummary {
  const byClass = {} as BranchGcSummary["byClass"]
  const byStatus = {} as BranchGcSummary["byStatus"]
  for (const k of BRANCH_GC_SCOPES) {
    byClass[k] = { reclaim: 0, review: 0, hold: 0 }
    byStatus[k] = {}
  }
  const names = new Set<string>()
  const namesByClass: Record<BranchGcClass, Set<string>> = { reclaim: new Set(), review: new Set(), hold: new Set() }
  const namesByStatus = new Map<string, Set<string>>()
  for (const e of plan.entries) {
    byClass[e.kind][e.class]++
    const isProtected = e.holdReason === "protected" || e.holdReason === "worktree" || e.holdReason === "open-pr"
    const key = isProtected ? "protected" : e.status
    byStatus[e.kind][key] = (byStatus[e.kind][key] ?? 0) + 1
    names.add(e.name)
    namesByClass[e.class].add(e.name)
    const statusNames = namesByStatus.get(key) ?? new Set<string>()
    statusNames.add(e.name)
    namesByStatus.set(key, statusNames)
  }
  const distinct: BranchGcDistinctSummary = {
    branches: names.size,
    refs: plan.entries.length,
    byClass: { reclaim: namesByClass.reclaim.size, review: namesByClass.review.size, hold: namesByClass.hold.size },
    byStatus: Object.fromEntries([...namesByStatus].map(([k, v]) => [k, v.size])),
  }
  return { byClass, byStatus, distinct }
}

// ── review queue ──────────────────────────────────────────────────────

export interface BranchReviewCandidate {
  name: string
  kind: BranchRefKind
  sha: string
  ageDays: number
  author: string
  subject: string
  history: BranchHistory
  /** Base sha. */
  base: string
  compareBase?: string
  mergeBase?: string
  mergedTree?: string | null
  conflicts?: boolean
  ahead: number | null
  behind: number | null
  pushed?: BranchPushState
  coverage?: BranchCoverage
  residualFiles?: string[]
  residualFileCount?: number
  lineCoverage?: BranchLineCoverage
  cherry?: { total: number; unmatched: number }
  /** Every ref sharing this tip (a local branch and its remote twin share one review). */
  refs: string[]
  verdict?: BranchVerdictSummary
}

export interface BranchReviewQueue {
  base: string
  baseSha: string
  anchor: string | null
  candidates: BranchReviewCandidate[]
}

/**
 * The `review` entries of a plan, one per unique tip sha, with everything a
 * reviewer needs. Tips that already carry a stored verdict are skipped unless
 * `all` — verdicts are keyed by sha, so only tips that moved get re-reviewed.
 */
export function branchReviewQueue(plan: BranchGcPlan, options: { all?: boolean } = {}): BranchReviewQueue {
  const bySha = new Map<string, BranchReviewCandidate>()
  for (const e of plan.entries) {
    if (e.class !== "review") continue
    if (e.verdict && !options.all) continue
    const seen = bySha.get(e.sha)
    if (seen) {
      seen.refs.push(e.ref)
      // Refs sharing a tip: keep the line coverage from whichever carries it.
      if (!seen.lineCoverage && e.lineCoverage) seen.lineCoverage = e.lineCoverage
      if (!seen.cherry && e.cherry) seen.cherry = e.cherry
      continue
    }
    bySha.set(e.sha, {
      name: e.name,
      kind: e.kind,
      sha: e.sha,
      ageDays: e.ageDays,
      author: e.author,
      subject: e.subject,
      history: e.history,
      base: plan.baseSha,
      ...(e.compareBase ? { compareBase: e.compareBase } : {}),
      ...(e.mergeBase ? { mergeBase: e.mergeBase } : {}),
      mergedTree: e.mergedTree ?? null,
      ...(e.conflicts !== undefined ? { conflicts: e.conflicts } : {}),
      ahead: e.ahead,
      behind: e.behind,
      ...(e.pushed ? { pushed: e.pushed } : {}),
      ...(e.coverage ? { coverage: e.coverage } : {}),
      ...(e.residualFiles ? { residualFiles: e.residualFiles } : {}),
      ...(e.residualFileCount !== undefined ? { residualFileCount: e.residualFileCount } : {}),
      ...(e.lineCoverage ? { lineCoverage: e.lineCoverage } : {}),
      ...(e.cherry ? { cherry: e.cherry } : {}),
      refs: [e.ref],
      ...(e.verdict ? { verdict: e.verdict } : {}),
    })
  }
  return { base: plan.base, baseSha: plan.baseSha, anchor: plan.anchor, candidates: [...bySha.values()] }
}

// ── apply ────────────────────────────────────────────────────────────

export type BranchGcApplyOutcome =
  /** `guard: "verified-pr"` + `verifiedPr` (or `"dep-bump"` + `depBump`, `"history-covered"` + `historyCovered`): a guard-refused verdict that pass reclaimed. */
  | {
      kind: BranchRefKind
      name: string
      sha: string
      result: "deleted"
      reclaimReason: BranchGcReclaimReason
      guard?: "verified-pr" | "dep-bump" | "history-covered"
      verifiedPr?: VerifiedPrProof
      depBump?: DepBumpProof
      historyCovered?: HistoryCoveredProof
    }
  | { kind: BranchRefKind; name: string; sha: string; result: "held"; holdReason?: BranchGcHoldReason }
  /** `review` class: never touched by apply — the review/approval path decides these. */
  | { kind: BranchRefKind; name: string; sha: string; result: "skipped-review" }
  /** `review` class whose agreeing verdict was refused by a deterministic guard (`verdictGuard`, e.g. line coverage). */
  /** `verifiedPrRefusal` / `depBumpRefusal` / `historyRefusal`: why the `verified-pr`, `dep-bump` and `history-covered` passes did not reclaim it either (absent when they are off). */
  | {
      kind: BranchRefKind
      name: string
      sha: string
      result: "refused-guard"
      guard: string
      verifiedPrRefusal?: string
      depBumpRefusal?: string
      historyRefusal?: string
    }
  /** The ref now points somewhere else than the plan saw — never delete what wasn't classified. */
  | { kind: BranchRefKind; name: string; sha: string; result: "aborted-moved"; currentSha: string }
  /** The ref no longer exists. */
  | { kind: BranchRefKind; name: string; sha: string; result: "aborted-vanished" }
  /** Re-classified from scratch and no longer `reclaim`. */
  | { kind: BranchRefKind; name: string; sha: string; result: "aborted-reclassified"; from: BranchGcClass; to: BranchGcClass; holdReason?: BranchGcHoldReason }
  | { kind: BranchRefKind; name: string; sha: string; result: "failed"; message: string }

export interface ApplyBranchGcOptions {
  /** REQUIRED and non-empty: which kinds apply may delete. Entries of other kinds are left out of the outcomes. */
  scopes: readonly BranchRefKind[]
  forge?: ForgeClient
  verdicts?: BranchVerdictStore
  /** Where restore logs go. Default `~/.agentproto/branch-gc`. */
  stateDir?: string
  nowMs?: number
  /** Remote refs per `git push --delete`. Default 50. */
  remoteBatchSize?: number
  /** Run `git fetch --prune <baseRemote>` before re-deriving entries. Default true. */
  fetch?: boolean
}

export interface BranchGcApplyResult {
  outcomes: BranchGcApplyOutcome[]
  /** Restore log for this run, `null` when nothing was deleted. */
  restoreLog: string | null
}

export const BRANCH_GC_STATE_DIR = (): string => resolve(homedir(), ".agentproto", "branch-gc")

export interface BranchGcRestoreEntry {
  kind: BranchRefKind
  name: string
  ref: string
  sha: string
  remote?: string
  /** git arguments (no leading `git`) that re-create the ref, run with `-C repoRoot`. */
  argv: string[]
  /** The same, as a copy-pasteable shell command. */
  command: string
  /** Set once the delete ran. */
  deleted?: boolean
  /** Set when the `verified-pr` (or `dep-bump`, `history-covered`) pass reclaimed this ref past the line guard. */
  guard?: "verified-pr" | "dep-bump" | "history-covered"
  verifiedPr?: VerifiedPrProof
  depBump?: DepBumpProof
  historyCovered?: HistoryCoveredProof
}

export interface BranchGcRestoreLog {
  schema: "branch-gc-restore/v1"
  repoRoot: string
  base: string
  baseSha: string
  createdAt: string
  entries: BranchGcRestoreEntry[]
}

const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

function restoreEntry(repoRoot: string, e: BranchGcPlanEntry, baseRemote: string | null): BranchGcRestoreEntry {
  const argv =
    e.kind === "local"
      ? ["branch", e.name, e.sha]
      : e.kind === "remote"
        ? ["push", e.remote as string, `${e.sha}:refs/heads/${e.name}`]
        : // A forge mirror's commits may be gc'd locally; the forge still has them.
          e.status === "forge-mirror" && e.forgePr !== undefined && baseRemote
          ? ["fetch", baseRemote, `+refs/pull/${e.forgePr}/head:${e.ref}`]
          : ["update-ref", e.ref, e.sha]
  return {
    kind: e.kind,
    name: e.name,
    ref: e.ref,
    sha: e.sha,
    ...(e.remote ? { remote: e.remote } : {}),
    argv,
    command: ["git", "-C", repoRoot, ...argv].map(shellQuote).join(" "),
    ...passedGuardOf(e),
  }
}

/** The `guard` + proof fields of an entry a second pass reclaimed past the line guard. */
function passedGuardOf(e: BranchGcPlanEntry): Pick<BranchGcRestoreEntry, "guard" | "verifiedPr" | "depBump" | "historyCovered"> {
  if (e.verifiedPr) return { guard: "verified-pr", verifiedPr: e.verifiedPr }
  if (e.depBump) return { guard: "dep-bump", depBump: e.depBump }
  if (e.historyCovered) return { guard: "history-covered", historyCovered: e.historyCovered }
  return {}
}

let atomicWriteSeq = 0

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // A per-call unique temp name: two writers in one process must not share
  // (and truncate) the same temp file before either renames it.
  const tmp = `${path}.${process.pid}.${Date.now()}.${atomicWriteSeq++}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8")
  await rename(tmp, path)
}

/**
 * Execute a plan. Only `reclaim` entries whose kind is in `options.scopes`
 * are touched, and each is first re-derived from scratch: the ref is
 * re-listed (moved → `aborted-moved`, gone → `aborted-vanished`) and fully
 * re-classified against fresh worktree / open-PR / verdict state (anything but
 * `reclaim` → `aborted-reclassified`). The restore log is written before the
 * first delete runs.
 */
export async function applyBranchGc(plan: BranchGcPlan, options: ApplyBranchGcOptions): Promise<BranchGcApplyResult> {
  if (!options.scopes || options.scopes.length === 0) {
    throw new Error("branch gc apply: `scopes` is required (any of local, remote, orphan) — apply never defaults to every kind")
  }
  const scopes = normalizeScopes(options.scopes)
  const { repoRoot } = plan
  const snap = await snapshot({
    repoRoot,
    repoName: plan.repoName,
    base: plan.base,
    anchor: plan.anchor,
    ...(options.forge ? { forge: options.forge } : {}),
    ...(options.verdicts ? { verdicts: options.verdicts } : {}),
    minAgeDays: plan.minAgeDays,
    includeReviewed: plan.includeReviewed,
    // A plan from before the guard existed carries no threshold: the default applies.
    minLineCoverage: plan.minLineCoverage ?? DEFAULT_MIN_LINE_COVERAGE,
    requireOperatorBelowGuard: plan.requireOperatorBelowGuard === true,
    nowMs: options.nowMs ?? Date.now(),
    ...(options.fetch === false ? { fetch: false } : {}),
  })
  const current = new Map(snap.refs.map((r) => [r.ref, r]))

  const outcomes: BranchGcApplyOutcome[] = []
  const confirmed: BranchGcPlanEntry[] = []
  for (const e of plan.entries) {
    if (!scopes.includes(e.kind)) continue
    const id = { kind: e.kind, name: e.name, sha: e.sha }
    if (e.class === "hold") {
      outcomes.push({ ...id, result: "held", ...(e.holdReason ? { holdReason: e.holdReason } : {}) })
      continue
    }
    if (e.class === "review") {
      outcomes.push(
        e.verdictGuard
          ? {
              ...id,
              result: "refused-guard",
              guard: e.verdictGuard,
              ...(e.verifiedPrRefusal ? { verifiedPrRefusal: e.verifiedPrRefusal } : {}),
              ...(e.depBumpRefusal ? { depBumpRefusal: e.depBumpRefusal } : {}),
              ...(e.historyRefusal ? { historyRefusal: e.historyRefusal } : {}),
            }
          : { ...id, result: "skipped-review" },
      )
      continue
    }
    const fresh = current.get(e.ref)
    if (!fresh) {
      outcomes.push({ ...id, result: "aborted-vanished" })
      continue
    }
    if (fresh.sha !== e.sha) {
      outcomes.push({ ...id, result: "aborted-moved", currentSha: fresh.sha })
      continue
    }
    const now = await classifyRef(fresh, snap.env)
    if (now.class !== "reclaim") {
      outcomes.push({
        ...id,
        result: "aborted-reclassified",
        from: e.class,
        to: now.class,
        ...(now.holdReason ? { holdReason: now.holdReason } : {}),
      })
      continue
    }
    confirmed.push(now)
  }
  if (confirmed.length === 0) return { outcomes, restoreLog: null }

  const createdAt = new Date().toISOString()
  const log: BranchGcRestoreLog = {
    schema: "branch-gc-restore/v1",
    repoRoot,
    base: plan.base,
    baseSha: snap.env.ctx.baseSha,
    createdAt,
    entries: confirmed.map((e) => restoreEntry(repoRoot, e, snap.env.remote)),
  }
  const logPath = join(options.stateDir ?? BRANCH_GC_STATE_DIR(), plan.repoName, `restore-${createdAt.replace(/[:.]/g, "-")}.json`)
  await writeJsonAtomic(logPath, log)

  const results = new Map<string, { ok: true } | { ok: false; message: string }>()
  const fail = (res: ExecResult): { ok: false; message: string } => ({ ok: false, message: (res.stderr || res.stdout).trim() || `exit ${res.exitCode}` })

  for (const e of confirmed.filter((c) => c.kind === "local")) {
    const res = await git(repoRoot, ["branch", "-D", e.name])
    results.set(e.ref, res.exitCode === 0 ? { ok: true } : fail(res))
  }
  const remoteEntries = confirmed.filter((c) => c.kind === "remote")
  const byRemote = new Map<string, BranchGcPlanEntry[]>()
  for (const e of remoteEntries) byRemote.set(e.remote as string, [...(byRemote.get(e.remote as string) ?? []), e])
  for (const [remote, list] of byRemote) {
    const failedBatches: Array<{ batch: BranchGcPlanEntry[]; res: ExecResult }> = []
    for (const batch of chunk(list, options.remoteBatchSize ?? 50)) {
      // A deletion carries no content to check, and repo hooks (e.g. an AI
      // review of the checked-out branch) would otherwise run once per push.
      const res = await git(repoRoot, ["push", "--no-verify", remote, "--delete", ...batch.map((e) => e.name)])
      if (res.exitCode === 0) for (const e of batch) results.set(e.ref, { ok: true })
      else failedBatches.push({ batch, res })
    }
    // `push --delete` did not reliably drop the local tracking refs in practice.
    await git(repoRoot, ["fetch", "--prune", "--quiet", remote])
    // A non-atomic push deletes what it can and exits non-zero for the rest
    // (e.g. one branch already gone upstream): judge each ref by whether its
    // tracking ref survived the prune, not by the batch's exit code.
    // A refused batch is retried as a whole batch (same size): a single ghost
    // ref makes git refuse the entire push, but a genuinely refused batch is
    // rare enough that re-pushing the batch is cheaper than one push per ref.
    // Only refs of a batch that fails AGAIN are pushed one by one.
    const stillThere: BranchGcPlanEntry[] = []
    for (const { batch } of failedBatches) {
      for (const e of batch) {
        if ((await git(repoRoot, ["rev-parse", "--verify", "--quiet", e.ref])).exitCode === 0) stillThere.push(e)
        else results.set(e.ref, { ok: true })
      }
    }
    const failedAgain: BranchGcPlanEntry[] = []
    for (const batch of chunk(stillThere, options.remoteBatchSize ?? 50)) {
      const retry = await git(repoRoot, ["push", "--no-verify", remote, "--delete", ...batch.map((e) => e.name)])
      if (retry.exitCode === 0) for (const e of batch) results.set(e.ref, { ok: true })
      else failedAgain.push(...batch)
    }
    const retried = failedAgain.length > 0
    // The retry push is non-atomic too: it may have deleted some refs before
    // failing, so prune first and judge each ref by its tracking ref again —
    // gone ⇒ ok, only a ref still present gets its own push.
    if (retried) await git(repoRoot, ["fetch", "--prune", "--quiet", remote])
    for (const e of failedAgain) {
      if ((await git(repoRoot, ["rev-parse", "--verify", "--quiet", e.ref])).exitCode !== 0) {
        results.set(e.ref, { ok: true })
        continue
      }
      const one = await git(repoRoot, ["push", "--no-verify", remote, "--delete", e.name])
      results.set(e.ref, one.exitCode === 0 ? { ok: true } : fail(one))
    }
    if (retried) await git(repoRoot, ["fetch", "--prune", "--quiet", remote])
  }
  for (const e of confirmed.filter((c) => c.kind === "orphan")) {
    const res = await git(repoRoot, ["update-ref", "-d", e.ref, e.sha])
    results.set(e.ref, res.exitCode === 0 ? { ok: true } : fail(res))
  }

  for (const entry of log.entries) entry.deleted = results.get(entry.ref)?.ok === true
  await writeJsonAtomic(logPath, log)

  for (const e of confirmed) {
    const r = results.get(e.ref)
    const id = { kind: e.kind, name: e.name, sha: e.sha }
    if (r?.ok) {
      outcomes.push({
        ...id,
        result: "deleted",
        reclaimReason: e.reclaimReason as BranchGcReclaimReason,
        ...passedGuardOf(e),
      })
    }
    else outcomes.push({ ...id, result: "failed", message: r && !r.ok ? r.message : "not attempted" })
  }
  return { outcomes, restoreLog: logPath }
}

/** Read a restore log written by `applyBranchGc`. */
export async function readBranchGcRestoreLog(path: string): Promise<BranchGcRestoreLog> {
  return JSON.parse(await readFile(path, "utf8")) as BranchGcRestoreLog
}

// ── restore ──────────────────────────────────────────────────────────

export interface RestoreBranchGcInput {
  /** A restore log written by `applyBranchGc`. */
  logPath: string
  /**
   * The repo the caller means to restore into. The log names its own
   * `repoRoot`; when this is set the two must be the same directory, or the
   * restore refuses outright (a log from another repo, or a crafted one).
   */
  repoRoot?: string
  /** Only entries whose sha equals or starts with one of these (at least 7 hex chars). Default every entry. */
  shas?: readonly string[]
  /** Re-create a `remote`-kind ref as a LOCAL branch of the same name instead of pushing it back. */
  localOnly?: boolean
  /** Report what would be re-created; touch nothing. */
  dryRun?: boolean
  /**
   * Drop the operator approval from the stored verdict of every restored tip
   * (the reviewer verdict stays), so the next `--include-reviewed` run
   * re-judges it through the line guard and the `verified-pr` pass instead
   * of deleting it again on the old approval. Needs `verdicts`. Default true.
   */
  revokeApproval?: boolean
  verdicts?: BranchVerdictStore
  /** The verdict store's repo key. Default `repoLabel` of the log's repo. */
  repoName?: string
}

export interface BranchGcRestoreOutcome {
  kind: BranchRefKind
  name: string
  sha: string
  /** The ref re-created (or that would be): `refs/heads/<name>`, or the remote branch for a pushed-back remote ref. */
  target: string
  /**
   * `restored` re-created; `would-restore` dry run; `already-present` the ref
   * is already at that sha (nothing to do); `refused-conflict` a ref with that
   * name exists at ANOTHER sha (never overwritten); `missing-commit` the sha
   * is no longer in the object database; `invalid-entry` the log entry is not
   * one `applyBranchGc` writes (nothing run); `failed` git refused.
   * Entries of one batch that map to the same target (with `localOnly`, a
   * `remote` and a `local` entry of the same name) are resolved up front, so
   * a dry run reports what the real run does whatever the log order: the
   * same sha twice restores once, the next is `already-present`; when one
   * sha is an ancestor of the others, only the descendant is restored and
   * each ancestor is `contained` (nothing run, its commits are kept by the
   * descendant, named in `message`), but only once that descendant is
   * actually `restored`, `already-present`, or (dry run) `would-restore`:
   * when it is not, the ancestor is `refused-conflict` (descendant refused)
   * or `failed` (any other result), naming the descendant and its result, as
   * nothing then holds its commits; diverged shas are all
   * `refused-conflict`, naming each other, until `--sha` picks one.
   */
  result:
    | "restored"
    | "would-restore"
    | "already-present"
    | "contained"
    | "refused-conflict"
    | "missing-commit"
    | "invalid-entry"
    | "failed"
  /** The git command run (or that would be), as a shell line. */
  command?: string
  message?: string
  /** Set when the operator approval of this tip's stored verdict was dropped. */
  approvalRevoked?: boolean
}

export interface BranchGcRestoreResult {
  logPath: string
  repoRoot: string
  outcomes: BranchGcRestoreOutcome[]
  /** `shas` selectors that matched no entry of the log. */
  unmatched: string[]
}

/** The current sha of `ref`, or `null` when it does not exist. */
async function refSha(repoRoot: string, ref: string): Promise<string | null> {
  const res = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
  return res.exitCode === 0 ? res.stdout.trim() : null
}

const REMOTE_NAME_RE = /^[A-Za-z0-9][\w.-]*$/
const FORGE_MIRROR_SPEC_RE = /^\+refs\/pull\/(\d+)\/head:(.+)$/

/**
 * A log entry as a restore plan: what to re-create and the git argv to do it,
 * rebuilt from the entry's validated fields, never taken from its `argv` (a
 * log is a file anyone can write). `string` = why the entry is refused.
 */
async function restorePlanOf(
  repoRoot: string,
  e: BranchGcRestoreEntry,
  remotes: ReadonlySet<string>,
  localOnly: boolean,
): Promise<{ target: string; argv: string[]; remote?: string; local: boolean } | string> {
  if (typeof e.name !== "string" || typeof e.ref !== "string" || typeof e.sha !== "string") return "missing name/ref/sha"
  if (!FULL_SHA_RE.test(e.sha)) return `sha "${e.sha}" is not a full lowercase hex sha`
  if (e.name.startsWith("-") || (await git(repoRoot, ["check-ref-format", "--branch", e.name])).exitCode !== 0) {
    return `"${e.name}" is not a valid branch name`
  }
  if ((await git(repoRoot, ["check-ref-format", e.ref])).exitCode !== 0) return `"${e.ref}" is not a valid ref`
  const remoteOk = (r: unknown): r is string => typeof r === "string" && REMOTE_NAME_RE.test(r) && remotes.has(r)
  if (e.kind === "local") {
    if (e.ref !== `refs/heads/${e.name}`) return `local ref ${e.ref} does not match name ${e.name}`
    return { target: e.ref, argv: ["branch", e.name, e.sha], local: true }
  }
  if (e.kind === "remote") {
    if (!remoteOk(e.remote)) return `remote "${String(e.remote)}" is not a configured remote of ${repoRoot}`
    if (e.ref !== `refs/remotes/${e.remote}/${e.name}`) return `remote ref ${e.ref} does not match ${e.remote}/${e.name}`
    if (localOnly) return { target: `refs/heads/${e.name}`, argv: ["branch", e.name, e.sha], local: true }
    return { target: `${e.remote}:refs/heads/${e.name}`, argv: ["push", "--no-verify", e.remote, `${e.sha}:refs/heads/${e.name}`], remote: e.remote, local: false }
  }
  if (e.kind === "orphan") {
    if (e.ref !== `refs/remotes/${e.name}`) return `orphan ref ${e.ref} does not match name ${e.name}`
    // A forge mirror's commits may be gone locally: re-fetch its PR head.
    if (Array.isArray(e.argv) && e.argv[0] === "fetch") {
      const m = FORGE_MIRROR_SPEC_RE.exec(String(e.argv[2] ?? ""))
      if (!remoteOk(e.argv[1]) || !m || m[2] !== e.ref || e.argv.length !== 3) return "forge-mirror entry does not match its ref"
      return { target: e.ref, argv: ["fetch", e.argv[1], `+refs/pull/${m[1]}/head:${e.ref}`], local: true }
    }
    return { target: e.ref, argv: ["update-ref", e.ref, e.sha, "0".repeat(e.sha.length)], local: true }
  }
  return `unknown kind "${String(e.kind)}"`
}

/**
 * The targets more than one entry of a restore batch maps to with different
 * shas, decided from content, never from log order: `winner` is the sha that
 * descends from every other one (each other entry is contained in it), or
 * `diverged` when there is no such sha (or an ancestry check cannot run).
 */
async function resolveBatchTargets(
  repoRoot: string,
  entries: readonly BranchGcRestoreEntry[],
  plans: ReadonlyArray<Awaited<ReturnType<typeof restorePlanOf>>>,
): Promise<Map<string, { entries: BranchGcRestoreEntry[]; winner: string; diverged: boolean }>> {
  const byTarget = new Map<string, BranchGcRestoreEntry[]>()
  for (const [i, plan] of plans.entries()) {
    if (typeof plan === "string") continue
    const list = byTarget.get(plan.target) ?? []
    list.push(entries[i] as BranchGcRestoreEntry)
    byTarget.set(plan.target, list)
  }
  const out = new Map<string, { entries: BranchGcRestoreEntry[]; winner: string; diverged: boolean }>()
  const isAncestor = async (a: string, b: string): Promise<boolean> =>
    (await git(repoRoot, ["merge-base", "--is-ancestor", a, b])).exitCode === 0
  for (const [target, list] of byTarget) {
    const shas = [...new Set(list.map((x) => x.sha))]
    if (shas.length < 2) continue
    let winner: string | undefined
    for (const candidate of shas) {
      const others = shas.filter((x) => x !== candidate)
      if ((await Promise.all(others.map((x) => isAncestor(x, candidate)))).every(Boolean)) {
        winner = candidate
        break
      }
    }
    out.set(target, { entries: list, winner: winner ?? "", diverged: winner === undefined })
  }
  return out
}

/**
 * Re-create the refs a `branch gc --apply` deleted, from its restore log:
 * a `local` ref with `git branch`, a `remote` ref by pushing the sha back to
 * its remote (or, `localOnly`, as a local branch of the same name), an
 * `orphan` ref with `update-ref` (a forge mirror is re-fetched from its PR
 * head). Every command is rebuilt from the entry's validated fields, never
 * run from its stored `argv`, and the log's repo must be the caller's
 * `repoRoot`. A ref that exists at ANOTHER sha is never overwritten
 * (`refused-conflict`); one already at the sha is `already-present`.
 * Entries that share a target are resolved before anything runs (see
 * `BranchGcRestoreOutcome.result`), so the dry run matches the real run. Then,
 * unless `revokeApproval` is false, the operator approval of each restored
 * tip's stored verdict is dropped so the next run re-judges it.
 */
export async function restoreBranchGc(input: RestoreBranchGcInput): Promise<BranchGcRestoreResult> {
  const logPath = resolve(input.logPath)
  const log = await readBranchGcRestoreLog(logPath)
  if (log?.schema !== "branch-gc-restore/v1" || !Array.isArray(log.entries) || typeof log.repoRoot !== "string") {
    throw new Error(`${logPath} is not a branch-gc restore log (schema branch-gc-restore/v1)`)
  }
  const real = (p: string): Promise<string> => realpath(p).catch(() => resolve(p))
  const repoRoot = await real(log.repoRoot)
  if (input.repoRoot !== undefined && (await real(input.repoRoot)) !== repoRoot) {
    throw new Error(`${logPath} restores into ${log.repoRoot}, not ${input.repoRoot}`)
  }
  const top = await git(repoRoot, ["rev-parse", "--show-toplevel"])
  if (top.exitCode !== 0 || (await real(top.stdout.trim())) !== repoRoot) {
    throw new Error(`${log.repoRoot} (from ${logPath}) is not the root of a git repository`)
  }
  const selectors = (input.shas ?? []).map((x) => x.trim().toLowerCase())
  for (const sel of selectors) {
    if (!/^[0-9a-f]{7,64}$/.test(sel)) throw new Error(`--sha "${sel}" is not a sha (7 to 64 hex chars)`)
  }
  const shaOf = (e: BranchGcRestoreEntry): string => (typeof e?.sha === "string" ? e.sha : "")
  const matches = (sha: string): boolean => selectors.length === 0 || selectors.some((sel) => sha.startsWith(sel))
  const unmatched = selectors.filter((sel) => !log.entries.some((e) => shaOf(e).startsWith(sel)))
  const remotes = await configuredRemotes(repoRoot)
  const outcomes: BranchGcRestoreOutcome[] = []
  const restoredShas = new Set<string>()
  const selected = log.entries.filter((x) => matches(shaOf(x)))
  const plans = await Promise.all(selected.map((e) => restorePlanOf(repoRoot, e, remotes, input.localOnly === true)))
  const batch = await resolveBatchTargets(repoRoot, selected, plans)
  /** Targets this batch already restored (or would, in a dry run): target -> sha. */
  const planned = new Map<string, string>()
  /** Ancestors whose outcome waits on what happens to their descendant (it may come later in the log). */
  const pendingContained: { outcome: BranchGcRestoreOutcome; winner: string }[] = []

  for (const [i, e] of selected.entries()) {
    const id = { kind: e.kind, name: e.name, sha: e.sha }
    const plan = plans[i] as Awaited<ReturnType<typeof restorePlanOf>>
    if (typeof plan === "string") {
      outcomes.push({ ...id, target: String(e.ref), result: "invalid-entry", message: plan })
      continue
    }
    const { target, argv } = plan
    if (planned.get(target) === e.sha) {
      outcomes.push({ ...id, target, result: "already-present", message: `an earlier entry of this batch restores ${target} to it` })
      continue
    }
    let current: string | null
    if (plan.remote) {
      const ls = await git(repoRoot, ["ls-remote", plan.remote, `refs/heads/${e.name}`], { GIT_TERMINAL_PROMPT: "0" })
      if (ls.exitCode !== 0) {
        outcomes.push({ ...id, target, result: "failed", message: `ls-remote ${plan.remote}: ${(ls.stderr || ls.stdout).trim() || `exit ${ls.exitCode}`}` })
        continue
      }
      current = ls.stdout.split("\t")[0]?.trim() || null
    } else {
      current = await refSha(repoRoot, plan.target)
    }
    const command = ["git", "-C", repoRoot, ...argv].map(shellQuote).join(" ")
    if (current === e.sha) {
      outcomes.push({ ...id, target, result: "already-present" })
      restoredShas.add(e.sha)
      continue
    }
    const collision = batch.get(target)
    // The descendant is restored (or will be, or was by an earlier run): its ancestor needs nothing, settled below.
    if (collision && !collision.diverged && collision.winner !== e.sha && (current === null || current === collision.winner)) {
      const outcome: BranchGcRestoreOutcome = { ...id, target, result: "contained" }
      outcomes.push(outcome)
      pendingContained.push({ outcome, winner: collision.winner })
      continue
    }
    if (current !== null) {
      outcomes.push({ ...id, target, result: "refused-conflict", message: `${target} exists at ${current.slice(0, 12)}, not ${e.sha.slice(0, 12)}` })
      continue
    }
    if (collision?.diverged) {
      const others = collision.entries.filter((x) => x.sha !== e.sha).map((x) => `${x.kind} ${x.name} ${x.sha.slice(0, 12)}`)
      outcomes.push({
        ...id,
        target,
        result: "refused-conflict",
        message: `${target} is also restored by ${others.join(", ")} (diverged): pick one with --sha`,
      })
      continue
    }
    if (argv[0] !== "fetch" && (await git(repoRoot, ["cat-file", "-e", `${e.sha}^{commit}`])).exitCode !== 0) {
      outcomes.push({ ...id, target, result: "missing-commit", command, message: `${e.sha} is no longer in the object database` })
      continue
    }
    if (input.dryRun) {
      outcomes.push({ ...id, target, result: "would-restore", command })
      planned.set(target, e.sha)
      continue
    }
    const res = await git(repoRoot, argv, argv[0] === "fetch" ? { GIT_TERMINAL_PROMPT: "0" } : undefined)
    if (res.exitCode !== 0) {
      outcomes.push({ ...id, target, result: "failed", command, message: (res.stderr || res.stdout).trim() || `exit ${res.exitCode}` })
      continue
    }
    if (argv[0] === "fetch") {
      // The PR head moved since the mirror was deleted: not the ref we deleted.
      const fetched = await refSha(repoRoot, e.ref)
      if (fetched !== e.sha) {
        await git(repoRoot, ["update-ref", "-d", e.ref])
        outcomes.push({ ...id, target, result: "failed", command, message: `the PR head is now ${fetched?.slice(0, 12) ?? "missing"}, not ${e.sha.slice(0, 12)}` })
        continue
      }
    }
    // Keep the tracking ref in step with the branch just pushed back.
    if (plan.remote) await git(repoRoot, ["update-ref", e.ref, e.sha])
    outcomes.push({ ...id, target, result: "restored", command })
    planned.set(target, e.sha)
    restoredShas.add(e.sha)
  }

  // An ancestor is `contained` only when its descendant really holds its commits.
  const held = new Set<BranchGcRestoreOutcome["result"]>(["restored", "already-present", "would-restore"])
  for (const { outcome, winner } of pendingContained) {
    const w = winner.slice(0, 12)
    const ofWinner = outcomes.filter((o) => o.sha === winner && o.target === outcome.target)
    const won = ofWinner.find((o) => held.has(o.result))
    if (won) {
      outcome.message =
        won.result === "already-present"
          ? `contained in ${w}, already at ${outcome.target}`
          : won.result === "would-restore"
            ? `contained in ${w}, which would be restored to ${outcome.target} instead`
            : `contained in ${w}, restored to ${outcome.target} instead`
      continue
    }
    const lost = ofWinner[0]
    const why = lost ? `${lost.result}${lost.message ? `: ${lost.message}` : ""}` : "not attempted"
    outcome.result = lost?.result === "refused-conflict" ? "refused-conflict" : "failed"
    outcome.message = `contained in ${w}, which ${input.dryRun ? "would not be" : "was not"} restored to ${outcome.target} (${why}): nothing holds this tip, restore it with --sha`
  }

  if (!input.dryRun && input.revokeApproval !== false && input.verdicts && restoredShas.size > 0) {
    const repoName = input.repoName ?? repoLabel(log.repoRoot)
    const revoked = new Set<string>()
    for (const sha of restoredShas) {
      const record = await input.verdicts.get(repoName, sha)
      if (!record?.operator) continue
      const { operator: _operator, ...rest } = record
      await input.verdicts.set(rest)
      revoked.add(sha)
    }
    for (const o of outcomes) if (revoked.has(o.sha) && (o.result === "restored" || o.result === "already-present")) o.approvalRevoked = true
  }
  return { logPath, repoRoot, outcomes, unmatched }
}

// ── verdict store ────────────────────────────────────────────────────

export const BRANCH_TRIAGE_VERDICTS = ["obsolete", "superseded", "salvage", "in-progress", "unclear"] as const
export type BranchTriageVerdict = (typeof BRANCH_TRIAGE_VERDICTS)[number]

/**
 * One reviewer verdict for one branch tip. `gate` is the second opinion that
 * actually licenses deletion (`agree: true`); a triage-only verdict (no
 * `gate`) records the review but never makes a ref reclaimable. An agreeing
 * gate must cite evidence.
 */
export const branchVerdictSchema = z
  .object({
    name: z.string().trim().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "sha must be a full 40- or 64-char lowercase hex object id"),
    triage: z.object({
      verdict: z.enum(BRANCH_TRIAGE_VERDICTS),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1),
      salvage: z.string().optional(),
    }),
    gate: z
      .object({
        agree: z.boolean(),
        verdict: z.enum(BRANCH_TRIAGE_VERDICTS),
        reason: z.string().min(1),
        evidence: z.array(z.string().min(1)),
      })
      .optional(),
    reviewer: z.string().trim().min(1),
    /**
     * Structured evidence for a `superseded` verdict: the PR(s) that landed
     * this tip's work (and optionally the commit on base). The `verified-pr`
     * pass checks them against the forge; without it, `#N` in gate.reason /
     * evidence is used instead.
     */
    landedIn: z
      .array(
        z.object({
          pr: z.number().int().positive(),
          commit: z.string().regex(/^[0-9a-f]{7,64}$/, "commit must be a lowercase hex sha (7-64 chars)").optional(),
        }),
      )
      .optional(),
    /** Operator approval that overrides `lineCoverageGuard` for this exact tip. */
    operator: z
      .object({
        by: z.string().trim().min(1),
        note: z.string().trim().min(1).optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.gate?.agree && v.gate.evidence.length === 0) {
      ctx.addIssue({ code: "custom", path: ["gate", "evidence"], message: "gate.agree=true requires at least one evidence entry" })
    }
    // `landedIn` says where superseded work landed: on any other verdict it
    // is a contradiction the store must not keep.
    if (v.landedIn?.length && v.triage.verdict !== "superseded" && v.gate?.verdict !== "superseded") {
      ctx.addIssue({ code: "custom", path: ["landedIn"], message: "landedIn is only for a superseded verdict" })
    }
    // The operator approval is a separate trust boundary from the review: an
    // automated reviewer must not self-certify the override it is being
    // guarded against by putting its own name in `operator.by`.
    if (v.operator && v.operator.by.trim().toLowerCase() === v.reviewer.trim().toLowerCase()) {
      ctx.addIssue({
        code: "custom",
        path: ["operator", "by"],
        message: "operator.by must name someone other than the reviewer",
      })
    }
  })

export type BranchVerdict = z.infer<typeof branchVerdictSchema>

export interface BranchVerdictRecord extends BranchVerdict {
  repo: string
  recordedAt: string
  /**
   * How many earlier verdicts for this exact tip this record replaced,
   * stamped by {@link recordBranchVerdict} (absent on a first verdict). A
   * caller can tell a tip that was already re-reviewed from one that never
   * was without trusting the reviewer to say so.
   */
  revision?: number
}

export interface BranchVerdictStore {
  /** The verdict for this exact tip, or `null`. A ref whose tip moved simply finds nothing. */
  get(repo: string, sha: string): Promise<BranchVerdictRecord | null>
  set(record: BranchVerdictRecord): Promise<void>
}

/** NUL-joined like the worktree verdict memo — cannot occur in a repo label or a sha. */
const verdictKey = (repo: string, sha: string): string => `${repo}\u0000${sha}`

export const BRANCH_VERDICTS_PATH = (): string => resolve(homedir(), ".agentproto", "branch-gc-verdicts.json")

const verdictRecordSchema = z.intersection(
  branchVerdictSchema,
  z.object({ repo: z.string(), recordedAt: z.string(), revision: z.number().int().positive().optional() }),
)
const verdictFileSchema = z.object({ entries: z.array(z.unknown()) })

/**
 * In-process per-file lock. `record` calls each construct their own
 * `FileBranchVerdictStore`, so a per-instance lock would not serialise them;
 * the mutex is keyed by the verdict file's path and shared by every instance
 * in this process.
 */
const verdictLocks = new Map<string, Promise<void>>()

const VERDICT_LOCK_TIMEOUT_MS = 10_000
const VERDICT_LOCK_STALE_MS = 60_000

/** Cross-process lock: `writeFile(..., { flag: "wx" })` is atomic; a stale lock (a crashed writer) is reaped after a minute. */
async function acquireVerdictFileLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + VERDICT_LOCK_TIMEOUT_MS
  for (;;) {
    const token = `${process.pid}:${randomUUID()}`
    try {
      await writeFile(lockPath, `${token}\n`, { encoding: "utf8", flag: "wx" })
      return async () => {
        // Only release our own lock: if we stalled past the stale window and
        // another process reaped and replaced it, its lock must survive.
        try {
          if ((await readFile(lockPath, "utf8")).trim() === token) await unlink(lockPath)
        } catch {
          // Already gone (or reaped) — nothing to release.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      try {
        const st = await stat(lockPath)
        if (Date.now() - st.mtimeMs > VERDICT_LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`branch verdict store: timed out waiting for ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 15)))
    }
  }
}

async function withVerdictLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true })
  const previous = verdictLocks.get(path) ?? Promise.resolve()
  let releaseInProcess!: () => void
  const held = new Promise<void>((resolve) => {
    releaseInProcess = resolve
  })
  const tail = previous.then(() => held)
  verdictLocks.set(path, tail)
  await previous
  let releaseFile: (() => Promise<void>) | undefined
  try {
    releaseFile = await acquireVerdictFileLock(`${path}.lock`)
    return await fn()
  } finally {
    if (releaseFile) await releaseFile()
    releaseInProcess()
    if (verdictLocks.get(path) === tail) verdictLocks.delete(path)
  }
}

/** `~/.agentproto/branch-gc-verdicts.json`, keyed by (repo, tip sha). */
export class FileBranchVerdictStore implements BranchVerdictStore {
  private cache: Map<string, BranchVerdictRecord> | null = null
  private cacheStamp: string | null = null

  constructor(private readonly path: string = BRANCH_VERDICTS_PATH()) {}

  /** mtime + size, so a `get` on a long-lived instance observes another writer's rename. */
  private async fileStamp(): Promise<string | null> {
    try {
      const st = await stat(this.path)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  private async load(): Promise<Map<string, BranchVerdictRecord>> {
    const stamp = await this.fileStamp()
    if (this.cache && stamp === this.cacheStamp) return this.cache
    const map = new Map<string, BranchVerdictRecord>()
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"))
    } catch {
      this.cache = map
      this.cacheStamp = stamp
      return map
    }
    const file = verdictFileSchema.safeParse(parsed)
    if (file.success) {
      for (const raw of file.data.entries) {
        const rec = verdictRecordSchema.safeParse(raw)
        if (rec.success) map.set(verdictKey(rec.data.repo, rec.data.sha), rec.data)
      }
    }
    this.cache = map
    this.cacheStamp = stamp
    return map
  }

  async get(repo: string, sha: string): Promise<BranchVerdictRecord | null> {
    return (await this.load()).get(verdictKey(repo, sha)) ?? null
  }

  async set(record: BranchVerdictRecord): Promise<void> {
    // Serialise every writer of this file, then re-read from disk under the
    // lock so a write from another instance between our last load and now is
    // merged instead of overwritten. The rename keeps readers whole.
    await withVerdictLock(this.path, async () => {
      this.cache = null
      this.cacheStamp = null
      const map = await this.load()
      map.set(verdictKey(record.repo, record.sha), record)
      await writeJsonAtomic(this.path, { entries: [...map.values()] })
      // A different process may write immediately after this rename: drop the
      // cache so the next read sees the file, not this writer's snapshot.
      this.cache = null
      this.cacheStamp = null
    })
  }
}

export class InMemoryBranchVerdictStore implements BranchVerdictStore {
  private readonly map = new Map<string, BranchVerdictRecord>()
  async get(repo: string, sha: string): Promise<BranchVerdictRecord | null> {
    return this.map.get(verdictKey(repo, sha)) ?? null
  }
  async set(record: BranchVerdictRecord): Promise<void> {
    this.map.set(verdictKey(record.repo, record.sha), record)
  }
}

export class BranchVerdictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BranchVerdictError"
  }
}

/**
 * Validate and store one verdict. Rejects a malformed verdict, an agreeing
 * gate with no evidence, and a sha that isn't a commit in this repo. A
 * verdict replacing a stored one for the same tip gets `revision` one past
 * the replaced record's.
 */
export async function recordBranchVerdict(input: {
  repoRoot: string
  repoName: string
  verdict: unknown
  store: BranchVerdictStore
  now?: () => string
}): Promise<BranchVerdictRecord> {
  const parsed = branchVerdictSchema.safeParse(input.verdict)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")
    throw new BranchVerdictError(`invalid branch verdict: ${issues}`)
  }
  const exists = await git(input.repoRoot, ["cat-file", "-e", `${parsed.data.sha}^{commit}`])
  if (exists.exitCode !== 0) {
    throw new BranchVerdictError(`invalid branch verdict: ${parsed.data.sha} is not a commit in ${input.repoRoot}`)
  }
  const prior = await input.store.get(input.repoName, parsed.data.sha)
  const record: BranchVerdictRecord = {
    ...parsed.data,
    repo: input.repoName,
    recordedAt: (input.now ?? (() => new Date().toISOString()))(),
    ...(prior ? { revision: (prior.revision ?? 0) + 1 } : {}),
  }
  await input.store.set(record)
  return record
}

// ── operator approval ────────────────────────────────────────────────

const FULL_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** Why `approveBranchVerdict` refused. */
export type BranchApprovalRefusal =
  | "no-ref"
  | "ambiguous"
  | "no-verdict"
  | "not-agreed"
  | "tip-moved"
  | "by-is-reviewer"

export type BranchApprovalResult =
  | {
      ok: true
      /** `would-record` on a dry run; `already-approved` leaves the stored operator block untouched. */
      status: "recorded" | "would-record" | "already-approved"
      target: string
      name: string
      sha: string
      /** The refs (`refs/heads/x`, `refs/remotes/origin/x`) currently at `sha` under `name`. */
      refs: string[]
      /** The verdict recorded (or that would be): the stored one plus `operator`. */
      verdict: BranchVerdict
      record?: BranchVerdictRecord
    }
  | { ok: false; refusal: BranchApprovalRefusal; target: string; message: string }

/** Every local, base-remote and orphan ref named `name` (remote refs drop
 *  their `<remote>/` prefix, the way `branch gc` names them), with its tip. */
async function refsNamed(repoRoot: string, name: string): Promise<Array<{ ref: string; sha: string }>> {
  const out = await gitOk(repoRoot, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads", "refs/remotes"])
  const hits: Array<{ ref: string; sha: string }> = []
  for (const line of out.split("\n")) {
    const [ref = "", sha = ""] = line.split("\t")
    if (!ref) continue
    const matches =
      ref === `refs/heads/${name}` ||
      ref === `refs/remotes/${name}` ||
      (ref.startsWith("refs/remotes/") && ref.slice("refs/remotes/".length).replace(/^[^/]+\//, "") === name)
    if (matches) hits.push({ ref, sha })
  }
  return hits
}

/**
 * Record a human operator approval for one stored verdict, copying it so the
 * operator names only the tip (`target`: a full sha, or a branch name whose
 * current tip has a verdict) and themselves. Refuses — never records — when
 * the target resolves to no ref, when no verdict is stored for the tip, when
 * the stored gate did not agree, when no ref named in the verdict still points
 * at that sha, or when `by` is the reviewer. This only stores the approval;
 * the next `branch gc --include-reviewed --apply` is what deletes.
 *
 * It carries no trust check of its own: the caller is the operator boundary.
 */
export async function approveBranchVerdict(input: {
  repoRoot: string
  repoName: string
  target: string
  by: string
  note?: string
  dryRun?: boolean
  store: BranchVerdictStore
  now?: () => string
}): Promise<BranchApprovalResult> {
  const target = input.target.trim()
  const refuse = (refusal: BranchApprovalRefusal, message: string): BranchApprovalResult => ({ ok: false, refusal, target, message })
  let record: BranchVerdictRecord | null
  if (FULL_SHA_RE.test(target)) {
    record = await input.store.get(input.repoName, target)
    if (!record) return refuse("no-verdict", `no stored verdict for ${target}`)
  } else {
    const refs = await refsNamed(input.repoRoot, target)
    if (refs.length === 0) return refuse("no-ref", `no branch named "${target}" (pass the full tip sha instead)`)
    const found = new Map<string, BranchVerdictRecord>()
    for (const sha of new Set(refs.map((r) => r.sha))) {
      const r = await input.store.get(input.repoName, sha)
      if (r) found.set(sha, r)
    }
    if (found.size === 0) {
      const tips = [...new Set(refs.map((r) => r.sha.slice(0, 10)))].join(", ")
      return refuse("no-verdict", `no stored verdict for the current tip of "${target}" (${tips})`)
    }
    if (found.size > 1) {
      return refuse("ambiguous", `"${target}" has refs at ${found.size} reviewed tips (${[...found.keys()].join(", ")}): pass the sha`)
    }
    record = [...found.values()][0] as BranchVerdictRecord
  }
  if (record.gate?.agree !== true) {
    return refuse("not-agreed", `the stored verdict for ${record.sha} has no agreeing gate (gate.agree is ${record.gate ? String(record.gate.agree) : "absent"})`)
  }
  const atTip = (await refsNamed(input.repoRoot, record.name)).filter((r) => r.sha === record.sha)
  if (atTip.length === 0) {
    return refuse("tip-moved", `no ref named "${record.name}" points at ${record.sha} any more: the verdict is for an old tip`)
  }
  const by = input.by.trim()
  if (by.toLowerCase() === record.reviewer.trim().toLowerCase()) {
    return refuse("by-is-reviewer", `--by must name someone other than the reviewer ("${record.reviewer}")`)
  }
  const { repo: _repo, recordedAt: _at, revision: _revision, operator: prior, ...stored } = record
  const note = input.note?.trim()
  const verdict: BranchVerdict = { ...stored, operator: { by, ...(note ? { note } : {}) } }
  const base = { ok: true as const, target, name: record.name, sha: record.sha, refs: atTip.map((r) => r.ref) }
  if (prior) return { ...base, status: "already-approved", verdict: { ...stored, operator: prior }, record }
  if (input.dryRun) return { ...base, status: "would-record", verdict }
  const recorded = await recordBranchVerdict({
    repoRoot: input.repoRoot,
    repoName: input.repoName,
    verdict,
    store: input.store,
    ...(input.now ? { now: input.now } : {}),
  })
  return { ...base, status: "recorded", verdict, record: recorded }
}
