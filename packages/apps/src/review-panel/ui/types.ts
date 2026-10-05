/**
 * Local mirror of the daemon's review shapes actually read by this panel
 * (packages/runtime/src/review-tools.ts's `review_ledger`/`review_status`
 * rows, packages/review/src/types.ts's `Attestation`/`LaneResult`/`Finding`).
 * Deliberately NOT imported from @agentproto/runtime or @agentproto/review —
 * this package stays dependency-isolated from the daemon (same reasoning as
 * work-board/ui/types.ts's `Task`) and the wire payload is plain JSON
 * anyway. Only the fields this UI renders are modelled.
 */

export type Verdict = "pass" | "block" | "incomplete"
/** A `review_ledger` row's chip status — a settled row is always a
 *  `Verdict` (a cancelled run writes nothing to the ledger, so `"cancelled"`
 *  never appears here); an in-flight one is `"running"`. */
export type RowStatus = Verdict | "running"
/** A `review_status` run's chip status — broader than `RowStatus`: a
 *  specific run (not yet folded into the ledger) can also be `"cancelled"`
 *  or `"failed"` (e.g. no REVIEW.md). */
export type ChipStatus = Verdict | "running" | "cancelled" | "failed"
export type LaneStatus = "pass" | "fail" | "skipped" | "timeout"
export type Severity = "high" | "medium" | "low"

export interface LaneSummary {
  id: string
  status: LaneStatus
  blocking: boolean
}

export interface Requester {
  sessionId?: string
  gitAuthor?: { name: string; email: string }
}

export interface PrRef {
  provider: "github"
  repo: string
  number: number
  url: string
}

/** One `review_ledger` row — a settled attestation (no `status`) or an
 *  in-flight run (`status: "running"`, no `verdict` yet). */
export interface ReviewRow {
  runId: string
  status?: "running"
  reviewId?: string
  binding?: string
  verdict?: Verdict
  repoRemote?: string
  baseSha?: string
  headSha?: string
  rangeSha?: string
  manifestSha?: string
  createdAt: string
  dirty?: boolean
  cached?: boolean
  /** Whether the daemon signed the attestation (`attestor.signature` present)
   *  — see `review_ledger`'s `ledgerRow()`. Absent on a row from a daemon
   *  build that predates signing; treated as unsigned either way. */
  signed?: boolean
  /** The host-local checkout `review_run` ran in — never part of the
   *  attestation (not portable), but real metadata this daemon can hand
   *  back into a fresh `review_run` (the "Re-run fresh" action). */
  cwd?: string
  requester?: Requester
  pr?: PrRef
  prState?: "open" | "merged" | "closed"
  lanes: LaneSummary[]
}

export interface ReviewLedgerResult {
  total: number
  attestations: ReviewRow[]
}

export interface Finding {
  severity: Severity
  title: string
  detail: string
  file?: string
  line?: number
}

/** A detail-view lane — the full `LaneResult` shape (review/src/types.ts),
 *  present once `review_status` returns a `done` attestation; while
 *  `running`, only `id`/`status` are known (see `ReviewRow.lanes`). */
export interface DetailLane {
  id: string
  kind?: "command" | "agent"
  status: LaneStatus
  blocking: boolean
  findings: Finding[]
  durationMs?: number
  error?: string
  sessionId?: string
  preset?: string
  /** Reviewers that were unavailable before `preset` produced this lane. */
  fallbacks?: { preset: string; error: string }[]
  summary?: string
  exitCode?: number
  model?: string
}

export interface RubricDigest {
  check: string
  path: string
  sha256: string
}

/**
 * `review_status`'s reply shape (`runView()`, review-tools.ts). `lanes` is
 * the COMPACT `{id, status}` view, present only while `status === "running"`
 * — the full per-lane detail (findings, blocking, duration, agent
 * model/preset/session) only exists once `attestation` is populated, inside
 * `attestation.lanes`.
 */
export interface RunDetail {
  runId: string
  status: "running" | "done" | "failed" | "cancelled"
  reviewId?: string
  binding?: string
  verdict?: Verdict
  cached?: boolean
  error?: string
  supersededBy?: string
  lanes?: Array<{ id: string; status: LaneStatus }>
  attestation?: {
    target: { repoRemote: string; baseSha: string; headSha: string }
    lanes: DetailLane[]
    rubrics: RubricDigest[]
    requester?: Requester
    pr?: PrRef
    dirty?: boolean
    createdAt: string
    /** Only `signature.principal`/`keyFingerprint` are rendered — the `sig`
     *  bytes never reach this panel. */
    attestor?: { signature?: { principal: string; keyFingerprint: string } }
  }
}
