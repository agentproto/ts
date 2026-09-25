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
 *
 * Anything else is `unmerged` and — once older than `minAgeDays` and not
 * protected — becomes `review`, carrying everything a reviewer needs (coverage
 * summary, the files NOT provably in base, push state).
 */

import { spawn } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { execArgv, type ExecResult } from "./exec.js"
import type { ForgeClient } from "./forge.js"
import { listGitWorktrees } from "./status.js"

// ── types ────────────────────────────────────────────────────────────

export const BRANCH_GC_SCOPES = ["local", "remote", "orphan"] as const
/** `local` = refs/heads, `remote` = the base remote's tracking refs, `orphan` = refs/remotes/<ns>/* of a remote that no longer exists. */
export type BranchRefKind = (typeof BRANCH_GC_SCOPES)[number]

/** The ladder's verdict for one tip, in order of increasing cost. */
export type BranchStatus = "merged" | "squash-merged" | "patch-merged" | "content-merged" | "unmerged"

/**
 * `current`: the tip shares history with base. `pre-rewrite`: it doesn't, but
 * base was re-rooted and an anchor (the old-history twin of base's root)
 * answers for it. `unrelated`: no shared history and no anchor — unmerged by
 * definition, since nothing can prove it landed.
 */
export type BranchHistory = "current" | "pre-rewrite" | "unrelated"

export type BranchGcClass = "reclaim" | "review" | "hold"

/** Why a `reclaim` entry is reclaimable: one of the ladder's proven tiers, or a stored gate verdict (`includeReviewed`). */
export type BranchGcReclaimReason = Exclude<BranchStatus, "unmerged"> | "reviewed"

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

/** Summary of a stored verdict for this exact tip, when one exists. */
export interface BranchVerdictSummary {
  triage: BranchTriageVerdict
  agree: boolean | null
  reviewer: string
}

export interface BranchGcPlanEntry extends BranchRef, TipClassification {
  ageDays: number
  class: BranchGcClass
  reclaimReason?: BranchGcReclaimReason
  holdReason?: BranchGcHoldReason
  /** Human detail for a hold: the worktree path, `PR #n`, or why the PR check failed. */
  holdDetail?: string
  /** Set for unmerged local and orphan refs. */
  pushed?: BranchPushState
  verdict?: BranchVerdictSummary
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
  generatedAt: string
  /** Refs of OTHER configured remotes: never classified, never touched. */
  otherRemoteRefs: number
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
}

export async function createLadderContext(repoRoot: string, baseRef: string, anchor: string | null): Promise<LadderContext> {
  const baseSha = (await gitOk(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim()
  const baseTree = (await gitOk(repoRoot, ["rev-parse", `${baseSha}^{tree}`])).trim()
  let idx: Promise<TreeIndex> | null = null
  return {
    repoRoot,
    baseSha,
    baseTree,
    anchor,
    index: () => (idx ??= indexTree(repoRoot, baseSha)),
  }
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

/**
 * Run the ladder for one tip against `ctx`'s base. Pure read. A tip with no
 * history in common with base is checked against the anchor when there is one
 * (ancestry/cherry against the anchor; merge-tree with
 * `--merge-base=merge-base(anchor, tip)`), else it is `unmerged`/`unrelated`.
 */
export async function classifyTip(ctx: LadderContext, tip: string): Promise<TipClassification> {
  const { repoRoot, baseSha, baseTree, anchor } = ctx
  const related = (await git(repoRoot, ["merge-base", baseSha, tip])).exitCode === 0
  if (!related && !anchor) return { status: "unmerged", history: "unrelated", conflicts: true, ahead: null, behind: null }
  const history: BranchHistory = related ? "current" : "pre-rewrite"
  const cmp = related ? baseSha : (anchor as string)

  if ((await git(repoRoot, ["merge-base", "--is-ancestor", tip, cmp])).exitCode === 0) {
    return { status: "merged", history, ahead: 0, behind: null }
  }
  const counts = (await gitOk(repoRoot, ["rev-list", "--left-right", "--count", `${cmp}...${tip}`])).trim().split(/\s+/)
  const behind = Number(counts[0])
  const ahead = Number(counts[1])
  const mergeBase = (await git(repoRoot, ["merge-base", cmp, tip])).stdout.trim()
  const mtArgs = related ? [baseSha, tip] : [`--merge-base=${mergeBase}`, baseSha, tip]
  const mt = await git(repoRoot, ["merge-tree", "--write-tree", "--no-messages", ...mtArgs])
  const mergedTree = (mt.stdout.split("\n")[0] ?? "").trim()
  const conflicts = mt.exitCode !== 0
  if (!conflicts && mergedTree === baseTree) return { status: "squash-merged", history, ahead, behind, conflicts }
  if (conflicts) {
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
export async function detectAnchor(repoRoot: string, baseSha: string, tips: readonly string[]): Promise<string | null> {
  const roots = (await gitOk(repoRoot, ["rev-list", "--max-parents=0", baseSha])).trim().split("\n").filter(Boolean)
  if (roots.length !== 1) return null
  const root = roots[0] as string
  const unrelated: string[] = []
  for (const sha of new Set(tips)) {
    if ((await git(repoRoot, ["merge-base", baseSha, sha])).exitCode !== 0) unrelated.push(sha)
  }
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
}

async function openPrHeads(forge: ForgeClient | undefined): Promise<OpenPrHeads> {
  if (!forge) return { available: false, reason: "no forge client", heads: new Map() }
  if (!forge.listOpenPullRequests) {
    return { available: false, reason: "forge client cannot list open PRs", heads: new Map() }
  }
  try {
    const prs = await forge.listOpenPullRequests()
    const heads = new Map<string, number>()
    for (const pr of prs) if (pr.state === "open") heads.set(pr.headRefName, pr.number)
    return { available: true, heads }
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "forge error"
    return { available: false, reason, heads: new Map() }
  }
}

// ── classification of one ref ──────────────────────────────────────────

interface ClassifyEnv {
  ctx: LadderContext
  remote: string | null
  baseName: string
  worktrees: Map<string, string>
  prs: OpenPrHeads
  remoteShas: Set<string>
  remoteNames: Set<string>
  minAgeDays: number
  includeReviewed: boolean
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
      const contained = await git(repoRoot, ["for-each-ref", "--contains", b.sha, "--format=x", `refs/remotes/${env.remote}`])
      if (contained.stdout.trim()) return "contained-in-remote"
    }
    return env.remoteNames.has(b.name) ? "diverged-from-remote" : "local-only"
  }
  if (b.kind === "orphan") {
    const scopes = ["refs/heads", ...(env.remote ? [`refs/remotes/${env.remote}`] : [])]
    const contained = await git(repoRoot, ["for-each-ref", "--contains", b.sha, "--format=x", ...scopes])
    return contained.stdout.trim() ? "contained-elsewhere" : "only-copy"
  }
  return undefined
}

async function classifyRef(b: BranchRef, env: ClassifyEnv): Promise<BranchGcPlanEntry> {
  const tip = await classifyTip(env.ctx, b.sha)
  const ageDays = Math.floor((env.nowMs - new Date(b.date).getTime()) / 86_400_000)
  const entry: BranchGcPlanEntry = { ...b, ...tip, ageDays, class: "hold" }
  if (tip.status === "unmerged") {
    const pushed = await pushStateOf(b, env)
    if (pushed) entry.pushed = pushed
    const stored = env.verdicts ? await env.verdicts.get(env.repoName, b.sha) : null
    if (stored) {
      entry.verdict = { triage: stored.triage.verdict, agree: stored.gate ? stored.gate.agree : null, reviewer: stored.reviewer }
    }
  }
  const hold = holdFor(b, env)
  if (hold) {
    entry.holdReason = hold.holdReason
    if (hold.holdDetail) entry.holdDetail = hold.holdDetail
    return entry
  }
  if (tip.status !== "unmerged") {
    entry.class = "reclaim"
    entry.reclaimReason = tip.status
    return entry
  }
  if (ageDays < env.minAgeDays) {
    entry.holdReason = "young"
    entry.holdDetail = `${ageDays}d < ${env.minAgeDays}d`
    return entry
  }
  if (env.includeReviewed && entry.verdict?.agree === true) {
    entry.class = "reclaim"
    entry.reclaimReason = "reviewed"
    return entry
  }
  entry.class = "review"
  return entry
}

interface Snapshot {
  env: ClassifyEnv
  refs: BranchRef[]
  otherRemoteRefs: number
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
  nowMs: number
}): Promise<Snapshot> {
  const remotes = await configuredRemotes(input.repoRoot)
  const remote = baseRemoteOf(input.base, remotes)
  const [{ refs, otherRemoteRefs }, worktrees, prs] = await Promise.all([
    listBranchRefs(input.repoRoot, remote, remotes),
    worktreeBranches(input.repoRoot),
    openPrHeads(input.forge),
  ])
  const baseSha = (await gitOk(input.repoRoot, ["rev-parse", "--verify", `${input.base}^{commit}`])).trim()
  let anchor: string | null
  if (input.anchor === "auto") anchor = await detectAnchor(input.repoRoot, baseSha, refs.map((r) => r.sha))
  else if (input.anchor) anchor = (await gitOk(input.repoRoot, ["rev-parse", "--verify", `${input.anchor}^{commit}`])).trim()
  else anchor = null
  const ctx = await createLadderContext(input.repoRoot, baseSha, anchor)
  const remoteRefs = refs.filter((r) => r.kind === "remote")
  return {
    refs,
    otherRemoteRefs,
    env: {
      ctx,
      remote,
      baseName: remote && input.base.startsWith(`${remote}/`) ? input.base.slice(remote.length + 1) : input.base,
      worktrees,
      prs,
      remoteShas: new Set(remoteRefs.map((r) => r.sha)),
      remoteNames: new Set(remoteRefs.map((r) => r.name)),
      minAgeDays: input.minAgeDays,
      includeReviewed: input.includeReviewed,
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
  /** Explicit anchor for a re-rooted base. Omitted → auto-detected. */
  anchor?: string
  /** Open-PR detection (`listOpenPullRequests`). Omitted or unable → every local/remote ref is `hold` (`pr-check-unavailable`). */
  forge?: ForgeClient
  verdicts?: BranchVerdictStore
  /** Clock for `ageDays`. Default `Date.now()`. */
  nowMs?: number
  /** Parallel ladder runs. Default 8. */
  concurrency?: number
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
  const nowMs = input.nowMs ?? Date.now()
  const snap = await snapshot({
    repoRoot: input.repoRoot,
    repoName: input.repoName,
    base,
    anchor: input.anchor ?? "auto",
    ...(input.forge ? { forge: input.forge } : {}),
    ...(input.verdicts ? { verdicts: input.verdicts } : {}),
    minAgeDays,
    includeReviewed,
    nowMs,
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
    generatedAt: new Date(nowMs).toISOString(),
    otherRemoteRefs: snap.otherRemoteRefs,
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
}

export function summarizeBranchGcPlan(plan: BranchGcPlan): BranchGcSummary {
  const byClass = {} as BranchGcSummary["byClass"]
  const byStatus = {} as BranchGcSummary["byStatus"]
  for (const k of BRANCH_GC_SCOPES) {
    byClass[k] = { reclaim: 0, review: 0, hold: 0 }
    byStatus[k] = {}
  }
  for (const e of plan.entries) {
    byClass[e.kind][e.class]++
    const isProtected = e.holdReason === "protected" || e.holdReason === "worktree" || e.holdReason === "open-pr"
    const key = isProtected ? "protected" : e.status
    byStatus[e.kind][key] = (byStatus[e.kind][key] ?? 0) + 1
  }
  return { byClass, byStatus }
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
      refs: [e.ref],
      ...(e.verdict ? { verdict: e.verdict } : {}),
    })
  }
  return { base: plan.base, baseSha: plan.baseSha, anchor: plan.anchor, candidates: [...bySha.values()] }
}

// ── apply ────────────────────────────────────────────────────────────

export type BranchGcApplyOutcome =
  | { kind: BranchRefKind; name: string; sha: string; result: "deleted"; reclaimReason: BranchGcReclaimReason }
  | { kind: BranchRefKind; name: string; sha: string; result: "held"; holdReason?: BranchGcHoldReason }
  /** `review` class: never touched by apply — the review/approval path decides these. */
  | { kind: BranchRefKind; name: string; sha: string; result: "skipped-review" }
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

function restoreEntry(repoRoot: string, e: BranchGcPlanEntry): BranchGcRestoreEntry {
  const argv =
    e.kind === "local"
      ? ["branch", e.name, e.sha]
      : e.kind === "remote"
        ? ["push", e.remote as string, `${e.sha}:refs/heads/${e.name}`]
        : ["update-ref", e.ref, e.sha]
  return {
    kind: e.kind,
    name: e.name,
    ref: e.ref,
    sha: e.sha,
    ...(e.remote ? { remote: e.remote } : {}),
    argv,
    command: ["git", "-C", repoRoot, ...argv].map(shellQuote).join(" "),
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
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
    nowMs: options.nowMs ?? Date.now(),
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
      outcomes.push({ ...id, result: "skipped-review" })
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
    entries: confirmed.map((e) => restoreEntry(repoRoot, e)),
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
      const res = await git(repoRoot, ["push", remote, "--delete", ...batch.map((e) => e.name)])
      if (res.exitCode === 0) for (const e of batch) results.set(e.ref, { ok: true })
      else failedBatches.push({ batch, res })
    }
    // `push --delete` did not reliably drop the local tracking refs in practice.
    await git(repoRoot, ["fetch", "--prune", "--quiet", remote])
    // A non-atomic push deletes what it can and exits non-zero for the rest
    // (e.g. one branch already gone upstream): judge each ref by whether its
    // tracking ref survived the prune, not by the batch's exit code.
    // git can also refuse the whole batch client-side over one bad ref, so
    // anything still present is retried on its own before being reported.
    let retried = false
    for (const { batch } of failedBatches) {
      for (const e of batch) {
        if ((await git(repoRoot, ["rev-parse", "--verify", "--quiet", e.ref])).exitCode !== 0) {
          results.set(e.ref, { ok: true })
          continue
        }
        const one = await git(repoRoot, ["push", remote, "--delete", e.name])
        results.set(e.ref, one.exitCode === 0 ? { ok: true } : fail(one))
        retried = true
      }
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
    if (r?.ok) outcomes.push({ ...id, result: "deleted", reclaimReason: e.reclaimReason as BranchGcReclaimReason })
    else outcomes.push({ ...id, result: "failed", message: r && !r.ok ? r.message : "not attempted" })
  }
  return { outcomes, restoreLog: logPath }
}

/** Read a restore log written by `applyBranchGc`. */
export async function readBranchGcRestoreLog(path: string): Promise<BranchGcRestoreLog> {
  return JSON.parse(await readFile(path, "utf8")) as BranchGcRestoreLog
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
    name: z.string().min(1),
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
    reviewer: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.gate?.agree && v.gate.evidence.length === 0) {
      ctx.addIssue({ code: "custom", path: ["gate", "evidence"], message: "gate.agree=true requires at least one evidence entry" })
    }
  })

export type BranchVerdict = z.infer<typeof branchVerdictSchema>

export interface BranchVerdictRecord extends BranchVerdict {
  repo: string
  recordedAt: string
}

export interface BranchVerdictStore {
  /** The verdict for this exact tip, or `null`. A ref whose tip moved simply finds nothing. */
  get(repo: string, sha: string): Promise<BranchVerdictRecord | null>
  set(record: BranchVerdictRecord): Promise<void>
}

/** NUL-joined like the worktree verdict memo — cannot occur in a repo label or a sha. */
const verdictKey = (repo: string, sha: string): string => `${repo}\u0000${sha}`

export const BRANCH_VERDICTS_PATH = (): string => resolve(homedir(), ".agentproto", "branch-gc-verdicts.json")

const verdictRecordSchema = z.intersection(branchVerdictSchema, z.object({ repo: z.string(), recordedAt: z.string() }))
const verdictFileSchema = z.object({ entries: z.array(z.unknown()) })

/** `~/.agentproto/branch-gc-verdicts.json`, keyed by (repo, tip sha). */
export class FileBranchVerdictStore implements BranchVerdictStore {
  private cache: Map<string, BranchVerdictRecord> | null = null

  constructor(private readonly path: string = BRANCH_VERDICTS_PATH()) {}

  private async load(): Promise<Map<string, BranchVerdictRecord>> {
    if (this.cache) return this.cache
    const map = new Map<string, BranchVerdictRecord>()
    this.cache = map
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"))
    } catch {
      return map
    }
    const file = verdictFileSchema.safeParse(parsed)
    if (!file.success) return map
    for (const raw of file.data.entries) {
      const rec = verdictRecordSchema.safeParse(raw)
      if (rec.success) map.set(verdictKey(rec.data.repo, rec.data.sha), rec.data)
    }
    return map
  }

  async get(repo: string, sha: string): Promise<BranchVerdictRecord | null> {
    return (await this.load()).get(verdictKey(repo, sha)) ?? null
  }

  async set(record: BranchVerdictRecord): Promise<void> {
    const map = await this.load()
    map.set(verdictKey(record.repo, record.sha), record)
    await writeJsonAtomic(this.path, { entries: [...map.values()] })
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
 * gate with no evidence, and a sha that isn't a commit in this repo.
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
  const record: BranchVerdictRecord = {
    ...parsed.data,
    repo: input.repoName,
    recordedAt: (input.now ?? (() => new Date().toISOString()))(),
  }
  await input.store.set(record)
  return record
}
