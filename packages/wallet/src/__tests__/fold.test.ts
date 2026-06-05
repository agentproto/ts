import { describe, it, expect } from "vitest"
import {
  fold,
  spendableBalance,
  balanceByAsset,
  type WalletEvent,
} from "../fold.js"
import { UNRESTRICTED } from "../restriction-lattice.js"

const CREDIT = "GUILDE_CREDITS"
const P = "GUILDE_CREDITS:general"

function ev(p: Partial<WalletEvent> & Pick<WalletEvent, "kind" | "amount" | "lotId">): WalletEvent {
  return {
    id: p.id ?? `${p.kind}-${p.lotId}-${p.amount}`,
    accountId: "acct-1",
    asset: CREDIT,
    partitionId: P,
    restriction: UNRESTRICTED,
    occurredAt: p.occurredAt ?? 1000,
    ...p,
  }
}

describe("fold — journal is truth, balance is a fold", () => {
  it("mint then burn reduces remaining", () => {
    const events = [
      ev({ kind: "mint", lotId: "L1", amount: 500 }),
      ev({ kind: "burn", lotId: "L1", amount: 120 }),
    ]
    const lots = fold(events, 2000)
    expect(lots).toHaveLength(1)
    expect(lots[0]!.remaining).toBe(380)
    expect(spendableBalance(lots, CREDIT, 2000)).toBe(380)
  })

  it("hold cycle: reserve protects, capture settles, release returns", () => {
    const base = [ev({ kind: "mint", lotId: "L1", amount: 500 })]

    const reserved = fold([...base, ev({ kind: "reserve", lotId: "L1", amount: 200 })], 2000)
    expect(reserved[0]!.reserved).toBe(200)
    expect(spendableBalance(reserved, CREDIT, 2000)).toBe(300) // remaining - reserved

    const captured = fold(
      [...base, ev({ kind: "reserve", lotId: "L1", amount: 200 }), ev({ kind: "capture", lotId: "L1", amount: 200 })],
      2000,
    )
    expect(captured[0]!.remaining).toBe(300)
    expect(captured[0]!.reserved).toBe(0)

    const released = fold(
      [...base, ev({ kind: "reserve", lotId: "L1", amount: 200 }), ev({ kind: "release", lotId: "L1", amount: 200 })],
      2000,
    )
    expect(released[0]!.remaining).toBe(500)
    expect(released[0]!.reserved).toBe(0)
  })

  it("expired lots drop from spendable but the reserved portion is still tracked", () => {
    const events = [
      ev({ kind: "mint", lotId: "L1", amount: 500, expiresAt: 1500 }),
    ]
    const lots = fold(events, 2000)
    expect(lots[0]!.status).toBe("expired")
    expect(spendableBalance(lots, CREDIT, 2000)).toBe(0)
    expect(spendableBalance(lots, CREDIT, 1400)).toBe(500) // before expiry
  })

  it("replay invariance: folding twice yields identical projection", () => {
    const events = [
      ev({ kind: "mint", lotId: "L1", amount: 500 }),
      ev({ kind: "mint", lotId: "L2", amount: 200 }),
      ev({ kind: "burn", lotId: "L1", amount: 50 }),
    ]
    expect(fold(events, 3000)).toEqual(fold(events, 3000))
    expect(balanceByAsset(fold(events, 3000), 3000).get(CREDIT)).toBe(650)
  })
})
