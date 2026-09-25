/**
 * `gc` (PLAN.md §5, PR-D): plan → apply → salvage over the status engine's
 * classification (`status.ts`, PR-A). This module owns no new git knowledge
 * — it reuses `listGitWorktrees` / `computeWorktreeStatus` / `classify` for
 * every fact and `salvageWorktree` / `worktree.cleanup` (PR-C) for every
 * mutation. Its only original logic is sequencing the four safety layers
 * (PLAN.md §5.2):
 *
 *   1. `planGc` is pure read: it classifies every worktree and returns a
 *      plan. Nothing is mutated by calling it — the CLI's dry-run default
 *      *is* just "call planGc, print it, stop."
 *   2. `applyGc` re-derives each worktree's class from scratch immediately
 *      before touching it (a fresh `listGitWorktrees` + `computeWorktreeStatus`,
 *      not a reuse of the plan's stale snapshot) and refuses to act if the
 *      class changed since the plan was made.
 *   3. The actual removal is `worktree.cleanup` with NO discard flags for a
 *      reclaim-class entry — git's own non-`--force` refusal is the backstop
 *      this module leans on, never a force flag "just in case."
 *   4. A salvage-class entry is only ever touched via `salvageWorktree`
 *      followed by `worktree.cleanup` with both discard flags — snapshot
 *      first, removal only after the snapshot is durable (mirrors `worktree
 *      archive`'s CLI verb, PR-C).
 *
 * The main worktree (`repoRoot` itself) is never part of the plan: `git
 * worktree list`'s first entry is always the main checkout, and a repo
 * sitting on an up-to-date default branch is trivially `fresh ∧ clean` —
 * exactly what `reclaim` looks for. Git itself refuses to remove
 * the main working tree ("is a main working tree", verified empirically),
 * but this module doesn't lean on that as the only guard: the main worktree
 * is filtered out before classification even runs, so it can never appear
 * in a plan, let alone be attempted.
 *
 * One reclassification on top of `classify`'s three classes:
 * `resolveGcClass` promotes a clean, `unpushed` worktree from `hold` to
 * `reclaim` when every commit ahead of the default branch is a mechanical
 * dependency bump (subject AND cumulative diff both checked — see that
 * function's doc). It's applied identically at plan time and re-verified at
 * apply time (layer 2), so a worktree that grew a real commit in between is
 * still caught.
 */

import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises"
import { runTool } from "@agentproto/driver"
import { classifyTipAgainstBase } from "./branch-gc.js"
import { execArgv, execGit } from "./exec.js"
import { cleanupWorktreeTool } from "./tools/index.js"
import { worktreeProvider } from "./provider/index.js"
import { salvageWorktree } from "./salvage.js"
import type { ForgeClient } from "./forge.js"
import {
  classify,
  listGitWorktrees,
  computeWorktreeStatus,
  type GitWorktreeRef,
  type IntegrationState,
  type LivenessState,
  type TreeState,
  type VerdictMemoStore,
} from "./status.js"

const candidates = [worktreeProvider]

// ── classification (PLAN.md §5.1) ───────────────────────────────────────

export type GcClass = "reclaim" | "salvage" | "hold"

export interface ClassifyForGcOptions {
  /**
   * A clean, idle/daemon-unreachable DETACHED worktree moves from `hold` to
   * `reclaim` (PLAN.md §5.1). This is the only reclassification power any
   * flag has: every other hold reason — partial, open, unknown(offline),
   * gone-unexplained, diverged — is untouched by any flag, ever. Default
   * false.
   */
  includeDetached?: boolean
  /** Threaded straight through to `classify`'s `RECENT_WRITE_HOLD_WINDOW_MS` guard. Defaults to `Date.now()`. */
  nowMs?: number
}

/**
 * gc's own classifier, layered on top of `classify` (status.ts) rather than
 * reimplementing it — reuse first (AGENTS.md, PLAN.md §0.6). The one thing
 * `classify` cannot know is `--include-detached`, a gc-specific flag; that
 * override lives here, not in the read-only status engine `ls --status`
 * also depends on.
 */
export function classifyForGc(
  tree: TreeState,
  integration: IntegrationState,
  liveness: LivenessState,
  options: ClassifyForGcOptions = {},
): GcClass {
  if (options.includeDetached && integration.state === "detached") {
    const idleOrUnreachable = liveness.state === "idle" || liveness.state === "daemon-unreachable"
    if (tree.state === "clean" && idleOrUnreachable) return "reclaim"
  }
  return classify(tree, integration, liveness, options.nowMs).class
}

// ── dep-bump reclaim exemption ──────────────────────────────────────────
//
// A worktree whose only unpushed commits are a mechanical dependency bump
// (`chore(deps): weekly minor/patch bump`, re-run every week by every
// session that happens to pick it up) is not "unpushed work to protect" —
// it reproduces by re-running the routine, and 25 of these piling up as
// permanent `hold`s is exactly what emptied a 102GB external SSD of gc
// coverage. This is deliberately narrow and additive: it only ever promotes
// a worktree that `classifyForGc` already put in `hold` for the single
// reason `integration.state === "unpushed"` with a clean tree — every other
// hold reason (partial, open, diverged, gone-unexplained, unknown(offline),
// a dirty tree, `unpushed` while forge-unreachable — which can't happen, see
// `reconcileIntegration`) is completely untouched by this and still holds.

/**
 * The reclaim reasons this module can attach. `dep-bump` promotes a `hold`
 * to `reclaim` (see above). `orphan` and `prunable` are both different in
 * kind — neither ever starts from a `hold` verdict, because neither was
 * classified via `classify`'s three axes in the first place:
 *   - `orphan`: a directory physically present under the repo's worktree
 *     pool that `git worktree list` no longer knows about at all (see the
 *     "orphan reclaim" section below).
 *   - `prunable`: the mirror image — `git worktree list` still has a
 *     registration, but git itself already reports it `prunable` because
 *     the working directory is gone. Distinct from `orphan` on purpose: an
 *     orphan's directory is still there to lose (it just failed removal),
 *     so `reclaimOrphan` does `rm -rf`; a prunable entry's directory is
 *     already gone, so there's nothing to inspect and nothing to `rm` — the
 *     only irreversible thing history nearly did to it (deleting the branch)
 *     must not happen either. See "prunable reclaim" below.
 */
export type GcReclaimReason = "dep-bump" | "orphan" | "prunable" | InBaseReclaimReason

/**
 * `branch gc`'s proof tiers (`classifyTip`, branch-gc.ts) that promote a
 * clean, idle worktree out of `hold` when the forge can't: its branch's
 * CONTENT is provably in base even though no merged PR contains its tip (a
 * squash that went through another PR, a cherry-pick, a later reorg). See
 * "in-base promotion" below.
 */
export type InBaseReclaimReason = "squash-merged" | "patch-merged" | "content-merged"

// ── noise allowlist ─────────────────────────────────────────────────────
//
// Some dirt is not work: `.opencode/package-lock.json` churn shows up in
// almost every agent worktree. A worktree whose ONLY dirt is on this list
// reads `clean` to gc (`computeTreeState`'s `noisePaths`), so a merged one
// reclaims instead of sitting in `salvage` forever. Removal stays non-force:
// `reclaimOne` restores/deletes exactly the noise paths first, then plain
// `git worktree remove` — if anything else turned dirty in between, git still
// refuses.

/** gc's default noise allowlist — overridable per call via `noisePaths` (`[]` disables it). */
export const DEFAULT_GC_NOISE_PATHS: readonly string[] = [".opencode/package-lock.json"]

// ── live-session-cwd protection ─────────────────────────────────────────
//
// `classify`'s liveness axis (`computeLiveness`, status.ts) already holds a
// worktree that has a live session's cwd inside it — but only when that
// session shows up in the sessions snapshot `computeWorktreeStatus` was
// given. A caller with a stronger, more direct source of truth (the
// daemon's own in-memory session registry, read at the exact instant gc
// runs, rather than a possibly-stale/incomplete on-disk snapshot) can name
// those cwds explicitly via `protectedPaths` — a belt-and-suspenders check
// that wins unconditionally, independent of `classify`'s snapshot-based
// verdict and computed BEFORE it (so a protected worktree never pays the
// dep-bump exemption's extra git spawns either).

/** The hold reasons this module can attach, distinct from `classify`'s snapshot-based holds. */
export type GcHoldReason = "live-session-cwd"

/**
 * `true` iff `worktreePath` itself, or a subdirectory of it, is named by
 * `protectedPaths` — the same exact-or-subdirectory containment convention
 * as `sessionInWorktree` (provenance.ts), bounded by `sep` so a sibling like
 * `/a/bc` is never confused with `/a/b`. Plain string comparison, matching
 * `sessionInWorktree`'s own convention, rather than resolving symlinks —
 * callers that need realpath-stability should normalize before passing
 * `protectedPaths` in.
 */
function isProtectedPath(worktreePath: string, protectedPaths: readonly string[] | undefined): boolean {
  if (!protectedPaths || protectedPaths.length === 0) return false
  return protectedPaths.some((p) => p === worktreePath || p.startsWith(worktreePath + sep))
}

/**
 * Mechanical dep-bump commit subjects: `chore(deps)` / `fix(deps)`, with or
 * without a scope (`chore(deps-dev)`, `fix(deps-optional)`, …). A commit
 * message is cheap to type and easy to lie in — this regex alone NEVER
 * licenses anything; `isMechanicalDepBumpRange` below only trusts it in
 * conjunction with the actual cumulative diff.
 */
const DEP_BUMP_SUBJECT_RE = /^(?:chore|fix)\(deps[\w-]*\):\s/

function isDepBumpSubject(subject: string): boolean {
  return DEP_BUMP_SUBJECT_RE.test(subject)
}

/** The only paths a mechanical dep bump is allowed to touch, matched by basename so a nested package's `package.json` counts too. */
const DEP_BUMP_ALLOWED_BASENAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "package.json"])

function isDepBumpAllowedPath(path: string): boolean {
  return DEP_BUMP_ALLOWED_BASENAMES.has(basename(path))
}

/**
 * Layer 3+4 of the exemption: EVERY commit ahead of `baseRef` must have a
 * dep-bump subject (`git log --format=%s`, two-dot range — exactly the
 * commits `aheadBy` counts, PLAN-comment on `readUpstreamTrack`), AND the
 * cumulative diff of that whole range (`git diff`, three-dot/merge-base
 * range, so it isolates the branch's own changes from anything `baseRef`
 * did independently in the meantime) must touch nothing but lockfiles and
 * `package.json`. Both checks run unconditionally together — a subject that
 * lies is cheap, a diff cannot lie, so the diff is the one that actually
 * gates. Two extra git spawns, only ever paid for a worktree that would
 * otherwise be `hold` for exactly `clean ∧ unpushed` — every other class
 * pays nothing.
 */
export async function isMechanicalDepBumpRange(repoRoot: string, baseRef: string, tipSha: string): Promise<boolean> {
  const [subjectsRes, diffRes] = await Promise.all([
    execArgv("git", ["-C", repoRoot, "log", "--format=%s", `${baseRef}..${tipSha}`], repoRoot),
    execArgv("git", ["-C", repoRoot, "diff", "--name-only", `${baseRef}...${tipSha}`], repoRoot),
  ])
  if (subjectsRes.exitCode !== 0 || diffRes.exitCode !== 0) return false

  const subjects = subjectsRes.stdout.split("\n").filter((line) => line.length > 0)
  if (subjects.length === 0) return false
  if (!subjects.every(isDepBumpSubject)) return false

  const files = diffRes.stdout.split("\n").filter((line) => line.length > 0)
  if (files.length === 0) return false
  return files.every(isDepBumpAllowedPath)
}

export interface ResolveGcClassOptions extends ClassifyForGcOptions {
  repoRoot: string
  /**
   * Run `branch gc`'s content ladder for a clean, idle worktree still in
   * `hold` (see "in-base promotion"). Default true.
   */
  inBaseCheck?: boolean
  /** The tip commit of the worktree being classified — `worktree.head`. */
  tipSha: string
  /** Default `"origin/main"` — matches `reconcileIntegration`'s own default. */
  defaultBranchRef?: string
}

export interface ResolvedGcClass {
  class: GcClass
  /** Set only when `class === "reclaim"` via the dep-bump exemption rather than the ordinary merged/fresh path. */
  reclaimReason?: GcReclaimReason
}

/**
 * `classifyForGc` plus the one async, git-touching layer on top: a clean,
 * `unpushed` worktree whose entire ahead range is a mechanical dep bump is
 * promoted from `hold` to `reclaim`. Every other class classifyForGc
 * returns is passed through untouched — this never widens any other hold
 * reason, and never touches git for a worktree it wouldn't otherwise hold
 * on `unpushed` alone.
 */
export async function resolveGcClass(
  tree: TreeState,
  integration: IntegrationState,
  liveness: LivenessState,
  options: ResolveGcClassOptions,
): Promise<ResolvedGcClass> {
  const baseClass = classifyForGc(tree, integration, liveness, options)
  if (baseClass !== "hold") return { class: baseClass }
  if (tree.state !== "clean") return { class: "hold" }

  const baseRef = options.defaultBranchRef ?? "origin/main"
  if (integration.state === "unpushed" && (await isMechanicalDepBumpRange(options.repoRoot, baseRef, options.tipSha))) {
    return { class: "reclaim", reclaimReason: "dep-bump" }
  }
  if (options.inBaseCheck !== false) {
    const inBase = await provenInBase(integration, liveness, options.repoRoot, baseRef, options.tipSha)
    if (inBase) return { class: "reclaim", reclaimReason: inBase }
  }
  return { class: "hold" }
}

// ── in-base promotion ───────────────────────────────────────────────────
//
// `reconcileIntegration` only calls a branch `merged` when a merged PR's head
// contains its tip. Work that reached base any other way — squashed into a
// different PR, cherry-picked, moved by a later reorg — stays `diverged` /
// `local-only` / `pushed-no-pr` / … and holds forever. `branch gc`'s ladder
// proves those by content instead. Deliberately narrow:
//   - only a CLEAN tree (so nothing uncommitted can be lost; this never
//     licenses salvage — only a forge-confirmed `merged` does, see
//     `classify`'s 2026-07-15 note);
//   - only an idle/daemon-unreachable liveness (a live session still holds);
//   - never `open` (an open PR is always hold), never `unknown(offline)`
//     (can't rule out an open PR), never `detached` (no branch to reason
//     about).

const IN_BASE_PROMOTABLE: ReadonlySet<IntegrationState["state"]> = new Set([
  "partial",
  "diverged",
  "pushed-no-pr",
  "unpushed",
  "local-only",
  "gone-unexplained",
])

async function provenInBase(
  integration: IntegrationState,
  liveness: LivenessState,
  repoRoot: string,
  baseRef: string,
  tipSha: string,
): Promise<InBaseReclaimReason | null> {
  if (!IN_BASE_PROMOTABLE.has(integration.state)) return null
  if (liveness.state !== "idle" && liveness.state !== "daemon-unreachable") return null
  try {
    const tip = await classifyTipAgainstBase(repoRoot, baseRef, tipSha)
    if (tip.status === "squash-merged" || tip.status === "patch-merged" || tip.status === "content-merged") return tip.status
    return null
  } catch {
    // An unresolvable base or a git error proves nothing — keep holding.
    return null
  }
}

// ── plan ─────────────────────────────────────────────────────────────

export interface GcPlanEntry {
  path: string
  branch: string | null
  head: string
  /**
   * Absent for an orphan entry (`orphan: true`) or a prunable entry
   * (`prunable: true`) — git itself cannot answer the tree/integration/
   * liveness questions for a directory it no longer recognizes as a
   * worktree (orphan) or whose working directory is simply gone (prunable),
   * so this module never fabricates a value for them rather than reporting
   * a fact it can't actually check.
   */
  tree?: TreeState
  integration?: IntegrationState
  liveness?: LivenessState
  /** Classification per PLAN.md §5.1, after `--include-detached` (if set). */
  class: GcClass
  /** Set only when `class === "reclaim"` via the dep-bump exemption, the orphan reclaim path, or the prunable reclaim path — see `resolveGcClass` / `scanOrphanWorktreePaths` / `toPlanEntry`. */
  reclaimReason?: GcReclaimReason
  /** Set only when `class === "hold"` via `protectedPaths` (`isProtectedPath`) — distinguishes this from an ordinary snapshot-based hold. */
  holdReason?: GcHoldReason
  /**
   * `true` only for a directory the orphan scan found: physically present
   * under the repo's worktree pool, but absent from `git worktree list`
   * (even after `git worktree prune`) — the interrupted-`worktree remove`
   * shape (module docblock's §5 note). Always paired with `class: "reclaim"`
   * and `reclaimReason: "orphan"`. Never set for a linked worktree, however
   * it classifies.
   */
  orphan?: boolean
  /**
   * `true` only for a linked worktree `git worktree list --porcelain` itself
   * already marked `prunable` — its working directory is gone, so none of
   * `classify`'s three axes were computed (no git command was ever run
   * against the dead path). Always paired with `class: "reclaim"` and
   * `reclaimReason: "prunable"` — see "prunable reclaim" below `toPlanEntry`.
   */
  prunable?: boolean
}

export interface PlanGcInput {
  repoRoot: string
  repoName: string
  forge: ForgeClient
  memo: VerdictMemoStore
  defaultBranchRef?: string
  sessionsPath?: string
  includeDetached?: boolean
  now?: () => string
  /** See `ComputeWorktreeStatusInput.nowMs` (status.ts) — kept separate from `now`. Defaults to `Date.now()`. */
  nowMs?: number
  /**
   * The bucket directory this repo's worktrees are provisioned under — e.g.
   * `<worktrees.root>/<repoLabel>` (see `resolveWorktreesRoot` / `repoLabel`,
   * both resolved by the caller; this module does no root resolution of its
   * own, see the orphan-reclaim section below). When omitted, orphan
   * scanning is skipped entirely and `planGc`/`applyGc` behave exactly as
   * before — every existing caller that doesn't pass this sees zero change.
   */
  worktreesRoot?: string
  /**
   * Absolute paths (typically live session cwds) that must never be
   * classified `reclaim`/`salvage`, exact-or-subdirectory (`isProtectedPath`)
   * — see the "live-session-cwd protection" section above. Applies to both
   * linked worktrees and orphan-scan entries. Omitted ⇒ no additional
   * protection beyond `classify`'s own snapshot-based liveness axis.
   */
  protectedPaths?: string[]
  /** Noise allowlist (see "noise allowlist" above). Default `DEFAULT_GC_NOISE_PATHS`; `[]` disables it. */
  noisePaths?: readonly string[]
}

/** Every linked worktree of `repoRoot` except the main checkout itself — see the module docblock. */
async function linkedWorktreesOf(repoRoot: string): Promise<GitWorktreeRef[]> {
  const worktrees = await listGitWorktrees(repoRoot)
  return worktrees.filter((w) => w.path !== repoRoot)
}

// ── orphan reclaim ───────────────────────────────────────────────────────
//
// `linkedWorktreesOf` (and therefore every axis `classify` depends on) can
// only ever see what `git worktree list` reports — which is exactly the
// blind spot behind the 8GB/day leak this section exists for. A worktree
// removal interrupted mid-delete leaves the directory on disk but erases
// `<repoRoot>/.git/worktrees/<name>`, so git no longer has ANY record of it:
// `git worktree list` doesn't show it, `git status` inside it fails outright
// ("not a working tree"), and it is therefore invisible to gc forever,
// through no fault of the classify/reclaim/salvage engine above — that
// engine is working exactly as designed on the set of worktrees git still
// knows about.
//
// This section is deliberately narrow and conservative, matching the case
// its ownership check can actually prove:
//   1. A directory only ever counts as an orphan of THIS repo if its own
//      `.git` file's `gitdir:` pointer resolves inside `<repoRoot>`'s own
//      `.git/worktrees/` — `belongsToRepo` below. An unrelated directory
//      that happens to sit in the same pool (no `.git` pointer, or one that
//      points somewhere else entirely) is never touched, full stop.
//   2. `git worktree prune` runs first — cheap and safe — so a directory
//      that's merely mid-registration (not actually orphaned) resolves
//      itself before the scan concludes anything.
//   3. Once `git worktree list` still doesn't know about it after a prune,
//      there is nothing left that could "reclassify" it the way a linked
//      worktree can flip branches mid-session (`applyOne`'s layer 2): its
//      git identity is already gone, so nothing can merge it, push it, or
//      lose reachable history by removing it. The only thing at risk is
//      uncommitted working-tree state, and by definition git has already
//      lost the ability to act on that state through any of its own verbs —
//      the directory is no longer a working tree by git's own definition.
// Because of (3), an orphan is unconditionally `reclaim` — there is no
// `hold`/`salvage` axis to compute for it, and manufacturing one would be
// reporting a fact this module cannot actually check (see `GcPlanEntry`'s
// `tree`/`integration`/`liveness` doc).

/**
 * Absolute path to this repo's own `.git/worktrees` directory — every
 * linked worktree's `.git` file points at a child of this. Resolved via
 * `git rev-parse --git-common-dir` rather than assuming `<repoRoot>/.git`
 * literally, so a bare/alternate git layout is still handled correctly.
 */
async function gitWorktreesDir(repoRoot: string): Promise<string> {
  const res = await execArgv("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], repoRoot)
  if (res.exitCode !== 0) {
    throw new Error(
      `git rev-parse --git-common-dir failed in ${repoRoot} (exit ${res.exitCode}): ${res.stderr.trim()}`,
    )
  }
  return join(resolve(repoRoot, res.stdout.trim()), "worktrees")
}

/**
 * Reads a worktree directory's `.git` file (`gitdir: <path>`) and resolves
 * the target to an absolute path. `null` when the file is absent, unreadable,
 * or doesn't match the `gitdir:` pointer shape every linked worktree's `.git`
 * has (a plain directory with no `.git` at all is exactly the shape an
 * unrelated, not-ours directory has — see `belongsToRepo`).
 */
async function readGitdirPointer(worktreePath: string): Promise<string | null> {
  let raw: string
  try {
    raw = await readFile(join(worktreePath, ".git"), "utf8")
  } catch {
    return null
  }
  const match = raw.match(/^gitdir:\s*(.+?)\s*$/m)
  const target = match?.[1]
  if (!target) return null
  return resolve(worktreePath, target)
}

/**
 * `true` only when `worktreePath`'s `.git` pointer resolves inside
 * `repoRoot`'s own `.git/worktrees/` — the one signal the orphan scan trusts
 * before ever touching a directory. This is deliberately a string-prefix
 * check, not an existence check: for a genuine orphan, the specific
 * `.git/worktrees/<name>` subdirectory the pointer names is exactly what's
 * gone (that's the orphan condition), so requiring it to still exist would
 * make this check unable to ever confirm the one case it exists for.
 */
async function belongsToRepo(repoRoot: string, worktreePath: string): Promise<boolean> {
  const pointer = await readGitdirPointer(worktreePath)
  if (!pointer) return false
  let worktreesDir: string
  try {
    worktreesDir = await gitWorktreesDir(repoRoot)
  } catch {
    return false
  }
  const rel = relative(worktreesDir, pointer)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves symlinks (`realpath`) so a path git reports and the same path
 * built by hand from a config-supplied root compare equal even when some
 * component along the way is a symlink (e.g. macOS's `/tmp` →
 * `/private/tmp`, or a temp-dir-backed test fixture) — falls back to plain
 * `resolve` for a path that doesn't exist (yet) rather than throwing.
 */
async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Discovery (plan time): every directory physically present under
 * `worktreesRoot` that both (a) `git worktree list` doesn't know about, even
 * after a `worktree prune`, and (b) genuinely belongs to `repoRoot` per
 * `belongsToRepo`. A `worktreesRoot` that doesn't exist yet (nothing has
 * ever been provisioned there) yields no orphans, not an error.
 */
async function scanOrphanWorktreePaths(repoRoot: string, worktreesRoot: string): Promise<string[]> {
  await execArgv("git", ["-C", repoRoot, "worktree", "prune"], repoRoot).catch(() => null)
  const linkedRefs = await linkedWorktreesOf(repoRoot)
  const linked = new Set(await Promise.all(linkedRefs.map((w) => realOrResolved(w.path))))
  const entries = await readdir(worktreesRoot, { withFileTypes: true }).catch(() => [])
  const orphans: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = resolve(worktreesRoot, entry.name)
    if (linked.has(await realOrResolved(candidate))) continue
    if (await belongsToRepo(repoRoot, candidate)) orphans.push(candidate)
  }
  return orphans
}

function makeOrphanPlanEntry(path: string, protectedPaths: readonly string[] | undefined): GcPlanEntry {
  if (isProtectedPath(path, protectedPaths)) {
    return { path, branch: null, head: "", class: "hold", holdReason: "live-session-cwd" }
  }
  return { path, branch: null, head: "", class: "reclaim", reclaimReason: "orphan", orphan: true }
}

/**
 * Apply-time re-check (layer 2, mirrored from `applyOne`'s TOCTOU guard for
 * linked worktrees): re-derive from scratch, immediately before touching
 * anything, rather than trusting the plan's stale snapshot.
 *   - `"gone"`: the directory no longer exists at all — a prior/concurrent
 *     gc pass (or the plan itself racing a manual `rm`) already finished the
 *     job. Reclaiming this is a no-op success, not a failure.
 *   - `"confirmed"`: still on disk, still un-linked after a fresh prune,
 *     `.git` pointer still resolves back to this repo — safe to remove.
 *   - `"not-orphan"`: something changed since the plan was made (most
 *     plausibly: it got re-registered, or the ownership check no longer
 *     passes) — refuse, exactly like `applyOne`'s `aborted-reclassified`.
 */
async function verifyOrphan(repoRoot: string, worktreePath: string): Promise<"gone" | "confirmed" | "not-orphan"> {
  if (!(await pathExists(worktreePath))) return "gone"
  await execArgv("git", ["-C", repoRoot, "worktree", "prune"], repoRoot).catch(() => null)
  const linked = await linkedWorktreesOf(repoRoot)
  const realWorktreePath = await realOrResolved(worktreePath)
  for (const w of linked) {
    if ((await realOrResolved(w.path)) === realWorktreePath) return "not-orphan"
  }
  return (await belongsToRepo(repoRoot, worktreePath)) ? "confirmed" : "not-orphan"
}

/**
 * Reclaim one orphan entry. No `worktree.cleanup` tool here — that tool
 * shells out to `git worktree remove`, which by definition refuses (or
 * simply doesn't know what to do with) a directory git has no record of;
 * plain recursive removal is the correct, and only, verb for something git
 * itself no longer considers a working tree. `{ recursive: true, force:
 * true }` is what makes this idempotent: a directory that's already gone,
 * or partially gone (the same half-deleted shape the orphan condition
 * itself comes from), is removed without error either way.
 */
async function reclaimOrphan(entry: GcPlanEntry, options: ApplyGcOptions): Promise<GcApplyOutcome> {
  const state = await verifyOrphan(options.repoRoot, entry.path)
  if (state === "not-orphan") {
    return { path: entry.path, branch: null, result: "aborted-reclassified", from: "reclaim", to: "hold" }
  }
  if (state === "confirmed") {
    try {
      await rm(entry.path, { recursive: true, force: true })
    } catch (err) {
      return {
        path: entry.path,
        branch: null,
        result: "failed",
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }
  // state === "gone": already removed — idempotent success, nothing to do.
  return { path: entry.path, branch: null, result: "reclaimed", reclaimReason: "orphan" }
}

// ── prunable reclaim: a registration git already knows is dead ─────────────
//
// `git worktree list --porcelain` itself emits a `prunable <reason>` line
// when a linked worktree's working directory is gone but its `.git/
// worktrees/<name>` registration is still intact (the mirror image of the
// orphan case above, where the registration is gone but the directory
// isn't). Before this section, `linkedWorktreesOf` still handed this entry
// to `computeWorktreeStatus`, which spawns `git status --porcelain=v2 -C
// <dead path>` and throws — a throw that escaped `planGc`'s loop entirely
// and took the whole plan down with it, for every worktree in the repo, not
// just the dead one.
//
// Classification here never runs a single git command against the dead
// path: git's own `prunable` line is trusted as-is (`GitWorktreeRef.prunable`,
// status.ts), never re-derived with `existsSync` or any filesystem check of
// our own. Reclaiming it is `git worktree prune` alone — no
// `cleanupWorktreeTool`/`git worktree remove` (which needs a working
// directory to operate on and would refuse or misbehave against one that's
// already gone), and critically no branch deletion: there is nothing left to
// inspect to decide a branch is safe to delete, so this path must never
// reach `reclaimOne`'s `deleteBranch: true`.

function makePrunablePlanEntry(worktree: GitWorktreeRef, protectedPaths: readonly string[] | undefined): GcPlanEntry {
  if (isProtectedPath(worktree.path, protectedPaths)) {
    return { path: worktree.path, branch: worktree.branch, head: worktree.head, class: "hold", holdReason: "live-session-cwd" }
  }
  return {
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    class: "reclaim",
    reclaimReason: "prunable",
    prunable: true,
  }
}

/**
 * Apply-time re-check (layer 2, mirrored from `verifyOrphan`): re-list from
 * scratch immediately before touching anything, rather than trusting the
 * plan's stale snapshot.
 *   - entry no longer listed at all: a prior/concurrent `gc` (or a plain
 *     `git worktree prune` run by something else) already finished the job —
 *     reclaiming this is a no-op success, not a failure.
 *   - still listed, still `prunable`: safe to prune.
 *   - still listed, no longer `prunable`: something changed since the plan
 *     was made (most plausibly: a new worktree got registered at the exact
 *     same path) — refuse, exactly like `applyOne`'s `aborted-reclassified`.
 */
async function reclaimPrunable(entry: GcPlanEntry, options: ApplyGcOptions): Promise<GcApplyOutcome> {
  const fresh = await listGitWorktrees(options.repoRoot)
  const stillThere = fresh.find((w) => w.path === entry.path)
  if (stillThere && !stillThere.prunable) {
    return { path: entry.path, branch: stillThere.branch, result: "aborted-reclassified", from: "reclaim", to: "hold" }
  }
  if (stillThere) {
    try {
      await execGit(options.repoRoot, ["worktree", "prune"])
    } catch (err) {
      return {
        path: entry.path,
        branch: entry.branch,
        result: "failed",
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }
  // Either just pruned above, or already gone by the time we re-listed —
  // either way, the registration is now clear and the branch is untouched.
  return { path: entry.path, branch: entry.branch, result: "reclaimed", reclaimReason: "prunable" }
}

async function toPlanEntry(
  repoRoot: string,
  defaultBranchRef: string | undefined,
  worktree: GitWorktreeRef,
  status: { tree: TreeState; integration: IntegrationState; liveness: LivenessState },
  includeDetached: boolean,
  nowMs: number,
  protectedPaths?: readonly string[],
): Promise<GcPlanEntry> {
  if (isProtectedPath(worktree.path, protectedPaths)) {
    return {
      path: worktree.path,
      branch: worktree.branch,
      head: worktree.head,
      tree: status.tree,
      integration: status.integration,
      liveness: status.liveness,
      class: "hold",
      holdReason: "live-session-cwd",
    }
  }
  const resolved = await resolveGcClass(status.tree, status.integration, status.liveness, {
    repoRoot,
    tipSha: worktree.head,
    defaultBranchRef,
    includeDetached,
    nowMs,
  })
  return {
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    tree: status.tree,
    integration: status.integration,
    liveness: status.liveness,
    class: resolved.class,
    ...(resolved.reclaimReason ? { reclaimReason: resolved.reclaimReason } : {}),
  }
}

/**
 * The dry-run plan (PLAN.md §5.2 layer 1): classify every linked worktree,
 * mutate nothing. This is the human's decision surface — `gc` with no flags
 * is exactly "call this, print it, stop."
 */
export async function planGc(input: PlanGcInput): Promise<GcPlanEntry[]> {
  const includeDetached = Boolean(input.includeDetached)
  // One frozen instant for the whole plan's recent-write checks.
  const nowMs = input.nowMs ?? Date.now()
  const worktrees = await linkedWorktreesOf(input.repoRoot)
  const entries: GcPlanEntry[] = []
  for (const worktree of worktrees) {
    // git already told us this one is dead — classify it from that signal
    // alone, without spawning a single git command against its (nonexistent)
    // path. See the "prunable reclaim" section above `toPlanEntry`.
    if (worktree.prunable) {
      entries.push(makePrunablePlanEntry(worktree, input.protectedPaths))
      continue
    }
    const status = await computeWorktreeStatus({
      repoRoot: input.repoRoot,
      repoName: input.repoName,
      worktree,
      forge: input.forge,
      memo: input.memo,
      defaultBranchRef: input.defaultBranchRef,
      sessionsPath: input.sessionsPath,
      now: input.now,
      noisePaths: input.noisePaths ?? DEFAULT_GC_NOISE_PATHS,
    })
    entries.push(
      await toPlanEntry(
        input.repoRoot,
        input.defaultBranchRef,
        worktree,
        status,
        includeDetached,
        nowMs,
        input.protectedPaths,
      ),
    )
  }
  if (input.worktreesRoot) {
    const orphanPaths = await scanOrphanWorktreePaths(input.repoRoot, input.worktreesRoot)
    for (const path of orphanPaths) entries.push(makeOrphanPlanEntry(path, input.protectedPaths))
  }
  return entries
}

// ── apply ────────────────────────────────────────────────────────────

export interface ApplyGcOptions {
  repoRoot: string
  repoName: string
  forge: ForgeClient
  memo: VerdictMemoStore
  defaultBranchRef?: string
  sessionsPath?: string
  includeDetached?: boolean
  /** Archive (salvage-then-remove) every salvage-class entry. Default false — salvage entries are left untouched. */
  salvageDirty?: boolean
  now?: () => string
  /** See `ComputeWorktreeStatusInput.nowMs` (status.ts) — kept separate from `now`. Defaults to `Date.now()`. */
  nowMs?: number
  /** Override for `~/.agentproto/worktree-salvage` — tests use a temp dir. */
  salvageRoot?: string
  /** See `PlanGcInput.protectedPaths` — re-checked here at apply time (layer 2), independent of what the plan entry says, so a stale plan can never remove a now-protected path. */
  protectedPaths?: string[]
  /** See `PlanGcInput.noisePaths`. */
  noisePaths?: readonly string[]
}

export type GcApplyOutcome =
  | { path: string; branch: string | null; result: "reclaimed"; reclaimReason?: GcReclaimReason }
  | { path: string; branch: string | null; result: "salvaged"; salvageDir: string }
  | { path: string; branch: string | null; result: "held"; holdReason?: GcHoldReason }
  /** Salvage-class, but `--salvage-dirty` was not passed: left untouched by design. */
  | { path: string; branch: string | null; result: "skipped-dirty" }
  /** Layer 2: re-classified at apply time to something other than the plan said — refuses rather than acting on a stale plan. */
  | { path: string; branch: string | null; result: "aborted-reclassified"; from: GcClass; to: GcClass; holdReason?: GcHoldReason }
  /** The worktree named in the plan no longer exists (already removed by something else since the plan was made). */
  | { path: string; branch: string | null; result: "aborted-vanished" }
  /** git itself (or the salvage snapshot) refused — the TOCTOU backstop actually firing, or a real I/O failure. */
  | { path: string; branch: string | null; result: "failed"; message: string }

async function findWorktree(repoRoot: string, path: string): Promise<GitWorktreeRef | null> {
  const worktrees = await linkedWorktreesOf(repoRoot)
  return worktrees.find((w) => w.path === path) ?? null
}

/**
 * Put every noise path back the way git's non-force removal needs it: a
 * tracked one restored to HEAD (index and working tree), an untracked one
 * deleted. Only ever the exact paths the fresh re-check reported as noise.
 */
async function discardNoise(repoRoot: string, worktreePath: string, noise: readonly string[]): Promise<void> {
  for (const path of noise) {
    const tracked = await execArgv("git", ["-C", worktreePath, "ls-files", "--error-unmatch", "--", path], repoRoot)
    if (tracked.exitCode === 0) {
      await execGit(repoRoot, ["-C", worktreePath, "checkout", "HEAD", "--", path])
    } else {
      await rm(join(worktreePath, path), { force: true })
    }
  }
}

async function reclaimOne(
  options: ApplyGcOptions,
  worktree: GitWorktreeRef,
  reclaimReason?: GcReclaimReason,
  tree?: TreeState,
): Promise<GcApplyOutcome> {
  try {
    if (tree?.state === "clean" && tree.noise?.length) await discardNoise(options.repoRoot, worktree.path, tree.noise)
    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: {
        repoRoot: options.repoRoot,
        cwd: worktree.path,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        // Branch deletion only ever runs for a `reclaim`-class entry, which by
        // construction requires `integration ∈ {merged(*), fresh}` and
        // `tree = clean` (PLAN.md's invariant: branch -D only when there's
        // nothing uncommitted to lose, never a hold class).
        deleteBranch: true,
        // No discardUntracked/discardModified, ever, on this path (PLAN.md
        // §5.2 layer 3): `reclaim` means `tree = clean`, so plain `git
        // worktree remove` should succeed on its own; if the tree turned
        // dirty in the instant between the re-check above and this call, git
        // itself refuses and that refusal surfaces below as `failed` — never
        // a force flag "just in case."
      },
    })
  } catch (err) {
    return {
      path: worktree.path,
      branch: worktree.branch,
      result: "failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  return {
    path: worktree.path,
    branch: worktree.branch,
    result: "reclaimed",
    ...(reclaimReason ? { reclaimReason } : {}),
  }
}

async function salvageOne(options: ApplyGcOptions, worktree: GitWorktreeRef): Promise<GcApplyOutcome> {
  let salvageDir: string
  try {
    const result = await salvageWorktree({
      repoRoot: options.repoRoot,
      repoName: options.repoName,
      worktreePath: worktree.path,
      branch: worktree.branch,
      tipSha: worktree.head,
      slug: worktree.branch ?? basename(worktree.path),
      sessionsPath: options.sessionsPath,
      now: options.now,
      salvageRoot: options.salvageRoot,
    })
    salvageDir = result.dir
  } catch (err) {
    return {
      path: worktree.path,
      branch: worktree.branch,
      result: "failed",
      message: `salvage failed, nothing removed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  try {
    await runTool({
      tool: cleanupWorktreeTool,
      candidates,
      input: {
        repoRoot: options.repoRoot,
        cwd: worktree.path,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        deleteBranch: true,
        // Both discard flags: the snapshot above is already durable (fsynced)
        // before this call, so nothing on disk is lost by discarding it here
        // (PLAN.md §5.2 layer 4 — salvage before discard).
        discardUntracked: true,
        discardModified: true,
      },
    })
  } catch (err) {
    return {
      path: worktree.path,
      branch: worktree.branch,
      result: "failed",
      message: `salvaged to ${salvageDir}, but removal failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return { path: worktree.path, branch: worktree.branch, result: "salvaged", salvageDir }
}

async function applyOne(entry: GcPlanEntry, options: ApplyGcOptions): Promise<GcApplyOutcome> {
  // Layer 2's own layer 2: re-checked first, ahead of every other branch
  // below (orphan or linked, whatever the plan's stale `class` says) — a
  // path named in `options.protectedPaths` is NEVER touched, even when the
  // plan itself was built before the path became protected (e.g. a session
  // started using this cwd after the plan was made but before apply ran).
  if (isProtectedPath(entry.path, options.protectedPaths)) {
    if (entry.class === "hold") {
      return { path: entry.path, branch: entry.branch, result: "held", holdReason: "live-session-cwd" }
    }
    return {
      path: entry.path,
      branch: entry.branch,
      result: "aborted-reclassified",
      from: entry.class,
      to: "hold",
      holdReason: "live-session-cwd",
    }
  }
  // Orphan entries never go through `findWorktree`/`computeWorktreeStatus`
  // below — those assume `git worktree list` still knows about the entry,
  // which is exactly what an orphan means it doesn't. See "orphan reclaim"
  // above `reclaimOrphan` for its own from-scratch TOCTOU re-check.
  if (entry.orphan) {
    return reclaimOrphan(entry, options)
  }
  // Prunable entries never go through `computeWorktreeStatus` below either —
  // that would spawn `git status` against a working directory that's gone,
  // the exact throw this whole path exists to avoid. See "prunable reclaim"
  // above `reclaimPrunable` for its own from-scratch TOCTOU re-check.
  if (entry.prunable) {
    return reclaimPrunable(entry, options)
  }
  if (entry.class === "hold") {
    return { path: entry.path, branch: entry.branch, result: "held" }
  }
  if (entry.class === "salvage" && !options.salvageDirty) {
    return { path: entry.path, branch: entry.branch, result: "skipped-dirty" }
  }

  // Layer 2 (PLAN.md §5.2): re-check immediately before touching anything.
  // Re-derive the worktree ref itself, not just its status — a branch can
  // flip between plan and apply (the rendezvous-deploy branch-flip mid-
  // session is the plan's own existence proof for this), so re-listing
  // `git worktree list` is required, not just recomputing against the
  // plan's stale (path, branch, head) tuple.
  const fresh = await findWorktree(options.repoRoot, entry.path)
  if (!fresh) {
    return { path: entry.path, branch: entry.branch, result: "aborted-vanished" }
  }
  const status = await computeWorktreeStatus({
    repoRoot: options.repoRoot,
    repoName: options.repoName,
    worktree: fresh,
    forge: options.forge,
    memo: options.memo,
    defaultBranchRef: options.defaultBranchRef,
    sessionsPath: options.sessionsPath,
    now: options.now,
    noisePaths: options.noisePaths ?? DEFAULT_GC_NOISE_PATHS,
  })
  // Re-resolved from scratch — including the dep-bump exemption, not just
  // `entry`'s stale plan-time verdict, so a worktree that picked up a real
  // (non-bump) commit between plan and apply is re-caught here, not just at
  // plan time.
  const resolved = await resolveGcClass(status.tree, status.integration, status.liveness, {
    repoRoot: options.repoRoot,
    tipSha: fresh.head,
    defaultBranchRef: options.defaultBranchRef,
    includeDetached: Boolean(options.includeDetached),
    nowMs: options.nowMs,
  })
  if (resolved.class !== entry.class) {
    return {
      path: entry.path,
      branch: fresh.branch,
      result: "aborted-reclassified",
      from: entry.class,
      to: resolved.class,
    }
  }

  if (resolved.class === "reclaim") return reclaimOne(options, fresh, resolved.reclaimReason, status.tree)
  // The only other class that reaches this point is "salvage" with
  // `options.salvageDirty` true (both earlier guards above already returned
  // for "hold" and for "salvage" without the flag).
  return salvageOne(options, fresh)
}

/**
 * Execute a plan (PLAN.md §5.2 layers 2–4). Every entry is re-classified
 * from scratch immediately before it's touched; a `hold` entry is never
 * touched, a `salvage` entry is only touched when `salvageDirty` is true,
 * and every removal goes through `worktree.cleanup` — never a hand-rolled
 * `git worktree remove`.
 */
export async function applyGc(plan: readonly GcPlanEntry[], options: ApplyGcOptions): Promise<GcApplyOutcome[]> {
  const outcomes: GcApplyOutcome[] = []
  for (const entry of plan) {
    outcomes.push(await applyOne(entry, options))
  }
  return outcomes
}

// ── single-worktree reclaim (session exit-time auto-reclaim) ───────────────
//
// A policy-provisioned (implicit) worktree — one `decideWorktreeIsolation`'s
// `"always"` branch minted for a caller who never asked to keep it (see that
// module's `WorktreeDecision.provision.implicit`) — is a candidate for
// reclaim the moment its own session exits, rather than sitting until the
// next manual/scheduled `gc` sweep. This is deliberately scoped to ONE
// worktree — a session's own exit must never sweep or touch any OTHER
// worktree in the pool — and deliberately reuses `applyGc`'s existing
// classify → re-verify → remove pipeline (a plan of size one) rather than
// hand-rolling a second removal path with its own safety logic to keep in
// sync.

/**
 * Attempt to reclaim exactly one worktree by path — the exit-time auto-
 * reclaim primitive `sessions.ts` calls (via the injected
 * `WorktreeAutoReclaimer` port) when a policy-provisioned session reaches a
 * terminal state. Classifies it fresh (never trusts a caller-supplied
 * verdict) and only ever removes it when that classification is `reclaim`
 * (merged-or-fresh, clean, idle) — a dirty or held worktree is returned
 * as-is, exactly like any other `gc` outcome, still visible via
 * `worktree_status` and still manually reclaimable. Returns `null` when the
 * path no longer names a linked worktree at all (already removed by
 * something else — nothing to do, not an error).
 */
export async function reclaimOneWorktree(
  worktreePath: string,
  options: ApplyGcOptions & { includeDetached?: boolean },
): Promise<GcApplyOutcome | null> {
  const worktree = await findWorktree(options.repoRoot, worktreePath)
  if (!worktree) return null
  if (worktree.prunable) {
    return applyOne(makePrunablePlanEntry(worktree, options.protectedPaths), options)
  }
  const status = await computeWorktreeStatus({
    repoRoot: options.repoRoot,
    repoName: options.repoName,
    worktree,
    forge: options.forge,
    memo: options.memo,
    defaultBranchRef: options.defaultBranchRef,
    sessionsPath: options.sessionsPath,
    now: options.now,
    noisePaths: options.noisePaths ?? DEFAULT_GC_NOISE_PATHS,
  })
  const entry = await toPlanEntry(
    options.repoRoot,
    options.defaultBranchRef,
    worktree,
    status,
    Boolean(options.includeDetached),
    options.nowMs ?? Date.now(),
    options.protectedPaths,
  )
  return applyOne(entry, options)
}
