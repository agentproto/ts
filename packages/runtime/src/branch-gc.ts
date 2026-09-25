/**
 * Shared kernel for the daemon's branch-`gc` surface — the sibling of
 * `worktree-gc.ts`. The engine (`planBranchGc` / `applyBranchGc` /
 * `recordBranchVerdict`) lives in `@agentproto/worktree`, a dependency the
 * runtime deliberately does NOT take, so — exactly as the worktree gc surface
 * does — the runtime only defines runtime-local structural result types and
 * the injected ports. The CLI host wires the real runners. Repo-root
 * resolution is shared with the worktree surfaces via
 * `resolveWorktreeQueryRoot` in `worktree-status.ts`.
 */

export type BranchGcKind = "local" | "remote" | "orphan"
export type BranchGcClass = "reclaim" | "review" | "hold"
export type BranchGcStatus = "merged" | "squash-merged" | "patch-merged" | "content-merged" | "unmerged"
export type BranchGcReclaimReason = Exclude<BranchGcStatus, "unmerged"> | "reviewed"
export type BranchGcHoldReason = "protected" | "worktree" | "open-pr" | "pr-check-unavailable" | "young"
export type BranchGcTriageVerdict = "obsolete" | "superseded" | "salvage" | "in-progress" | "unclear"

export interface BranchGcCoverageView {
  residual: number
  covered: number
  ignored: number
  evolved: number
  unique: number
  deletes: number
}

/** One classified ref — mirrors `BranchGcPlanEntry` structurally. */
export interface BranchGcPlanEntryView {
  kind: BranchGcKind
  name: string
  ref: string
  sha: string
  date: string
  author: string
  subject: string
  remote?: string
  status: BranchGcStatus
  history: "current" | "pre-rewrite" | "unrelated"
  ahead: number | null
  behind: number | null
  conflicts?: boolean
  compareBase?: string
  mergeBase?: string
  mergedTree?: string | null
  coverage?: BranchGcCoverageView
  residualFiles?: string[]
  residualFileCount?: number
  ageDays: number
  class: BranchGcClass
  reclaimReason?: BranchGcReclaimReason
  holdReason?: BranchGcHoldReason
  holdDetail?: string
  pushed?: string
  verdict?: { triage: BranchGcTriageVerdict; agree: boolean | null; reviewer: string }
}

export interface BranchGcPlanView {
  repoRoot: string
  repoName: string
  base: string
  baseSha: string
  baseTree: string
  remote: string | null
  anchor: string | null
  prCheck: { available: boolean; reason?: string }
  scopes: BranchGcKind[]
  minAgeDays: number
  includeReviewed: boolean
  generatedAt: string
  otherRemoteRefs: number
  entries: BranchGcPlanEntryView[]
}

/** kind → class → count, and kind → (status | "protected") → count. */
export interface BranchGcSummaryView {
  byClass: Record<BranchGcKind, Record<BranchGcClass, number>>
  byStatus: Record<BranchGcKind, Record<string, number>>
}

export interface BranchGcOutcomeView {
  kind: BranchGcKind
  name: string
  sha: string
  result:
    | "deleted"
    | "held"
    | "skipped-review"
    | "aborted-moved"
    | "aborted-vanished"
    | "aborted-reclassified"
    | "failed"
  reclaimReason?: BranchGcReclaimReason
  holdReason?: BranchGcHoldReason
  currentSha?: string
  from?: BranchGcClass
  to?: BranchGcClass
  message?: string
}

export type BranchGcResult =
  | { mode: "plan"; plan: BranchGcPlanView; summary: BranchGcSummaryView }
  | {
      mode: "apply"
      plan: BranchGcPlanView
      summary: BranchGcSummaryView
      outcomes: BranchGcOutcomeView[]
      /** Restore log written before the first delete; `null` when nothing was deleted. */
      restoreLog: string | null
    }

/** Input to the injected runner. `apply` defaults to false at the tool/route
 *  boundary — a bare call is a dry run — and an apply requires `scopes`. */
export interface BranchGcRunInput {
  repoRoot: string
  apply: boolean
  base?: string
  scopes?: BranchGcKind[]
  minAgeDays?: number
  includeReviewed: boolean
  anchor?: string
}

export type BranchGcRunner = (input: BranchGcRunInput) => Promise<BranchGcResult>

export interface BranchGcVerdictInput {
  repoRoot: string
  /** Validated by the engine (`branchVerdictSchema`) — the runtime only shapes it. */
  verdict: unknown
}

export interface BranchGcVerdictRecordView {
  repo: string
  name: string
  sha: string
  recordedAt: string
  triage: { verdict: BranchGcTriageVerdict; confidence: number; reason: string; salvage?: string }
  gate?: { agree: boolean; verdict: BranchGcTriageVerdict; reason: string; evidence: string[] }
  reviewer: string
}

/** Injected port: validate + store one reviewer verdict, keyed by repo + tip sha. Throws on an invalid verdict. */
export type BranchGcVerdictRecorder = (input: BranchGcVerdictInput) => Promise<BranchGcVerdictRecordView>
