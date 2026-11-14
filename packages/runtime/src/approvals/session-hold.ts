/**
 * "Does this session still hold an approval?": the one predicate behind the
 * two protections that keep a session's Bureau tabs alive.
 *
 * An approval card (`approval_request`, e.g. a job-kit submit card) is rendered
 * in a Bureau tab that belongs to the requesting session. Tearing the session
 * down closes that tab (the exit path revokes the session's AIP-59 token, and
 * the Bureau closes what the token owned), so a human who then approves finds
 * a dead card (`FORM_LOST`). A session holds an approval while one it requested
 * is `pending` (not past its `expiresAt`) or `approved` and not yet consumed.
 * The link is `ApprovalRecord.requestedBy.sessionId`, already persisted by the
 * store; an operator-requested approval (`{operator:true}`) belongs to no
 * session.
 */

import type { ApprovalsEngine } from "./engine.js"
import type { ApprovalRecord } from "./types.js"

export function isHeldApproval(record: ApprovalRecord, nowMs: number): boolean {
  if (record.status === "approved") return record.consumedAt === undefined
  if (record.status !== "pending") return false
  if (record.expiresAt === undefined) return true
  const exp = Date.parse(record.expiresAt)
  return !Number.isFinite(exp) || exp > nowMs
}

/** True when `sessionId` requested an approval that is still pending, or
 *  approved and not consumed. */
export function sessionHoldsApproval(
  engine: Pick<ApprovalsEngine, "list">,
  sessionId: string,
  now: () => number = Date.now,
): boolean {
  const nowMs = now()
  for (const status of ["pending", "approved"] as const) {
    for (const record of engine.list({ status })) {
      if ("sessionId" in record.requestedBy && record.requestedBy.sessionId === sessionId) {
        if (isHeldApproval(record, nowMs)) return true
      }
    }
  }
  return false
}
