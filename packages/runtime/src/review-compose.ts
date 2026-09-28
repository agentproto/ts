/**
 * Attestation composition — the delta re-review (Goal B,
 * `.plans/review-primitive/PLAN-step1.6-signing.md`).
 *
 * A range that grew (`base..mid` attested `pass`, then `base..head`
 * requested) lets an AGENT lane reuse the prior attestation and review only
 * `mid..head` instead of the whole range from scratch. Command lanes are
 * never composed — they check tree state, not a diff, so they always run at
 * the new head (see `review-runner.ts`'s `createReviewLaneExecutor`, which
 * never calls into this module for a command check).
 *
 * Every eligibility rule lives in {@link findComposeCandidate}, checked one
 * at a time so a caller can tell exactly which rule rejected a candidate:
 * same repoRemote + binding + manifestSha + rubric digest for the lane, the
 * prior attestation's own `verdict` AND this lane's own status both `pass`,
 * the prior `baseSha` equal to the new base, the prior `headSha` a strict
 * ancestor of the new head, the prior not `dirty`. Trust is automatic here:
 * a candidate is only ever drawn from THIS daemon's own ledger (`ledger.list`),
 * which is the "own ledger" half of the frozen trust rule — the "or signed by
 * a key in the allowed_signers in use" half applies to a prior attestation
 * from OUTSIDE this daemon's ledger, which this daemon-local runner never
 * encounters (nothing here imports attestations from elsewhere to compose
 * from).
 */

import { execFile } from "node:child_process"
import { rangeSha, type Attestation } from "@agentproto/review"
import type { ReviewLedger } from "./review-ledger.js"

function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return Promise.resolve(false)
  return new Promise((resolvePromise) => {
    execFile("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root }, (err) => {
      resolvePromise(!err)
    })
  })
}

export interface FindComposeCandidateInput {
  ledger: ReviewLedger
  repoRoot: string
  repoRemote: string
  manifestSha: string
  binding: string
  checkId: string
  rubricSha256: string
  baseSha: string
  headSha: string
}

export interface ComposeCandidate {
  attestation: Attestation
}

/** The newest prior attestation this agent lane can build on, or `undefined`
 *  if none qualifies. `ledger.list` returns newest-first, so the first match
 *  found is already the freshest (the smallest possible delta). */
export async function findComposeCandidate(input: FindComposeCandidateInput): Promise<ComposeCandidate | undefined> {
  const entries = await input.ledger.list({
    repoRemote: input.repoRemote,
    manifestSha: input.manifestSha,
    binding: input.binding,
  })
  for (const entry of entries) {
    const a = entry.attestation
    if (a.verdict !== "pass" || a.dirty) continue
    if (a.target.baseSha !== input.baseSha) continue
    const lane = a.lanes.find((l) => l.id === input.checkId)
    if (!lane || lane.status !== "pass") continue
    const rubric = (a.rubrics ?? []).find((r) => r.check === input.checkId)
    if (!rubric || rubric.sha256 !== input.rubricSha256) continue
    if (!(await isAncestor(input.repoRoot, a.target.headSha, input.headSha))) continue
    return { attestation: a }
  }
  return undefined
}

/** The ledger-key rangeSha of `candidate`'s OWN attestation — what
 *  `LaneResult.composedFrom.rangeSha` records, so a verifier can resolve it
 *  directly via `ledger.get({repoRemote, manifestSha, binding, rangeSha})`
 *  without first decoding anything else. Valid because composition requires
 *  the prior `baseSha` to equal the new run's base (checked above). */
export function composedFromRangeSha(candidate: ComposeCandidate): string {
  return rangeSha(candidate.attestation.target)
}
