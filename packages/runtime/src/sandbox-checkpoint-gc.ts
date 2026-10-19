/**
 * Shared kernel for the daemon's sandbox-checkpoint-`gc` surface — the
 * sibling of `branch-gc.ts`. The engine (`planSandboxCheckpointGc` /
 * `applySandboxCheckpointGc`) lives in `@agentproto/worktree`, a dependency
 * the runtime deliberately does NOT take, so the runtime only defines
 * runtime-local structural result types and the injected port. The CLI host
 * wires the real runner.
 *
 * `sandbox_checkpoint_gc` sweeps the `agentproto-checkpoint/*` refs a dead
 * sandbox leaves on a workspace remote. It is a dry run by default; an apply
 * re-plans and re-classifies every ref immediately before deleting it, so a
 * stale plan can never delete work that has since changed classification.
 */

export type SandboxCheckpointGcVerdict = "safe" | "keep" | "unknown"

export interface SandboxCheckpointGcPrView {
  number: number
  state: "open" | "merged" | "closed"
}

/** One classified `agentproto-checkpoint/*` ref — mirrors the engine entry. */
export interface SandboxCheckpointGcEntryView {
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
  /** HEAD PR of the work branch, per the forge, or null when unknown. */
  pr: SandboxCheckpointGcPrView | null
  verdict: SandboxCheckpointGcVerdict
  /** Why: the proven tier, or what a `keep`/`unknown` entry is waiting on. */
  reason: string
}

export interface SandboxCheckpointGcPlanView {
  repoRoot: string
  remote: string
  /** The branch content was judged against. */
  base: string
  /** Whether a usable `gh`-backed forge client answered PR questions. */
  prCheckAvailable: boolean
  /** Why the PR check was unavailable, when it was. */
  prCheckReason?: string
  refs: SandboxCheckpointGcEntryView[]
}

/** safe / keep / unknown tallies over a plan. */
export interface SandboxCheckpointGcSummaryView {
  total: number
  safe: number
  keep: number
  unknown: number
}

export interface SandboxCheckpointGcApplyOutcomeView {
  ref: string
  result: "deleted" | "failed" | "skipped-keep" | "skipped-moved"
  verdict?: SandboxCheckpointGcVerdict
  message?: string
}

/** Apply tallies: deleted / skipped / failed, plus a coarse status. */
export interface SandboxCheckpointGcApplySummaryView {
  /** `ok` = deletes only; `partial` = some deleted and some failed;
   *  `failed` = failures and nothing deleted; `noop` = nothing to do. */
  status: "ok" | "partial" | "failed" | "noop"
  deleted: number
  skipped: number
  failed: number
}

export type SandboxCheckpointGcResult =
  | { mode: "plan"; plan: SandboxCheckpointGcPlanView; summary: SandboxCheckpointGcSummaryView }
  | {
      mode: "apply"
      plan: SandboxCheckpointGcPlanView
      summary: SandboxCheckpointGcSummaryView
      outcomes: SandboxCheckpointGcApplyOutcomeView[]
      /** Attached by the tool/runner boundary (`withSandboxCheckpointGcApplySummary`). */
      applySummary?: SandboxCheckpointGcApplySummaryView
    }

export function summarizeSandboxCheckpointGcPlan(plan: SandboxCheckpointGcPlanView): SandboxCheckpointGcSummaryView {
  const summary: SandboxCheckpointGcSummaryView = {
    total: plan.refs.length,
    safe: 0,
    keep: 0,
    unknown: 0,
  }
  for (const entry of plan.refs) summary[entry.verdict]++
  return summary
}

export function summarizeSandboxCheckpointGcApply(
  result: Extract<SandboxCheckpointGcResult, { mode: "apply" }>,
): SandboxCheckpointGcApplySummaryView {
  let deleted = 0
  let skipped = 0
  let failed = 0
  for (const outcome of result.outcomes) {
    if (outcome.result === "deleted") deleted++
    else if (outcome.result === "failed") failed++
    else skipped++
  }
  const status: SandboxCheckpointGcApplySummaryView["status"] =
    deleted === 0 ? (failed > 0 ? "failed" : "noop") : failed > 0 ? "partial" : "ok"
  return { status, deleted, skipped, failed }
}

/** Attach `applySummary` to an apply result; a plan passes through. */
export function withSandboxCheckpointGcApplySummary(result: SandboxCheckpointGcResult): SandboxCheckpointGcResult {
  if (result.mode !== "apply") return result
  return { ...result, applySummary: summarizeSandboxCheckpointGcApply(result) }
}

/** Input to the injected runner. `apply` defaults to false at the tool
 *  boundary — a bare call is a dry run. */
export interface SandboxCheckpointGcRunInput {
  repoRoot: string
  apply: boolean
  base?: string
  remote?: string
}

export type SandboxCheckpointGcRunner = (input: SandboxCheckpointGcRunInput) => Promise<SandboxCheckpointGcResult>
