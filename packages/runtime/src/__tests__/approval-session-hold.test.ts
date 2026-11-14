import { describe, expect, it } from "vitest"

import { isHeldApproval, sessionHoldsApproval } from "../approvals/session-hold.js"
import type { ApprovalRecord, ApprovalStatus } from "../approvals/types.js"

const NOW = Date.parse("2026-11-14T03:00:00Z")

function rec(over: Partial<ApprovalRecord> & { id: string }): ApprovalRecord {
  return {
    kind: "jobkit.submit",
    title: "t",
    preview: {},
    payloadHash: "h",
    status: "pending",
    requestedBy: { sessionId: "sess_a" },
    channels: ["ui_card"],
    requestedAt: "2026-11-14T02:00:00Z",
    ...over,
  }
}

const engineOf = (records: ApprovalRecord[]) => ({
  list: (f?: { status?: ApprovalStatus }) => records.filter(r => !f?.status || r.status === f.status),
})

describe("sessionHoldsApproval", () => {
  it("holds while an approval it requested is pending or approved-not-consumed", () => {
    expect(sessionHoldsApproval(engineOf([rec({ id: "1" })]), "sess_a", () => NOW)).toBe(true)
    expect(sessionHoldsApproval(engineOf([rec({ id: "1", status: "approved" })]), "sess_a", () => NOW)).toBe(true)
  })

  it("does not hold once consumed, denied or expired", () => {
    for (const status of ["consumed", "denied", "expired"] as const) {
      expect(sessionHoldsApproval(engineOf([rec({ id: "1", status })]), "sess_a", () => NOW)).toBe(false)
    }
    expect(
      sessionHoldsApproval(
        engineOf([rec({ id: "1", status: "approved", consumedAt: "2026-11-14T02:30:00Z" })]),
        "sess_a",
        () => NOW,
      ),
    ).toBe(false)
  })

  it("ignores another session's approval and operator-requested ones", () => {
    const e = engineOf([
      rec({ id: "1", requestedBy: { sessionId: "sess_b" } }),
      rec({ id: "2", requestedBy: { operator: true } }),
    ])
    expect(sessionHoldsApproval(e, "sess_a", () => NOW)).toBe(false)
  })

  it("a pending approval past its expiresAt no longer holds", () => {
    expect(isHeldApproval(rec({ id: "1", expiresAt: "2026-11-14T02:59:00Z" }), NOW)).toBe(false)
    expect(isHeldApproval(rec({ id: "1", expiresAt: "2026-11-14T03:30:00Z" }), NOW)).toBe(true)
  })
})
