/**
 * Example of a host overlay: a metered call gate (the three hooks of
 * `VoiceBillingGate` in `@agentproto/voice`) written over `createHolds`.
 * Prices, thresholds and the account lookup are the host's: here they are
 * made-up numbers for a fictional "example-assistant".
 */
import type { WalletEvent } from "@agentproto/wallet"
import { describe, expect, it } from "vitest"
import { createHolds, type HoldRef } from "../spend/index.js"
import { InMemoryStorage, ManualClock } from "../testing/index.js"

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const CREDITS_PER_MINUTE = 10 // the host's price, not the kit's

function overlay(storage: InMemoryStorage, clock: ManualClock) {
  const holds = createHolds({ storage, clock }, { asset: "credits", warnAt: 0.8, cutoffAt: 0.95 })
  const priceSeconds = (s: number) => Math.ceil((s / 60) * CREDITS_PER_MINUTE)
  return {
    holds,
    onAuthorize: async (ctx: { account: string; call: string }) => {
      const r = await holds.hold({ accountId: ctx.account, key: ctx.call, amount: priceSeconds(30 * 60) })
      return r.ok ? { ok: true as const, hold: r.hold } : { ok: false as const, reason: r.reason }
    },
    onCheckpoint: async (_ctx: unknown, hold: HoldRef, p: { elapsedSeconds: number }) => ({ action: holds.checkpoint(hold, priceSeconds(p.elapsedSeconds)).action }),
    onSettle: async (_ctx: unknown, hold: HoldRef, p: { elapsedSeconds: number }) => void (await holds.settle(hold, priceSeconds(p.elapsedSeconds))),
  }
}

describe("overlay example: a call gate over createHolds", () => {
  it("refuses a call the account cannot start, then charges a short call at its real cost", async () => {
    const clock = new ManualClock(T0)
    const storage = new InMemoryStorage(clock)
    const mint = (account: string, amount: number): WalletEvent => ({ id: `m:${account}`, accountId: account, kind: "mint", asset: "credits", partitionId: "main", restriction: [], amount, lotId: `lot:${account}`, occurredAt: T0 })
    await storage.commit("rich", [mint("rich", 1_000)])
    await storage.commit("poor", [mint("poor", 5)])
    const g = overlay(storage, clock)

    expect(await g.onAuthorize({ account: "poor", call: "c0" })).toEqual({ ok: false, reason: "insufficient_funds" })

    const a = await g.onAuthorize({ account: "rich", call: "c1" })
    if (!a.ok) throw new Error("authorize")
    expect(await storage.spendableBalance("rich", "credits")).toBe(1_000 - 300)
    expect((await g.onCheckpoint({}, a.hold, { elapsedSeconds: 60 })).action).toBe("continue")
    expect((await g.onCheckpoint({}, a.hold, { elapsedSeconds: 29 * 60 })).action).toBe("cutoff")
    await g.onSettle({}, a.hold, { elapsedSeconds: 120 })
    expect(await storage.spendableBalance("rich", "credits")).toBe(1_000 - 20)
  })
})
