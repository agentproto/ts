/**
 * `sandbox checkpoint-gc` — reclaim stale sandbox checkpoint branches from a
 * workspace remote.
 *
 * `sandbox-delivery.ts` force-pushes a box's uncommitted-work snapshot to
 * `agentproto-checkpoint/<work-branch>` and deletes that ref again once the
 * checkout it came from is clean and the work branch landed. When a box dies
 * (lifetime cap, OOM, provider reap) with uncommitted work still on it, the
 * checkpoint ref survives as the ONLY copy of that work, and nothing deletes
 * it: after the session's PR eventually merges (or closes), or once the
 * snapshot's content lands in the work branch or the base branch, the ref is
 * dead weight. Dozens accumulate.
 *
 * This module is the cleanup engine, in the same shape as `branch-gc`:
 *
 *   1. `planSandboxCheckpointGc` is a pure-ish read (it does fetch checkpoint
 *      branches into remote-tracking refs, but mutates nothing on the
 *      remote): every `agentproto-checkpoint/*` ref is classified `safe`
 *      (the work it rescued is provably elsewhere) or `keep`, and a
 *      management CLI renders that plan. Dry run is the default everywhere.
 *   2. `applySandboxCheckpointGc` re-lists and re-classifies every ref in a
 *      fresh `planSandboxCheckpointGc` immediately before deleting it, so a
 *      plan that went stale between plan and apply deletes nothing.
 *
 * `safe` is proven by a ladder judged on the SNAPSHOT's content (its tree),
 * never on ancestry alone (the snapshot's parent is trivially an ancestor of
 * the work branch it snapshotted, so raw ancestry would prove nothing):
 *
 *   pr-resolved     the work branch's PR is merged or closed on the forge
 *                   (a closed PR is a decision the ref must no longer speak
 *                   for; a merged one landed the work)
 *   content-merged  the snapshot's tree IS the remote work branch's (or the
 *                   base branch's) tree: `wt/<slug>` or main already contains
 *                   the checkpoint's content verbatim
 *   merged          the parent's commits landed (ancestor of base or work)
 *                   AND the snapshot is clean (tree == parent's tree), so the
 *                   checkpoint carried nothing beyond them
 *   squash-merged   clean snapshot + `git merge-tree --write-tree <base>
 *                   <parent>` == base's tree: merging the parent changes
 *                   nothing because its content already landed
 *   patch-merged    clean snapshot + `git cherry` maps every commit of the
 *                   parent onto an already-applied patch id in base
 *
 * A snapshot that differs from its parent's tree carries uncommitted delta;
 * only the tree-equality and PR tiers can prove THOSE safe, and any tier
 * that cannot account for the delta is skipped. Anything else is `keep`: a
 * dead box's checkpoint may be the only copy of its work, and this engine
 * never decides unknown against keeping it.
 */

import { spawnSync } from "node:child_process"
import { CHECKPOINT_BRANCH_PREFIX } from "./branch-gc.js"
import type { ForgeClient } from "./forge.js"
import { detectDefaultBranch } from "./services/context.js"

/** Remote branch namespace sandbox-delivery force-pushes snapshots to. */
export { CHECKPOINT_BRANCH_PREFIX as SANDBOX_CHECKPOINT_PREFIX }

/** How an entry's work is accounted for. `keep` entries are never touched. */
export type CheckpointGcVerdict = "safe" | "keep" | "unknown"

export interface SandboxCheckpointGcEntry {
  /** Short remote branch name: `agentproto-checkpoint/wt/x`. */
  ref: string
  /** Remote the ref lives on (default `origin`). */
  remote: string
  /** Tip commit of the ref, or null when it could not be resolved. */
  sha: string | null
  /** The work branch the checkpoint belongs to (`wt/x`). */
  workBranch: string
  /** True when the remote still carries the work branch itself. */
  workBranchOnRemote: boolean
  /** HEAD PR of the work branch, per the forge. Null when no PR, no forge
   *  client, or the forge check failed (never an error: classification has
   *  content-based tiers to fall back on). */
  pr: { number: number; state: "open" | "merged" | "closed" } | null
  verdict: CheckpointGcVerdict
  /** Why: the proven tier, or what a `keep`/`unknown` entry is waiting on. */
  reason: string
}

export interface SandboxCheckpointGcPlan {
  repoRoot: string
  remote: string
  /** The branch content was judged against (the repo's default branch unless overridden). */
  base: string
  /** Whether a usable `gh`-backed forge client answered PR questions. */
  prCheckAvailable: boolean
  /** Why the PR check was unavailable, when it was. */
  prCheckReason?: string
  refs: SandboxCheckpointGcEntry[]
}

export interface SandboxCheckpointGcInput {
  repoRoot: string
  /** Default `origin`. */
  remote?: string
  /** Content adjudication base. Default the repo's default branch as
   *  `origin/<default>` (e.g. `origin/main`). */
  base?: string
  /** Forge client for PR-state questions (built by the caller, usually
   *  `createForgeClient`). Absent or throwing ⇒ PR tier skipped. */
  forge?: Pick<ForgeClient, "pullRequestsForBranch"> | null
}

export interface SandboxCheckpointGcApplyOutcome {
  ref: string
  result: "deleted" | "failed" | "skipped-keep" | "skipped-moved"
  verdict?: CheckpointGcVerdict
  message?: string
}

export interface SandboxCheckpointGcApplyResult {
  outcomes: SandboxCheckpointGcApplyOutcome[]
}

// ── git plumbing ─────────────────────────────────────────────────────

interface GitRun {
  exitCode: number
  stdout: string
  stderr: string
}

function git(repoRoot: string, args: readonly string[]): GitRun {
  const res = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" })
  return {
    exitCode: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  }
}

function isSha(raw: string | undefined): raw is string {
  return raw !== undefined && /^[0-9a-f]{40,64}$/.test(raw.trim())
}

/** Resolve a ref to a commit sha, or null (never throws, never prints). */
function revParse(repoRoot: string, ref: string): string | null {
  const out = git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]).stdout.trim()
  return isSha(out) ? out.trim() : null
}

/**
 * Fetch the checkpoint refs (and the work branches + base) into
 * remote-tracking refs so the classification can resolve objects. Missing
 * work branches are not a fetch error: they are legal (merged work
 * branches), so the fetch spec for them is tried best-effort and failures
 * are ignored — the classification already handles an absent remote twin.
 */
export function buildCheckpointFetchSpecs(workBranches: readonly string[], remote: string): string[] {
  const specs = [
    `+refs/heads/${CHECKPOINT_BRANCH_PREFIX}*:refs/remotes/${remote}/${CHECKPOINT_BRANCH_PREFIX}*`,
    `+refs/heads/main:refs/remotes/${remote}/main`,
    `+refs/heads/master:refs/remotes/${remote}/master`,
  ]
  for (const branch of workBranches) specs.push(`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`)
  return specs
}

// ── classification ───────────────────────────────────────────────────

export interface CheckpointSafetyVerdict {
  verdict: CheckpointGcVerdict
  reason: string
}

/**
 * Judge one checkpoint ref: is the work it rescued provably elsewhere?
 * `parentSha` and `sha` must both resolve; callers ensure that. `baseRef`
 * names the content adjudication base, `workRef` the remote work branch
 * (or null when merged). Every tier is a positive proof; absence of proof
 * is `keep`.
 */
export function classifyCheckpointRef(
  repoRoot: string,
  input: {
    /** `refs/remotes/origin/agentproto-checkpoint/wt/x`. */
    ckptRef: string
    ckptSha: string
    /** Sha of `${ckptRef}^` — the work-branch head the box snapshotted on. */
    parentSha: string
    baseRef: string
    /** `refs/remotes/origin/wt/x`, or null when the work branch is gone. */
    workRef: string | null
    /** The HEAD pr, present when the forge answered. */
    pr?: { number: number; state: "open" | "merged" | "closed" } | null
}): CheckpointSafetyVerdict {
  const { ckptRef, parentSha, baseRef, workRef } = input
  if (input.pr) {
    const { state, number } = input.pr
    if (state === "merged" || state === "closed") {
      return { verdict: "safe", reason: `pr-resolved (#${number} ${state})` }
    }
  }
  // The snapshot's tree is the content; its parent is the committed head the
  // box sat on. The snapshot is safe exactly when that CONTENT already lives
  // in the work branch (its remote tip tree) or in the base branch, judged
  // against trees and patch ids rather than ancestry alone. (The parent is
  // always an ancestor of the work branch it snapshotted, so raw ancestry
  // against the work branch would prove nothing.)
  const snapTree = revParse(repoRoot, `${ckptRef}^{tree}`)
  const parentTree = revParse(repoRoot, `${parentSha}^{tree}`)
  if (!snapTree || !parentTree) {
    return { verdict: "unknown", reason: "checkpoint objects not fetched; refused for safety" }
  }
  const targets = workRef ? [workRef, baseRef] : [baseRef]
  for (const target of targets) {
    const targetTree = revParse(repoRoot, `${target}^{tree}`)
    if (targetTree && targetTree === snapTree) {
      return { verdict: "safe", reason: `content-merged (snapshot tree is ${target.replace("refs/remotes/", "")}'s tree)` }
    }
  }
  // Content = parent's commits + the uncommitted delta tree(ct) - tree(py).
  // If the parent's commits landed in the base AND the delta is empty (a
  // clean checkout snapshot), everything the checkpoint carried is there.
  if (snapTree === parentTree) {
    for (const target of targets) {
      const anc = git(repoRoot, ["merge-base", "--is-ancestor", parentSha, target])
      if (anc.exitCode === 0) {
        return {
          verdict: "safe",
          reason: `merged (${parentSha.slice(0, 7)} is an ancestor of ${target.replace("refs/remotes/", "")})`,
        }
      }
    }
  }
  // Squash tier: base-with-the-parent-merged must equal base itself, i.e.
  // merging the committed work changes nothing because its content already
  // landed in the base (same tree, no ancestry needed). Only counts for a
  // clean snapshot: uncommitted delta cannot be proven by the parent.
  if (snapTree === parentTree) {
    const mt = git(repoRoot, ["merge-tree", "--write-tree", baseRef, parentSha])
    const baseTree = revParse(repoRoot, `${baseRef}^{tree}`)
    if (mt.exitCode === 0 && baseTree && isSha(mt.stdout.trim()) && mt.stdout.trim() === baseTree) {
      return { verdict: "safe", reason: "squash-merged (merge-tree changes nothing)" }
    }
  }
  // Patch tier, same restriction: `git cherry` maps every commit of the
  // parent onto an already-applied patch id in base (`-` lines), or lists
  // nothing at all when the parent is merged. Uncommitted delta still
  // disqualifies.
  if (snapTree === parentTree) {
    const cherry = git(repoRoot, ["cherry", baseRef, parentSha])
    if (cherry.exitCode === 0) {
      const commits = cherry.stdout.trim()
      if (commits.length === 0 || commits.split("\n").every(line => line.startsWith("-"))) {
        return { verdict: "safe", reason: "patch-merged (every commit cherry-matches base)" }
      }
    }
  }
  return {
    verdict: "keep",
    reason:
      input.pr && input.pr.state === "open"
        ? "open PR; the snapshot may be the only copy of its work"
        : "no proof its content landed elsewhere",
  }
}

// ── plan ─────────────────────────────────────────────────────────────

/**
 * Every `agentproto-checkpoint/*` ref on `remote`, classified. Fetches the
 * checkpoint namespace plus each work branch into remote-tracking refs; a
 * ref whose objects could not be fetched classifies `unknown` and is never
 * deleted, but still appears in the table.
 */
export async function planSandboxCheckpointGc(input: SandboxCheckpointGcInput): Promise<SandboxCheckpointGcPlan> {
  const { repoRoot } = input
  const remote = input.remote ?? "origin"
  let base: string | undefined
  let prCheckAvailable = true
  let prCheckReason: string | undefined
  if (input.base) base = input.base

  const ls = git(repoRoot, ["ls-remote", remote, `refs/heads/${CHECKPOINT_BRANCH_PREFIX}*`])
  if (ls.exitCode !== 0) {
    throw new Error(`sandbox checkpoint gc: ls-remote ${remote} failed: ${(ls.stderr || "unknown error").trim()}`)
  }
  const refs = new Map<string, string>()
  for (const line of ls.stdout.split("\n")) {
    const [sha, name] = line.split("\t")
    if (!isSha(sha) || !name) continue
    refs.set(name.trim(), sha.trim())
  }
  const workBranches = [...refs.keys()].map(name =>
    name.replace(`refs/heads/${CHECKPOINT_BRANCH_PREFIX}`, ""),
  )

  const fetchSpecs = buildCheckpointFetchSpecs(workBranches, remote)
  const fetch = git(repoRoot, ["fetch", "--quiet", remote, ...fetchSpecs])
  if (fetch.exitCode !== 0 && refs.size > 0) {
    // The checkpoint namespace tracks every spec in one call, so a failed
    // pull of one optional work-branch twin can fail the whole fetch. Check
    // what actually landed before giving the plan an empty classification.
    prCheckReason = prCheckReasonFor(fetch)
  }

  if (!base) {
    let defaultBranch: string
    try {
      defaultBranch = await detectDefaultBranch(repoRoot)
    } catch {
      defaultBranch = "main"
    }
    base = `refs/remotes/${remote}/${defaultBranch}`
  }
  if (revParse(repoRoot, base) === null) {
    throw new Error(`sandbox checkpoint gc: base ref ${base} does not resolve in ${repoRoot}`)
  }

  // PR tier: never load-bearing for correctness, so every failure degrades
  // to `pr: null` and the content tiers keep the ref honest.
  let forge = input.forge
  if (forge === undefined) {
    try {
      const created = await createForgeForGc(repoRoot)
      if (created) forge = created
    } catch {
      forge = null
    }
  }
  let prs = new Map<
    string,
    { number: number; state: "open" | "merged" | "closed" }
  >()
  if (forge) {
    const unique = [...new Set(workBranches)]
    const settled = await Promise.allSettled(
      unique.map(async branch => ({
        branch,
        prs: await forge.pullRequestsForBranch(branch),
      })),
    )
    for (const r of settled) {
      if (r.status === "rejected") {
        prCheckAvailable = false
        prCheckReason = prCheckReason ?? "forge query failed"
        continue
      }
      const head = r.value.prs
        .filter(p => p.state === "open" || p.state === "closed")
        .sort((a, b) => b.number - a.number)[0]
      if (head) prs.set(r.value.branch, { number: head.number, state: head.state })
    }
  } else {
    prCheckAvailable = false
    prCheckReason = prCheckReason ?? "no forge client (gh token missing, or origin is not a forge)"
  }

  const entries: SandboxCheckpointGcEntry[] = []
  for (const [name, sha] of refs) {
    const short = name.replace("refs/heads/", "")
    const workBranch = short.replace(CHECKPOINT_BRANCH_PREFIX, "")
    const ckptRef = `refs/remotes/${remote}/${short}`
    const workRef = revParse(repoRoot, `refs/remotes/${remote}/${workBranch}`) !== null
      ? `refs/remotes/${remote}/${workBranch}`
      : null
    if (revParse(repoRoot, ckptRef) === null) {
      entries.push({
        ref: short,
        remote,
        sha,
        workBranch,
        workBranchOnRemote: workRef !== null,
        pr: null,
        verdict: "unknown",
        reason: prCheckReason ?? "objects not fetched; refused for safety",
      })
      continue
    }
    const parentSha = revParse(repoRoot, `${ckptRef}^`)
    const pr = prs.get(workBranch) ?? null
    if (!parentSha) {
      // A parentless snapshot (a snapshot commit cut without `-p HEAD`) can
      // never be proven merged by ancestry: keep it honestly.
      entries.push({
        ref: short,
        remote,
        sha,
        workBranch,
        workBranchOnRemote: workRef !== null,
        pr,
        verdict: "keep",
        reason: "parentless snapshot; cannot prove its work landed elsewhere",
      })
      continue
    }
    const verdict = classifyCheckpointRef(repoRoot, {
      ckptRef,
      ckptSha: sha,
      parentSha,
      baseRef: base,
      workRef,
      pr,
    })
    entries.push({
      ref: short,
      remote,
      sha,
      workBranch,
      workBranchOnRemote: workRef !== null,
      pr,
      verdict: verdict.verdict,
      reason: verdict.reason,
    })
  }
  entries.sort((a, b) => (a.verdict === b.verdict ? a.ref.localeCompare(b.ref) : a.verdict.localeCompare(b.verdict)))
  return { repoRoot, remote, base, prCheckAvailable, ...(prCheckReason ? { prCheckReason } : {}), refs: entries }
}

function prCheckReasonFor(fetch: GitRun): string | undefined {
  const detail = (fetch.stderr || "").trim().split("\n")[0]
  return detail ? `fetch failed: ${detail}` : undefined
}

/** Test seam — defaults to the lazy import-based forge factory the CLI uses. */
let forgeFactory: ((repoRoot: string) => Promise<Pick<ForgeClient, "pullRequestsForBranch">>) | undefined
export function setCheckpointGcForgeFactory(
  factory: ((repoRoot: string) => Promise<Pick<ForgeClient, "pullRequestsForBranch">>) | undefined,
): void {
  forgeFactory = factory
}
async function createForgeForGc(repoRoot: string): Promise<Pick<ForgeClient, "pullRequestsForBranch"> | null> {
  if (forgeFactory !== undefined) return forgeFactory(repoRoot)
  const { createForgeClient } = await import("./forge.js")
  return createForgeClient(repoRoot)
}

// ── apply ─────────────────────────────────────────────────────────────

/**
 * Delete every `safe` ref from the remote. Re-plans FIRST and acts only on
 * the FRESH plan, so a plan that went stale between plan and apply deletes
 * nothing that changed its classification in between. Mutations skip
 * client-side hooks (checkpoint cleanup is a hygiene action, and a repo's
 * `pre-push` gate must not block a `--delete`).
 */
export async function applySandboxCheckpointGc(input: SandboxCheckpointGcInput): Promise<SandboxCheckpointGcApplyResult> {
  const fresh = await planSandboxCheckpointGc(input)
  const outcomes: SandboxCheckpointGcApplyOutcome[] = []
  for (const entry of fresh.refs) {
    if (entry.verdict !== "safe") {
      outcomes.push({ ref: entry.ref, result: "skipped-keep", verdict: entry.verdict, message: entry.reason })
      continue
    }
    try {
      await deleteRemoteRef(input.repoRoot, input.remote ?? entry.remote, entry.ref)
      outcomes.push({ ref: entry.ref, result: "deleted", verdict: "safe" })
    } catch (err) {
      outcomes.push({
        ref: entry.ref,
        result: "failed",
        verdict: "safe",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { outcomes }
}

async function deleteRemoteRef(repoRoot: string, remote: string, ref: string): Promise<void> {
  const res = git(repoRoot, ["push", "--no-verify", remote, "--delete", ref])
  if (res.exitCode !== 0) {
    throw new Error(`push --delete ${ref} failed: ${(res.stderr || res.stdout).trim()}`)
  }
}

/** One-session convenience: is this session's own checkpoint ref finished,
 *  and, when yes, may the ref go? Shared by the daemon's exit-time hook. */
export async function reclaimOneSandboxCheckpoint(input: {
  repoRoot: string
  workBranch: string
  remote?: string
  forge?: Pick<ForgeClient, "pullRequestsForBranch"> | null
}): Promise<SandboxCheckpointGcApplyOutcome | { skipped: true }> {
  const short = `${CHECKPOINT_BRANCH_PREFIX}${input.workBranch}`
  const plan = await planSandboxCheckpointGc(input)
  const entry = plan.refs.find(e => e.ref === short)
  if (!entry) return { skipped: true }
  if (entry.verdict !== "safe") return { ref: entry.ref, result: "skipped-keep", verdict: entry.verdict, message: entry.reason }
  try {
    await deleteRemoteRef(input.repoRoot, input.remote ?? entry.remote, entry.ref)
    return { ref: entry.ref, result: "deleted", verdict: "safe" }
  } catch (err) {
    return {
      ref: entry.ref,
      result: "failed",
      verdict: "safe",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── table rendering for the CLI ──────────────────────────────────────

export function renderSandboxCheckpointGcPlan(plan: SandboxCheckpointGcPlan): string {
  const lines: string[] = []
  lines.push(
    `remote ${plan.remote}  base ${plan.base.replace(`refs/remotes/${plan.remote}/`, "")}  repo ${plan.repoRoot}` +
      `  PR check: ${plan.prCheckAvailable ? "ok" : `unavailable (${plan.prCheckReason ?? "unknown"})`}\n`,
  )
  for (const e of plan.refs) {
    const sha = e.sha ? e.sha.slice(0, 10) : "unknown"
    const pr = e.pr ? `#${e.pr.number} ${e.pr.state}` : "-"
    lines.push(
      `${sha}  ${e.ref.padEnd(50)}  work=${e.workBranch}${e.workBranchOnRemote ? "" : " (gone)"}  ` +
        `${pr.padEnd(12)}  ${e.verdict}  ${e.reason}`,
    )
  }
  if (plan.refs.length === 0) lines.push("(no agentproto-checkpoint/* refs on the remote)\n")
  return lines.join("\n")
}
