import { describe, it, expect } from "vitest"
import { selectLotsForSpend } from "../coalescing.js"
import type { Lot } from "../fold.js"
import type { AssetDeclaration } from "../asset.js"
import type { PartitionSpec } from "../partition.js"
import { canonical, UNRESTRICTED } from "../restriction-lattice.js"

const CREDIT: AssetDeclaration = {
  ref: "GUILDE_CREDITS",
  name: "Guilde Credits",
  symbol: "GCR",
  decimals: 2,
  standard: "internal",
  ruleSet: { settleOut: false, spendableOn: ["*"], convertEdges: [], transfer: "internal" },
}

const POINTS: AssetDeclaration = {
  ref: "GUILDE_POINTS",
  name: "Guilde Points",
  symbol: "GPT",
  decimals: 0,
  standard: "internal",
  // no spend edge — loyalty, only convertible
  ruleSet: { settleOut: false, spendableOn: [], convertEdges: [], transfer: "none" },
}

const partitions = new Map<string, PartitionSpec>([
  ["GUILDE_CREDITS:general", { id: "GUILDE_CREDITS:general", asset: "GUILDE_CREDITS", restriction: UNRESTRICTED }],
  [
    "GUILDE_CREDITS:image-trial",
    {
      id: "GUILDE_CREDITS:image-trial",
      asset: "GUILDE_CREDITS",
      restriction: canonical(["image-only"]),
      spendableOn: ["image"],
    },
  ],
])

function lot(p: Partial<Lot> & Pick<Lot, "id" | "partitionId" | "remaining">): Lot {
  return {
    accountId: "acct-1",
    asset: "GUILDE_CREDITS",
    restriction: partitions.get(p.partitionId)?.restriction ?? UNRESTRICTED,
    original: p.remaining,
    reserved: 0,
    sourceEventId: "e",
    status: "active",
    createdAt: 1000,
    ...p,
  }
}

describe("coalescing — intra-asset spend routing", () => {
  it("restricted-first: an image spend burns image-trial before general", () => {
    const lots = [
      lot({ id: "L-gen", partitionId: "GUILDE_CREDITS:general", remaining: 500 }),
      lot({ id: "L-img", partitionId: "GUILDE_CREDITS:image-trial", remaining: 50 }),
    ]
    const plan = selectLotsForSpend(lots, { asset: "GUILDE_CREDITS", category: "image", amount: 30, now: 2000 }, CREDIT, partitions)
    expect(plan.shortfall).toBe(0)
    expect(plan.draws).toEqual([{ lotId: "L-img", amount: 30 }])
  })

  it("image-trial is NOT eligible for a text spend (missing capability, not an if)", () => {
    const lots = [
      lot({ id: "L-gen", partitionId: "GUILDE_CREDITS:general", remaining: 500 }),
      lot({ id: "L-img", partitionId: "GUILDE_CREDITS:image-trial", remaining: 50 }),
    ]
    const plan = selectLotsForSpend(lots, { asset: "GUILDE_CREDITS", category: "text", amount: 30, now: 2000 }, CREDIT, partitions)
    expect(plan.draws).toEqual([{ lotId: "L-gen", amount: 30 }])
  })

  it("spans multiple lots and reports shortfall when underfunded", () => {
    const lots = [
      lot({ id: "L-img", partitionId: "GUILDE_CREDITS:image-trial", remaining: 50 }),
      lot({ id: "L-gen", partitionId: "GUILDE_CREDITS:general", remaining: 20 }),
    ]
    const plan = selectLotsForSpend(lots, { asset: "GUILDE_CREDITS", category: "image", amount: 100, now: 2000 }, CREDIT, partitions)
    expect(plan.draws).toEqual([{ lotId: "L-img", amount: 50 }, { lotId: "L-gen", amount: 20 }])
    expect(plan.shortfall).toBe(30)
  })

  it("points can never be drained by a spend — no eligible lot", () => {
    const ptPartitions = new Map<string, PartitionSpec>([
      ["GUILDE_POINTS:default", { id: "GUILDE_POINTS:default", asset: "GUILDE_POINTS", restriction: UNRESTRICTED }],
    ])
    const lots = [
      { ...lot({ id: "L-pt", partitionId: "GUILDE_POINTS:default", remaining: 1000 }), asset: "GUILDE_POINTS" },
    ]
    const plan = selectLotsForSpend(lots, { asset: "GUILDE_POINTS", category: "text", amount: 10, now: 2000 }, POINTS, ptPartitions)
    expect(plan.draws).toEqual([])
    expect(plan.shortfall).toBe(10)
  })
})
