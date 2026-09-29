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
  /** Agent lanes only: set when this lane reused a prior PASSING attestation
   *  and reviewed only the delta on top of it, instead of the full range —
   *  see "attestation composition" in the package doc. `rangeSha` is the
   *  PRIOR attestation's own ledger-key rangeSha (`baseSha..headSha` of that
   *  prior run — same `baseSha` as this one, since composition requires it);
   *  `headSha` is that prior attestation's head (the delta this lane
   *  actually reviewed is `headSha..<this run's head>`); `attestationSha256`
   *  pins the exact prior attestation reused, so a verifier can resolve it
   *  and confirm it wasn't swapped for a different one after the fact. */
  composedFrom?: {
    rangeSha: string
    headSha: string
    attestationSha256: string
  }
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

/** Content hash of one resolved review pack (`uses[]` entry) at review time —
 *  sha256 over the pack's REVIEW.md plus every rubric file its selected
 *  checks use (sorted by path). `ref` is the `uses[].pack` string as
 *  written; `id`/`version` come from the pack's own REVIEW.md. A digest edit
 *  (the pack's REVIEW.md, or any rubric it selects) changes what the pack's
 *  lanes check, so it's part of what the verdict attests — same role as
 *  {@link RubricDigest} for a locally-declared check.
 *
 *  `alg` names the RECIPE `sha256` was computed under — which bytes, in
 *  what order, with what separators (see `packs.ts`'s
 *  `computePackDigestSha256` for the exact v1 layout, documented there and
 *  in `packages/review/README.md`'s "Review packs" section). It is NOT the
 *  hash function (that's always sha256) — it's a version tag for the
 *  format itself, so a future recipe change never gets compared against an
 *  older one as if they were the same thing. This travels inside a SIGNED
 *  attestation and is expensive to change after the fact, so it's
 *  versioned from day one even though only one version exists yet. A
 *  verifier that doesn't recognize `alg` must refuse to compare rather
 *  than silently mis-verify — see `verifyPackDigests` in the CLI. */
export interface PackDigest {
  ref: string
  id: string
  version: string
  alg: "agentproto-pack-digest/v1"
  sha256: string
}

/** Who produced the verdict. */
export interface Attestor {
  /** The daemon (host) identity that ran the review. */
  daemon: string
  /** Harness presets the agent lanes ran under, deduplicated. */
  presets: string[]
  /** Ed25519 signature over the canonical JSON of the attestation with THIS
   *  field absent (see `canonicalAttestationBytes`) — only the daemon signs;
   *  owner/session/model/presets stay claims inside the payload, never
   *  signers. Additive and optional: an attestation the signing daemon
   *  couldn't sign (no `ssh-keygen`, an unreadable key) is written unsigned
   *  rather than failing the review, and a v1 verifier that ignores this
   *  field stays correct either way. */
  signature?: {
    alg: "ssh-ed25519"
    /** `ssh-keygen -lf` fingerprint of the signing key (`SHA256:...`). */
    keyFingerprint: string
    /** The owner identity claimed — checked against an allowed_signers
     *  file's principal column at verify time. This is a CLAIM inside the
     *  signed payload's envelope, not itself authenticated by the
     *  signature; the daemon's key is what's authenticated, principal is
     *  what it vouches for. */
    principal: string
    /** ISO timestamp the signature was produced. */
    signedAt: string
    /** Armored `ssh-keygen -Y sign -n agentproto-review` SSHSIG output. */
    sig: string
  }
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
  /** Digests of the review packs (`uses[]`) this run resolved — omitted when
   *  the manifest declares none. Additive; schema id unchanged. */
  packs?: PackDigest[]
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
