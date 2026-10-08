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
export type BranchGcStatus = "pr-merged" | "merged" | "squash-merged" | "patch-merged" | "content-merged" | "unmerged"
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
  mergedPr?: number
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
  /** true = base-remote `fetch --prune` succeeded; false = failed; null = skipped / no remote. */
  fetched: boolean | null
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

/** Per-scope tally of apply outcomes. `skipped` = everything that was not
 *  deleted and did not fail (held, skipped-review, aborted-*); the exact
 *  per-result counts stay in `byResult`. */
export interface BranchGcApplyScopeCounts {
  deleted: number
  skipped: number
  failed: number
}

export interface BranchGcApplySummary {
  /** `ok` = deletes only, no failures/aborts; `partial` = some deleted but
   *  also failed or aborted; `failed` = failures and nothing deleted;
   *  `noop` = nothing deleted, nothing failed. */
  status: "ok" | "partial" | "failed" | "noop"
  totals: BranchGcApplyScopeCounts
  byScope: Record<BranchGcKind, BranchGcApplyScopeCounts>
  byResult: Partial<Record<BranchGcOutcomeView["result"], number>>
  restoreLog: string | null
}

export type BranchGcApplyResult = {
  mode: "apply"
  plan: BranchGcPlanView
  summary: BranchGcSummaryView
  outcomes: BranchGcOutcomeView[]
  /** Restore log written before the first delete; `null` when nothing was deleted. */
  restoreLog: string | null
  /** Same value as `applySummary.status`, hoisted so a caller can branch on it. */
  status?: BranchGcApplySummary["status"]
  applySummary?: BranchGcApplySummary
}

export type BranchGcResult =
  | { mode: "plan"; plan: BranchGcPlanView; summary: BranchGcSummaryView }
  | BranchGcApplyResult

/** Pure: tally an apply result's outcomes per scope. */
export function summarizeBranchGcApply(result: BranchGcApplyResult): BranchGcApplySummary {
  const zero = (): BranchGcApplyScopeCounts => ({ deleted: 0, skipped: 0, failed: 0 })
  const byScope: Record<BranchGcKind, BranchGcApplyScopeCounts> = { local: zero(), remote: zero(), orphan: zero() }
  const totals = zero()
  const byResult: BranchGcApplySummary["byResult"] = {}
  let aborted = 0
  for (const o of result.outcomes) {
    byResult[o.result] = (byResult[o.result] ?? 0) + 1
    const bucket = o.result === "deleted" ? "deleted" : o.result === "failed" ? "failed" : "skipped"
    byScope[o.kind][bucket]++
    totals[bucket]++
    if (o.result.startsWith("aborted-")) aborted++
  }
  const status: BranchGcApplySummary["status"] =
    totals.deleted === 0
      ? totals.failed > 0
        ? "failed"
        : "noop"
      : totals.failed > 0 || aborted > 0
        ? "partial"
        : "ok"
  return { status, totals, byScope, byResult, restoreLog: result.restoreLog ?? null }
}

/** Attach `status` + `applySummary` to an apply result; a plan passes through. */
export function withBranchGcApplySummary(result: BranchGcResult): BranchGcResult {
  if (result.mode !== "apply") return result
  const applySummary = summarizeBranchGcApply(result)
  return { ...result, status: applySummary.status, applySummary }
}

export type BranchGcResultSection = "entries" | "outcomes"

export interface BranchGcResultSliceInput {
  /** Which list to return. Default: `entries` for a plan, `outcomes` for an apply. */
  section?: BranchGcResultSection
  /** Entries only: keep these classes. */
  classes?: BranchGcClass[]
  /** Keep these ref kinds (entries and outcomes). */
  scopes?: BranchGcKind[]
  /** Outcomes only: keep these outcome results. */
  results?: BranchGcOutcomeView["result"][]
  limit?: number
  cursor?: string
}

export interface BranchGcResultPage {
  section: BranchGcResultSection
  /** Rows matching the filters (before paging). */
  total: number
  returned: number
  nextCursor?: string
}

export const BRANCH_GC_PAGE_DEFAULT = 100
export const BRANCH_GC_PAGE_MAX = 500

const encodeOffset = (n: number): string => Buffer.from(`o:${n}`).toString("base64url")
function decodeOffset(cursor: string): number {
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"))
  if (!m) throw new Error("branch_gc_status: invalid `cursor`")
  return Number(m[1])
}

/**
 * Pure: project a full result down to ONE filtered, paged list. A real
 * repo's full result is 65k+ chars on one line — over the MCP output cap — so
 * `branch_gc_status` never returns the whole thing inline. The other list is
 * dropped (it is still on disk at `resultPath`); everything else (summary,
 * plan metadata, restore log, applySummary) is kept.
 */
export function sliceBranchGcResult(
  result: BranchGcResult,
  opts: BranchGcResultSliceInput,
): { result: object; page: BranchGcResultPage } {
  const section: BranchGcResultSection = opts.section ?? (result.mode === "apply" ? "outcomes" : "entries")
  const scopeOk = (kind: BranchGcKind): boolean => !opts.scopes?.length || opts.scopes.includes(kind)
  let rows: object[]
  if (section === "outcomes") {
    if (result.mode !== "apply") throw new Error("branch_gc_status: `section: outcomes` is only available on an apply result")
    rows = result.outcomes.filter(o => scopeOk(o.kind) && (!opts.results?.length || opts.results.includes(o.result)))
  } else {
    rows = result.plan.entries.filter(
      e => scopeOk(e.kind) && (!opts.classes?.length || opts.classes.includes(e.class)),
    )
  }
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? BRANCH_GC_PAGE_DEFAULT), 1), BRANCH_GC_PAGE_MAX)
  const start = opts.cursor !== undefined ? decodeOffset(opts.cursor) : 0
  const pageRows = rows.slice(start, start + limit)
  const next = start + limit
  const page: BranchGcResultPage = {
    section,
    total: rows.length,
    returned: pageRows.length,
    ...(next < rows.length ? { nextCursor: encodeOffset(next) } : {}),
  }
  const { plan, ...rest } = result
  const { entries: _entries, ...planMeta } = plan
  const { outcomes: _outcomes, ...restNoOutcomes } = rest as typeof rest & { outcomes?: unknown }
  return {
    page,
    result: {
      ...restNoOutcomes,
      plan: section === "entries" ? { ...planMeta, entries: pageRows } : planMeta,
      ...(section === "outcomes" ? { outcomes: pageRows } : {}),
    },
  }
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

export interface BranchGcVerdictLookupInput {
  repoRoot: string
  /** Full tip sha — the store's key, together with the repo. */
  sha: string
}

/** Injected port: the stored verdict for this exact tip, or `null` — a read-only
 *  lookup, so a caller can check one tip without re-running a whole `branch_gc` plan. */
export type BranchGcVerdictReader = (input: BranchGcVerdictLookupInput) => Promise<BranchGcVerdictRecordView | null>
