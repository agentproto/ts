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

import { basename } from "node:path"
import { runTool } from "@agentproto/driver"
import { execArgv } from "./exec.js"
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

/** The only reclaim reason this module can attach today. */
export type GcReclaimReason = "dep-bump"

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
  if (tree.state !== "clean" || integration.state !== "unpushed") return { class: "hold" }

  const baseRef = options.defaultBranchRef ?? "origin/main"
  const isDepBump = await isMechanicalDepBumpRange(options.repoRoot, baseRef, options.tipSha)
  if (!isDepBump) return { class: "hold" }
  return { class: "reclaim", reclaimReason: "dep-bump" }
}

// ── plan ─────────────────────────────────────────────────────────────

export interface GcPlanEntry {
  path: string
  branch: string | null
  head: string
  tree: TreeState
  integration: IntegrationState
  liveness: LivenessState
  /** Classification per PLAN.md §5.1, after `--include-detached` (if set). */
  class: GcClass
  /** Set only when `class === "reclaim"` via the dep-bump exemption — see `resolveGcClass`. */
  reclaimReason?: GcReclaimReason
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
}

/** Every linked worktree of `repoRoot` except the main checkout itself — see the module docblock. */
async function linkedWorktreesOf(repoRoot: string): Promise<GitWorktreeRef[]> {
  const worktrees = await listGitWorktrees(repoRoot)
  return worktrees.filter((w) => w.path !== repoRoot)
}

async function toPlanEntry(
  repoRoot: string,
  defaultBranchRef: string | undefined,
  worktree: GitWorktreeRef,
  status: { tree: TreeState; integration: IntegrationState; liveness: LivenessState },
  includeDetached: boolean,
  nowMs: number,
): Promise<GcPlanEntry> {
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
    const status = await computeWorktreeStatus({
      repoRoot: input.repoRoot,
      repoName: input.repoName,
      worktree,
      forge: input.forge,
      memo: input.memo,
      defaultBranchRef: input.defaultBranchRef,
      sessionsPath: input.sessionsPath,
      now: input.now,
    })
    entries.push(await toPlanEntry(input.repoRoot, input.defaultBranchRef, worktree, status, includeDetached, nowMs))
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
}

export type GcApplyOutcome =
  | { path: string; branch: string | null; result: "reclaimed"; reclaimReason?: GcReclaimReason }
  | { path: string; branch: string | null; result: "salvaged"; salvageDir: string }
  | { path: string; branch: string | null; result: "held" }
  /** Salvage-class, but `--salvage-dirty` was not passed: left untouched by design. */
  | { path: string; branch: string | null; result: "skipped-dirty" }
  /** Layer 2: re-classified at apply time to something other than the plan said — refuses rather than acting on a stale plan. */
  | { path: string; branch: string | null; result: "aborted-reclassified"; from: GcClass; to: GcClass }
  /** The worktree named in the plan no longer exists (already removed by something else since the plan was made). */
  | { path: string; branch: string | null; result: "aborted-vanished" }
  /** git itself (or the salvage snapshot) refused — the TOCTOU backstop actually firing, or a real I/O failure. */
  | { path: string; branch: string | null; result: "failed"; message: string }

async function findWorktree(repoRoot: string, path: string): Promise<GitWorktreeRef | null> {
  const worktrees = await linkedWorktreesOf(repoRoot)
  return worktrees.find((w) => w.path === path) ?? null
}

async function reclaimOne(
  options: ApplyGcOptions,
  worktree: GitWorktreeRef,
  reclaimReason?: GcReclaimReason,
): Promise<GcApplyOutcome> {
  try {
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

  if (resolved.class === "reclaim") return reclaimOne(options, fresh, resolved.reclaimReason)
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
