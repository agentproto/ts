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
export type BranchGcStatus = "pr-merged" | "forge-mirror" | "merged" | "squash-merged" | "patch-merged" | "content-merged" | "unmerged"
export type BranchGcReclaimReason = Exclude<BranchGcStatus, "unmerged"> | "reviewed" | "checkpoint-superseded"
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

/** Share of a tip's added lines already verbatim in base — mirrors `BranchLineCoverage`. */
export interface BranchGcLineCoverageView {
  added: number
  inBase: number
  pct: number
  missing: Array<{ file: string; line: string }>
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
  lineCoverage?: BranchGcLineCoverageView
  /** `git cherry` summary of an unmerged tip: commits with no patch-equivalent on the compare base. */
  cherry?: { total: number; unmatched: number }
  ageDays: number
  class: BranchGcClass
  reclaimReason?: BranchGcReclaimReason
  mergedPr?: number
  /** How a `pr-merged` tip matched `mergedPr`: its exact head, an ancestor of that head, or patch-equivalent commits. */
  mergedPrMatch?: "head" | "ancestor" | "patch"
  forgePr?: number
  holdReason?: BranchGcHoldReason
  holdDetail?: string
  pushed?: string
  verdict?: {
    triage: BranchGcTriageVerdict
    agree: boolean | null
    reviewer: string
    operator?: { by: string; note?: string }
  }
  /** Why an agreeing verdict was refused (e.g. line coverage under `minLineCoverage`), or that an operator bypassed that guard. */
  verdictGuard?: string
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
  /** Absent on a result from before the line-coverage guard. */
  minLineCoverage?: number
  /** `git ls-remote <remote> refs/pull/<N>/head` for the forge-mirror shortcut. Absent on an older result. */
  forgeMirrorCheck?: { available: boolean; reason?: string }
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
  /** The same counts keyed by branch name across kinds (a local branch and
   *  its remote twin count once). Absent on a result from before it existed. */
  distinct?: {
    branches: number
    refs: number
    byClass: Record<BranchGcClass, number>
    byStatus: Record<string, number>
  }
}

export interface BranchGcOutcomeView {
  kind: BranchGcKind
  name: string
  sha: string
  result:
    | "deleted"
    | "held"
    | "skipped-review"
    | "refused-guard"
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
  /** `refused-guard`: why the agreeing verdict was refused. */
  guard?: string
}

/** Per-scope tally of apply outcomes. `skipped` = everything that was not
 *  deleted and did not fail (held, skipped-review, refused-guard, aborted-*); the exact
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

/** One plan entry as the `branch_gc` tool returns it by default: what a human
 *  needs to decide, without the reviewer payload (coverage, residual files,
 *  missing lines, cherry) that makes a full entry several KB. */
export interface BranchGcCompactEntry {
  name: string
  kind: BranchGcKind
  sha: string
  class: BranchGcClass
  status: BranchGcStatus
  reclaimReason?: BranchGcReclaimReason
  mergedPr?: number
  mergedPrMatch?: BranchGcPlanEntryView["mergedPrMatch"]
  holdReason?: BranchGcHoldReason
  lineCoverage?: { pct: number }
  verdictGuard?: string
}

export function compactBranchGcEntry(e: BranchGcPlanEntryView): BranchGcCompactEntry {
  return {
    name: e.name,
    kind: e.kind,
    sha: e.sha,
    class: e.class,
    status: e.status,
    ...(e.reclaimReason !== undefined ? { reclaimReason: e.reclaimReason } : {}),
    ...(e.mergedPr !== undefined ? { mergedPr: e.mergedPr } : {}),
    ...(e.mergedPrMatch !== undefined ? { mergedPrMatch: e.mergedPrMatch } : {}),
    ...(e.holdReason !== undefined ? { holdReason: e.holdReason } : {}),
    ...(e.lineCoverage !== undefined ? { lineCoverage: { pct: e.lineCoverage.pct } } : {}),
    ...(e.verdictGuard !== undefined ? { verdictGuard: e.verdictGuard } : {}),
  }
}

export interface BranchGcReplyInput {
  /** Whole rows instead of the compact projection; alone (no other option),
   *  the unchanged full result. */
  full?: boolean
  /** Entries only: keep only these keys of each FULL entry. */
  fields?: string[]
  /** Entries only: keep only entries of these classes. */
  classes?: BranchGcClass[]
  limit?: number
  /** Which list to page. Default: `entries` for a plan, `outcomes` for an
   *  apply (mirroring `branch_gc_status`). */
  section?: BranchGcResultSection
  /** Offset into the selected list (decoded from a `branch_gc` cursor). */
  offset?: number
}

/**
 * A `branch_gc` cursor names the run it pages AND the slice it was created
 * for (`section`, `classes`, `limit`), so the next page is read from that
 * run's stored result with the exact same filtered list instead of
 * re-running the gc. Not interchangeable with `branch_gc_status`'s
 * `o:<n>` cursor ({@link sliceBranchGcResult}): each tool rejects the other.
 */
export function encodeBranchGcCursor(
  jobId: string,
  offset: number,
  section: BranchGcResultSection,
  classes: BranchGcClass[],
  limit: number,
): string {
  return Buffer.from(JSON.stringify({ j: jobId, o: offset, s: section, c: classes, l: limit })).toString("base64url")
}

export function decodeBranchGcCursor(cursor: string): {
  jobId: string
  offset: number
  section?: BranchGcResultSection
  classes?: BranchGcClass[]
  limit?: number
} {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      j?: unknown
      o?: unknown
      s?: unknown
      c?: unknown
      l?: unknown
    }
    if (typeof v.j === "string" && typeof v.o === "number" && Number.isInteger(v.o) && v.o >= 0) {
      const section = v.s === "entries" || v.s === "outcomes" ? v.s : undefined
      const classes = Array.isArray(v.c) ? (v.c.filter(c => c === "reclaim" || c === "review" || c === "hold") as BranchGcClass[]) : undefined
      const limit = typeof v.l === "number" && Number.isInteger(v.l) && v.l >= 1 ? v.l : undefined
      return {
        jobId: v.j,
        offset: v.o,
        ...(section !== undefined ? { section } : {}),
        ...(classes !== undefined ? { classes } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }
    }
  } catch {
    // Fall through to the error below.
  }
  throw new Error("branch_gc: invalid `cursor`")
}

/**
 * Pure: the `branch_gc` tool reply. A real repo's full result is ~800k chars
 * on one line, which no MCP client can read, so by default ONE list is
 * projected down and paged (`page`, with a `nextCursor` naming `jobId` and
 * the slice it belongs to): plan entries are compact
 * ({@link compactBranchGcEntry}); apply outcomes are paged as-is. The
 * summary, the plan metadata, the restore log and `applySummary` stay whole;
 * the list that was not selected stays on disk. `full: true` alone returns
 * the result unchanged.
 */
export function branchGcReply(result: BranchGcResult, opts: BranchGcReplyInput, jobId: string): object {
  const section: BranchGcResultSection = opts.section ?? (result.mode === "apply" ? "outcomes" : "entries")
  const shaped =
    opts.fields !== undefined ||
    opts.classes !== undefined ||
    opts.limit !== undefined ||
    opts.section !== undefined ||
    opts.offset !== undefined
  if (opts.full === true && !shaped) return result
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? BRANCH_GC_PAGE_DEFAULT), 1), BRANCH_GC_PAGE_MAX)
  const start = opts.offset ?? 0
  let total: number
  let pageRows: object[]
  let cursorClasses: BranchGcClass[] = []
  if (section === "outcomes") {
    if (result.mode !== "apply") throw new Error("branch_gc: `section: outcomes` is only available on an apply result")
    total = result.outcomes.length
    pageRows = result.outcomes.slice(start, start + limit)
  } else {
    cursorClasses = opts.classes ?? []
    const rows = result.plan.entries.filter(e => !opts.classes?.length || opts.classes.includes(e.class))
    total = rows.length
    pageRows = rows
      .slice(start, start + limit)
      .map(e =>
        opts.fields !== undefined
          ? Object.fromEntries(Object.entries(e).filter(([key]) => opts.fields!.includes(key)))
          : opts.full === true
            ? e
            : compactBranchGcEntry(e),
      )
  }
  const next = start + limit
  const page: BranchGcResultPage = {
    section,
    total,
    returned: pageRows.length,
    ...(next < total ? { nextCursor: encodeBranchGcCursor(jobId, next, section, cursorClasses, limit) } : {}),
  }
  const { outcomes: _outcomes, ...rest } = result as BranchGcResult & { outcomes?: unknown }
  if (section === "outcomes") {
    const { entries: _entries, ...planMeta } = result.plan
    return { ...rest, plan: planMeta, outcomes: pageRows, jobId, page }
  }
  return { ...rest, plan: { ...result.plan, entries: pageRows }, jobId, page }
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
  /** `includeReviewed` refuses an agreeing verdict below this line coverage (percent). Engine default 95. */
  minLineCoverage?: number
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
  /** Human operator approval overriding the line-coverage guard for this exact tip. */
  operator?: { by: string; note?: string }
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
