import { describe, it, expect } from "vitest"
import {
  authorize,
  minEnvelope,
  type AllowanceEnvelope,
} from "../authorize.js"

const base = {
  asset: "GUILDE_CREDITS",
  category: "text",
  spendableBalance: 1000,
}

describe("authorize — agency boundary", () => {
  it("passive: gated only by balance when no operating cap", () => {
    expect(authorize({ ...base, amount: 800, intent: "passive" })).toEqual({ ok: true })
    expect(authorize({ ...base, amount: 1200, intent: "passive" })).toEqual({
      ok: false,
      reason: "insufficient-balance",
    })
  })

  it("passive: operating cap bounds it even with balance", () => {
    expect(
      authorize({ ...base, amount: 800, intent: "passive", envelope: { operating: { cap: 500 } } }),
    ).toEqual({ ok: false, reason: "operating-cap-exceeded" })
  })

  it("active: blocked when the asset cannot settle out", () => {
    expect(
      authorize({ ...base, amount: 10, intent: "active", settleOutAllowed: false }),
    ).toEqual({ ok: false, reason: "settle-out-forbidden" })
  })

  it("active: discretionary cap + counterparty + asset allow-lists", () => {
    const envelope: AllowanceEnvelope = {
      discretionary: { cap: 100, counterparties: ["svc-x"], assets: ["GUILDE_CREDITS"] },
    }
    expect(
      authorize({ ...base, amount: 50, intent: "active", settleOutAllowed: true, counterparty: "svc-x", envelope }),
    ).toEqual({ ok: true })
    expect(
      authorize({ ...base, amount: 150, intent: "active", settleOutAllowed: true, counterparty: "svc-x", envelope }),
    ).toEqual({ ok: false, reason: "discretionary-cap-exceeded" })
    expect(
      authorize({ ...base, amount: 50, intent: "active", settleOutAllowed: true, counterparty: "evil", envelope }),
    ).toEqual({ ok: false, reason: "counterparty-not-allowed" })
  })

  it("active: window rate limit", () => {
    const envelope: AllowanceEnvelope = {
      discretionary: { ratePerWindow: { amount: 100, windowSec: 3600 } },
    }
    expect(
      authorize({ ...base, amount: 40, intent: "active", settleOutAllowed: true, windowSpent: 70, envelope }),
    ).toEqual({ ok: false, reason: "rate-limit-exceeded" })
  })
})

describe("minEnvelope — lineage-min delegation", () => {
  it("a delegate can only narrow caps and intersect allow-lists", () => {
    const root: AllowanceEnvelope = {
      operating: { cap: 1000 },
      discretionary: { cap: 500, counterparties: ["a", "b", "c"], assets: ["GUILDE_CREDITS", "USD"] },
    }
    const child: AllowanceEnvelope = {
      operating: { cap: 300 },
      discretionary: { cap: 800, counterparties: ["b", "c", "d"] },
    }
    const eff = minEnvelope([root, child])
    expect(eff.operating?.cap).toBe(300) // min(1000, 300)
    expect(eff.discretionary?.cap).toBe(500) // min(500, 800) — child can't widen
    expect(eff.discretionary?.counterparties).toEqual(["b", "c"]) // intersection
    expect(eff.discretionary?.assets).toEqual(["GUILDE_CREDITS", "USD"]) // child omits → inherits
  })
})
