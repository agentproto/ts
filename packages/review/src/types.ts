/**
 * The review verdict contract: lane results, the folded verdict, and the
 * attestation that binds a verdict to an immutable content range.
 *
 * A review is a workflow with a verdict contract — these types ARE the
 * contract. Everything else in this package (manifest, compile) exists to
 * produce one of these; everything a host adds (git, ledger, sessions) exists
 * to persist or verify one.
 */

/** Finding severity. Ordered: `high` > `medium` > `low`. */
export type Severity = "high" | "medium" | "low"

/** One reviewer finding. `file` is repo-relative; `line` is 1-based. */
export interface Finding {
  severity: Severity
  title: string
  detail: string
  file?: string
  line?: number
}

/** A lane's outcome.
 *   - `pass`    — ran to completion and found nothing blocking.
 *   - `fail`    — ran to completion and found something blocking (non-zero
 *                 exit; an agent finding at/above `blockOn`).
 *   - `skipped` — could not run (spawn failed, preset unresolved, no
 *                 verdict file, cancelled). Never a silent pass.
 *   - `timeout` — exceeded its `timeoutMs` and was killed. */
export type LaneStatus = "pass" | "fail" | "skipped" | "timeout"

export type CheckKind = "command" | "agent"

/** One lane of a review run — one attesting check. */
export interface LaneResult {
  id: string
  kind: CheckKind
  status: LaneStatus
  /** Whether this lane's `fail`/`timeout`/`skipped` can affect the verdict.
   *  An advisory (non-blocking) lane is recorded but never blocks. */
  blocking: boolean
  findings: Finding[]
  durationMs: number
  /** Why a `skipped`/`timeout` lane didn't produce a result — surfaced so an
   *  `incomplete` verdict is always explained. */
  error?: string
  /** Agent lanes: the reviewer session that produced this lane. */
  sessionId?: string
  /** Agent lanes: the harness preset the reviewer ran under. */
  preset?: string
  /** Agent lanes: the reviewer's one-line summary, when it wrote one. */
  summary?: string
  /** Command lanes: the process exit code, when the process exited. */
  exitCode?: number
  /** Agent lanes: the model the reviewer session ran on, when the host knows
   *  it (the session record's active model). Omitted when unknown. */
  model?: string
}

/** The folded review verdict.
 *   - `pass`       — every blocking lane passed.
 *   - `block`      — at least one blocking lane failed.
 *   - `incomplete` — no blocking lane failed, but at least one couldn't
 *                    produce a result (timeout / skipped). Never a pass. */
export type Verdict = "pass" | "block" | "incomplete"

/** Quorum rule deciding how blocking lanes fold into a verdict. Step 1 ships
 *  only `all-blocking-pass`: every blocking lane must pass. */
export type Quorum = "all-blocking-pass"

/** The immutable content a verdict is about. `baseSha..headSha` is a git
 *  range; `repoRemote` identifies the repo independent of where it's
 *  checked out. */
export interface ReviewTarget {
  repoRemote: string
  baseSha: string
  headSha: string
}

/** Content hash of one agent lane's rubric at review time — a rubric edit
 *  changes what the lane checks, so it's part of what the verdict attests. */
export interface RubricDigest {
  check: string
  path: string
  sha256: string
}

/** Who produced the verdict. */
export interface Attestor {
  /** The daemon (host) identity that ran the review. */
  daemon: string
  /** Harness presets the agent lanes ran under, deduplicated. */
  presets: string[]
}

/** Who asked for the review. Informational provenance — it names the
 *  requester, it does not authenticate them. */
export interface ReviewRequester {
  /** The agentproto session that requested the review (the MCP caller). */
  sessionId?: string
  /** The author of the reviewed range's head commit. */
  gitAuthor?: { name: string; email: string }
}

/** A pull request the reviewed range belongs to. Recorded in the attestation
 *  only when the caller knew it at review time (a CI binding); a link found
 *  later lives in the ledger's mutable annotations instead. */
export interface ReviewPrRef {
  provider: "github"
  /** `owner/name`. */
  repo: string
  number: number
  url: string
}

/**
 * A verdict bound to content: the manifest that defined the review
 * (`manifestSha`), the binding that selected lanes, and the frozen git range
 * the lanes ran against. Self-contained — a CI verifier needs nothing else to
 * check that the attestation covers the exact manifest + range it's gating.
 */
export interface Attestation {
  /** Format marker so a verifier can reject a document it doesn't speak. */
  schema: typeof ATTESTATION_SCHEMA
  /** The run that produced this attestation. */
  runId: string
  /** The REVIEW.md `id`. */
  reviewId: string
  /** sha256 (hex) of the REVIEW.md source bytes. */
  manifestSha: string
  binding: string
  target: ReviewTarget
  /** sha256 (hex) of `baseSha..headSha` — the range half of the ledger key. */
  rangeSha: string
  lanes: LaneResult[]
  verdict: Verdict
  attestor: Attestor
  /** Agent-lane rubric digests (empty when the binding has no agent lane). */
  rubrics: RubricDigest[]
  /** True when the working tree had uncommitted changes to tracked files
   *  while the lanes ran — the checks then saw content the range doesn't
   *  contain, so the attestation is recorded but never served from cache. */
  dirty?: boolean
  /** Who requested the review (session + head-commit author), when known. */
  requester?: ReviewRequester
  /** The PR the range was reviewed for, when the caller passed one. */
  pr?: ReviewPrRef
  /** ISO timestamp. */
  createdAt: string
}

export const ATTESTATION_SCHEMA = "agentproto.review.attestation/v1" as const
