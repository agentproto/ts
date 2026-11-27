import { describe, expect, it } from "vitest"
import { handleRailFact } from "../webhook.js"
import { loadBillingManifest } from "../manifest/index.js"
import type { BillingDeps } from "../ports.js"
import type { PaymentFact } from "../settlement.js"
import { InMemoryBillingState, InMemoryStorage, ManualClock } from "../testing/index.js"
import { REFERENCE_MANIFEST } from "../testing/reference-manifest.js"

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)

function world() {
  const clock = new ManualClock(T0)
  const storage = new InMemoryStorage(clock)
  const state = new InMemoryBillingState()
  const manifest = loadBillingManifest(REFERENCE_MANIFEST, { strategies: [] })
  const deps: BillingDeps = { manifest, storage, clock, state }
  const payment: PaymentFact = { type: "payment", movement: "fake:pi_d", rail: "fake", offerId: "pack-usd", owner: { orgId: "acme" }, amountMinor: 1000, taxMinor: 0, currency: "USD", paidAt: T0 + 5_000 }
  const credits = () => storage.spendableBalance("acme", manifest.primaryAsset)
  return { deps, state, payment, credits }
}

describe("facts received before their payment", () => {
  it("the same early refund delivered twice is kept once and applied once", async () => {
    const w = world()
    const refund = { type: "refund" as const, movement: "fake:re_d", rail: "fake", paymentMovement: "fake:pi_d", amountMinor: 400, at: T0 }
    await handleRailFact(w.deps, refund)
    await handleRailFact(w.deps, refund)
    const paid = await handleRailFact(w.deps, w.payment)
    expect(paid.type === "payment" && paid.deferred?.length).toBe(1)
    expect(await w.credits()).toBe(60_000)
    expect(await w.state.takeDeferred("fake:pi_d")).toEqual([])
  })

  it("an early refund and its early reversal apply in the order of their dates", async () => {
    const w = world()
    // Delivered reversal first, refund second; dated refund first.
    await handleRailFact(w.deps, { type: "refund_reversed", movement: "fake:re_r", rail: "fake", paymentMovement: "fake:pi_d", amountMinor: 1000, at: T0 + 2 })
    await handleRailFact(w.deps, { type: "refund", movement: "fake:re_r", rail: "fake", paymentMovement: "fake:pi_d", amountMinor: 1000, at: T0 + 1 })
    const paid = await handleRailFact(w.deps, w.payment)
    expect(paid.type === "payment" ? paid.deferred?.map(d => `${d.type}:${(d as { outcome: { status: string } }).outcome.status}`) : []).toEqual(["refund:applied", "refund_reversed:applied"])
    expect(await w.credits()).toBe(100_000)
  })

  it("an early lost dispute keeps waiting while its payment is only owed, and applies once the payment completes", async () => {
    const w = world()
    await handleRailFact(w.deps, { type: "dispute", movement: "fake:dp_d", rail: "fake", paymentMovement: "fake:pi_d", status: "lost", amountMinor: 1000, currency: "USD", at: T0 })
    const incomplete = await handleRailFact(w.deps, { ...w.payment, offerId: "" })
    expect(incomplete.type === "payment" && incomplete.outcome.status).toBe("refused")
    const done = await handleRailFact(w.deps, w.payment)
    expect(done.type === "payment" && done.outcome.status).toBe("applied")
    expect(await w.credits()).toBe(0)
  })
})
