import { describe, it, expect } from "vitest"
import { AssetRegistry } from "../registry.js"
import { defineAsset } from "../define-asset.js"
import type { RateResolver } from "../convert.js"

const USD = defineAsset({
  ref: "USD",
  name: "US Dollar",
  symbol: "USD",
  decimals: 2,
  standard: "iso4217",
  ruleSet: { settleOut: "stripe", spendableOn: [], convertEdges: [], transfer: "none" },
})

const CREDITS = defineAsset({
  ref: "GUILDE_CREDITS",
  name: "Guilde Credits",
  symbol: "GCR",
  decimals: 2,
  standard: "internal",
  peg: { vs: "USD", source: "fixed:0.01" },
  ruleSet: {
    settleOut: "internal-ledger",
    spendableOn: ["*"],
    transfer: "internal",
    convertEdges: [],
  },
})

const POINTS = defineAsset({
  ref: "GUILDE_POINTS",
  name: "Guilde Points",
  symbol: "GPT",
  decimals: 0,
  standard: "internal",
  ruleSet: {
    settleOut: false,
    spendableOn: [],
    transfer: "internal",
    convertEdges: [
      { to: "GUILDE_CREDITS", rate: { kind: "fixed", ratio: 1 }, addsRestriction: ["from-points"] },
    ],
  },
})

const fixedResolver: RateResolver = e => (e.rate.kind === "fixed" ? e.rate.ratio : 1)

describe("AssetRegistry — config-first catalog (common + app-wide)", () => {
  it("extend layers app assets onto a common set (immutably)", () => {
    const common = AssetRegistry.from([USD])
    const guilde = common.extend([CREDITS, POINTS])

    expect(guilde.has("USD")).toBe(true)
    expect(guilde.has("GUILDE_CREDITS")).toBe(true)
    expect(common.has("GUILDE_CREDITS")).toBe(false) // extend did not mutate common
    expect(guilde.require("GUILDE_POINTS").symbol).toBe("GPT")
  })

  it("rejects duplicate refs", () => {
    expect(() => AssetRegistry.from([USD, USD])).toThrow(/already registered/)
  })

  it("verify passes a no-arbitrage catalog (points→credit one-way)", () => {
    const reg = AssetRegistry.from([USD, CREDITS, POINTS])
    expect(reg.verify(fixedResolver).ok).toBe(true)
  })
})
