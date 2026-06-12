import { describe, it, expect } from "vitest"
import {
  fold,
  spendableBalance,
  balanceByAsset,
  type Lot,
  type WalletEvent,
} from "../fold.js"
import { selectLotsForSpend } from "../coalescing.js"
import type { AssetDeclaration } from "../asset.js"
import type { PartitionSpec } from "../partition.js"
import { UNRESTRICTED } from "../restriction-lattice.js"

const CREDIT = "GUILDE_CREDITS"
const P = "GUILDE_CREDITS:general"

const ASSET: AssetDeclaration = {
  ref: CREDIT,
  name: "Guilde Credits",
  symbol: "GCR",
  decimals: 2,
  standard: "internal",
  ruleSet: { settleOut: false, spendableOn: ["*"], convertEdges: [], transfer: "internal" },
}
const partitions = new Map<string, PartitionSpec>([
  [P, { id: P, asset: CREDIT, restriction: UNRESTRICTED }],
])

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

function lot(p: Partial<Lot> & Pick<Lot, "id" | "remaining">): Lot {
  return {
    accountId: "acct-1",
    asset: CREDIT,
    partitionId: P,
    restriction: UNRESTRICTED,
    original: p.remaining,
    reserved: 0,
    sourceEventId: "e",
    status: "active",
    createdAt: 1000,
    ...p,
  }
}

describe("floor — a lot is a short position when floor < 0", () => {
  it("a floor-0 lot behaves exactly as a normal grant lot", () => {
    const lots = fold(
      [ev({ kind: "mint", lotId: "L1", amount: 500 }), ev({ kind: "burn", lotId: "L1", amount: 500 })],
      2000,
    )
    expect(lots[0]!.remaining).toBe(0)
    expect(lots[0]!.status).toBe("exhausted") // remaining <= floor(0)
    expect(spendableBalance(lots, CREDIT, 2000)).toBe(0)
  })

  it("a short lot stays active while drawing below zero, exhausts at the floor", () => {
    const mint = ev({ kind: "mint", lotId: "S", amount: 0, floor: -1000 })

    const partial = fold([mint, ev({ kind: "burn", lotId: "S", amount: 300 })], 2000)
    expect(partial[0]!.remaining).toBe(-300)
    expect(partial[0]!.status).toBe("active") // −300 > floor −1000

    const full = fold([mint, ev({ kind: "burn", lotId: "S", amount: 1000 })], 2000)
    expect(full[0]!.remaining).toBe(-1000)
    expect(full[0]!.status).toBe("exhausted") // reached the floor
  })

  it("a fully-drawn short lot keeps its debt visible in the balance", () => {
    // The key invariant: an exhausted short lot is a liability, not a no-op.
    const lots = fold(
      [ev({ kind: "mint", lotId: "S", amount: 0, floor: -1000 }), ev({ kind: "burn", lotId: "S", amount: 1000 })],
      2000,
    )
    expect(lots[0]!.status).toBe("exhausted")
    expect(spendableBalance(lots, CREDIT, 2000)).toBe(-1000)
    expect(balanceByAsset(lots, 2000).get(CREDIT)).toBe(-1000)
  })

  it("real holdings net against the short lot to the true balance", () => {
    const lots = fold(
      [
        ev({ kind: "mint", lotId: "G", amount: 500 }),
        ev({ kind: "mint", lotId: "S", amount: 0, floor: -1000 }),
        ev({ kind: "burn", lotId: "G", amount: 500 }), // drain real holdings
        ev({ kind: "burn", lotId: "S", amount: 300 }), // then borrow 300
      ],
      2000,
    )
    expect(spendableBalance(lots, CREDIT, 2000)).toBe(-300)
  })
})

describe("floor — coalescing drains real holdings before borrowing", () => {
  it("spends real lots first, then the short lot, within the cap", () => {
    const lots = [
      lot({ id: "G", remaining: 500 }),
      lot({ id: "S", remaining: 0, floor: -1000 }),
    ]
    const plan = selectLotsForSpend(
      lots,
      { asset: CREDIT, category: "text", amount: 1200, now: 2000 },
      ASSET,
      partitions,
    )
    expect(plan.shortfall).toBe(0)
    expect(plan.draws).toEqual([
      { lotId: "G", amount: 500 },
      { lotId: "S", amount: 700 },
    ])
  })

  it("a short lot's available headroom is the distance to its floor", () => {
    const lots = [lot({ id: "S", remaining: -200, floor: -1000 })]
    const plan = selectLotsForSpend(
      lots,
      { asset: CREDIT, category: "text", amount: 1000, now: 2000 },
      ASSET,
      partitions,
    )
    // already −200, floor −1000 ⇒ 800 of headroom left
    expect(plan.draws).toEqual([{ lotId: "S", amount: 800 }])
    expect(plan.shortfall).toBe(200)
  })

  it("a spend past the floor reports the shortfall (bounded overdraft)", () => {
    const lots = [
      lot({ id: "G", remaining: 500 }),
      lot({ id: "S", remaining: 0, floor: -1000 }),
    ]
    const plan = selectLotsForSpend(
      lots,
      { asset: CREDIT, category: "text", amount: 1600, now: 2000 },
      ASSET,
      partitions,
    )
    expect(plan.draws).toEqual([
      { lotId: "G", amount: 500 },
      { lotId: "S", amount: 1000 },
    ])
    expect(plan.shortfall).toBe(100)
  })

  it("an unbounded short lot (floor=null) never exhausts and absorbs any spend", () => {
    // The postpaid mirror: floor=null ⇒ no lower bound. It stays active however
    // far it's drawn, keeps the full negative debt visible, and a spend through
    // it never reports a shortfall.
    const drawn = fold(
      [
        ev({ kind: "mint", lotId: "U", amount: 0, floor: null }),
        ev({ kind: "burn", lotId: "U", amount: 5000 }),
      ],
      2000,
    )
    expect(drawn[0]!.remaining).toBe(-5000)
    expect(drawn[0]!.status).toBe("active") // unbounded ⇒ never exhausts
    expect(spendableBalance(drawn, CREDIT, 2000)).toBe(-5000)

    const plan = selectLotsForSpend(
      [lot({ id: "G", remaining: 500 }), lot({ id: "U", remaining: 0, floor: null })],
      { asset: CREDIT, category: "text", amount: 9000, now: 2000 },
      ASSET,
      partitions,
    )
    expect(plan.draws).toEqual([
      { lotId: "G", amount: 500 },
      { lotId: "U", amount: 8500 },
    ])
    expect(plan.shortfall).toBe(0)
  })

  it("a prepaid account (no short lot) blocks at zero", () => {
    const lots = [lot({ id: "G", remaining: 500 })]
    const plan = selectLotsForSpend(
      lots,
      { asset: CREDIT, category: "text", amount: 800, now: 2000 },
      ASSET,
      partitions,
    )
    expect(plan.draws).toEqual([{ lotId: "G", amount: 500 }])
    expect(plan.shortfall).toBe(300)
  })
})
