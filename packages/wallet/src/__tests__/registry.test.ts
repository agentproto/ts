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
  ref: "ACME_CREDITS",
  name: "Acme Credits",
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
  ref: "ACME_POINTS",
  name: "Acme Points",
  symbol: "GPT",
  decimals: 0,
  standard: "internal",
  ruleSet: {
    settleOut: false,
    spendableOn: [],
    transfer: "internal",
    convertEdges: [
      { to: "ACME_CREDITS", rate: { kind: "fixed", ratio: 1 }, addsRestriction: ["from-points"] },
    ],
  },
})

const fixedResolver: RateResolver = e => (e.rate.kind === "fixed" ? e.rate.ratio : 1)

describe("AssetRegistry — config-first catalog (common + app-wide)", () => {
  it("extend layers app assets onto a common set (immutably)", () => {
    const common = AssetRegistry.from([USD])
    const acme = common.extend([CREDITS, POINTS])

    expect(acme.has("USD")).toBe(true)
    expect(acme.has("ACME_CREDITS")).toBe(true)
    expect(common.has("ACME_CREDITS")).toBe(false) // extend did not mutate common
    expect(acme.require("ACME_POINTS").symbol).toBe("GPT")
  })

  it("rejects duplicate refs", () => {
    expect(() => AssetRegistry.from([USD, USD])).toThrow(/already registered/)
  })

  it("verify passes a no-arbitrage catalog (points→credit one-way)", () => {
    const reg = AssetRegistry.from([USD, CREDITS, POINTS])
    expect(reg.verify(fixedResolver).ok).toBe(true)
  })

  it("is the partition catalog: resolves a partition + its policy by id", () => {
    const CREDITS_WITH_TRANCHES = defineAsset({
      ...CREDITS,
      partitions: [
        {
          id: "ACME_CREDITS:image-trial",
          asset: "ACME_CREDITS",
          restriction: [],
          policy: [
            { kind: "spendOn", categories: ["image"] },
            { kind: "expire", at: { kind: "afterGrant", ms: 2_592_000_000 } },
          ],
        },
      ],
    })
    const reg = AssetRegistry.from([USD, CREDITS_WITH_TRANCHES])

    expect(reg.partition("ACME_CREDITS:image-trial")?.asset).toBe("ACME_CREDITS")
    expect(reg.policyFor("ACME_CREDITS:image-trial")?.[0]).toEqual({
      kind: "spendOn",
      categories: ["image"],
    })
    // unknown partition / asset without the tranche → undefined (a valid resolver)
    expect(reg.policyFor("ACME_CREDITS:nope")).toBeUndefined()
    expect(reg.policyFor("USD:general")).toBeUndefined()
  })
})
