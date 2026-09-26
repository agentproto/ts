/**
 * Attestation: binding a verdict to the exact content it's about.
 *
 * The ledger key is `(repoRemote, manifestSha, binding, rangeSha)` — change
 * any of the four and a prior verdict no longer applies. `verifyAttestation`
 * is the check a CI verifier runs against an exported attestation: recompute
 * the manifest and range hashes from what IT sees and compare.
 */

import { createHash } from "node:crypto"
import {
  ATTESTATION_SCHEMA,
  type Attestation,
  type Attestor,
  type LaneResult,
  type ReviewTarget,
  type RubricDigest,
} from "./types.js"
import { foldVerdict } from "./verdict.js"
import type { Quorum } from "./types.js"

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/** sha256 of the REVIEW.md source — the manifest half of the ledger key. */
export function manifestSha(source: string | Uint8Array): string {
  return sha256Hex(source)
}

/** sha256 of `<baseSha>..<headSha>` — the range half of the ledger key. */
export function rangeSha(target: Pick<ReviewTarget, "baseSha" | "headSha">): string {
  return sha256Hex(`${target.baseSha}..${target.headSha}`)
}

/** The ledger identity of a verdict. */
export interface LedgerKey {
  repoRemote: string
  manifestSha: string
  binding: string
  rangeSha: string
}

export function ledgerKeyOf(a: Pick<Attestation, "target" | "manifestSha" | "binding" | "rangeSha">): LedgerKey {
  return { repoRemote: a.target.repoRemote, manifestSha: a.manifestSha, binding: a.binding, rangeSha: a.rangeSha }
}

export interface BuildAttestationInput {
  runId: string
  reviewId: string
  manifestSha: string
  binding: string
  quorum?: Quorum
  target: ReviewTarget
  lanes: LaneResult[]
  attestor: Attestor
  rubrics?: RubricDigest[]
  dirty?: boolean
  /** Override the timestamp (tests). */
  createdAt?: string
}

/** Assemble an attestation, folding the verdict from `lanes`. The verdict is
 *  ALWAYS derived here — a caller can't hand in a verdict that disagrees
 *  with its own lanes. */
export function buildAttestation(input: BuildAttestationInput): Attestation {
  return {
    schema: ATTESTATION_SCHEMA,
    runId: input.runId,
    reviewId: input.reviewId,
    manifestSha: input.manifestSha,
    binding: input.binding,
    target: { ...input.target },
    rangeSha: rangeSha(input.target),
    lanes: input.lanes,
    verdict: foldVerdict(input.lanes, input.quorum),
    attestor: { daemon: input.attestor.daemon, presets: [...new Set(input.attestor.presets)] },
    rubrics: input.rubrics ?? [],
    ...(input.dirty ? { dirty: true } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
}

export interface VerifyAttestationExpect {
  /** The REVIEW.md source the verifier sees (hashed and compared). */
  manifestSource?: string | Uint8Array
  /** Or a precomputed manifest sha. */
  manifestSha?: string
  baseSha?: string
  headSha?: string
  repoRemote?: string
  binding?: string
  /** Require this verdict (usually `"pass"`). */
  verdict?: Attestation["verdict"]
}

export interface VerifyAttestationResult {
  ok: boolean
  /** Human-readable reasons verification failed (empty when `ok`). */
  problems: string[]
}

/**
 * Verify an attestation against what the verifier independently knows. Also
 * re-checks internal consistency: `rangeSha` matches the target's shas, and
 * the verdict re-folds from the lanes — a hand-edited verdict is caught.
 */
export function verifyAttestation(att: Attestation, expect: VerifyAttestationExpect = {}): VerifyAttestationResult {
  const problems: string[] = []
  if (att.schema !== ATTESTATION_SCHEMA) problems.push(`unknown schema '${String(att.schema)}'`)
  if (att.rangeSha !== rangeSha(att.target)) problems.push("rangeSha does not match target.baseSha..target.headSha")
  const refolded = foldVerdict(att.lanes)
  if (refolded !== att.verdict) problems.push(`verdict '${att.verdict}' does not follow from its lanes (expected '${refolded}')`)
  const wantManifest =
    expect.manifestSha ?? (expect.manifestSource !== undefined ? manifestSha(expect.manifestSource) : undefined)
  if (wantManifest !== undefined && wantManifest !== att.manifestSha) problems.push("manifestSha mismatch")
  if (expect.baseSha !== undefined && expect.baseSha !== att.target.baseSha) problems.push("baseSha mismatch")
  if (expect.headSha !== undefined && expect.headSha !== att.target.headSha) problems.push("headSha mismatch")
  if (expect.repoRemote !== undefined && expect.repoRemote !== att.target.repoRemote) problems.push("repoRemote mismatch")
  if (expect.binding !== undefined && expect.binding !== att.binding) problems.push("binding mismatch")
  if (expect.verdict !== undefined && expect.verdict !== att.verdict) {
    problems.push(`verdict is '${att.verdict}', expected '${expect.verdict}'`)
  }
  if (att.dirty) problems.push("attestation was produced from a dirty working tree")
  return { ok: problems.length === 0, problems }
}
