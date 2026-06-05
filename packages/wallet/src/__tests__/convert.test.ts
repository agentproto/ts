import { describe, it, expect } from "vitest"
import { planConvert, verifyNoArbitrage, type RateResolver } from "../convert.js"
import type { AssetDeclaration, ConvertEdge } from "../asset.js"
import { canonical } from "../restriction-lattice.js"

const POINTS: AssetDeclaration = {
  ref: "GUILDE_POINTS",
  name: "Guilde Points",
  symbol: "GPT",
  decimals: 0,
  standard: "internal",
  ruleSet: {
    settleOut: false,
    spendableOn: [],
    transfer: "none",
    convertEdges: [
      { to: "GUILDE_CREDITS", rate: { kind: "fixed", ratio: 1 }, addsRestriction: ["from-points"] },
    ],
  },
}

const CREDIT: AssetDeclaration = {
  ref: "GUILDE_CREDITS",
  name: "Guilde Credits",
  symbol: "GCR",
  decimals: 2,
  standard: "internal",
  ruleSet: { settleOut: false, spendableOn: ["*"], transfer: "internal", convertEdges: [] },
}

const fixedResolver: RateResolver = edge =>
  edge.rate.kind === "fixed" ? edge.rate.ratio : 1

describe("convert — inter-asset edge", () => {
  it("scales across decimals and accumulates restriction at the meet", () => {
    const edge = POINTS.ruleSet.convertEdges[0]!
    const delta = planConvert({
      fromAsset: POINTS,
      toAsset: CREDIT,
      edge,
      amount: 200, // 200 points (decimals 0)
      sourceRestriction: canonical(["loyalty"]),
      majorRate: 1, // 1 point major = 1 credit major
    })
    expect(delta.outAmount).toBe(200)
    expect(delta.inAmount).toBe(20000) // 200.00 credits in centicredits
    expect(delta.inRestriction).toEqual(["from-points", "loyalty"])
  })
})

describe("verifyNoArbitrage", () => {
  const mkPair = (aToB: number, bToA: number): AssetDeclaration[] => {
    const A: AssetDeclaration = {
      ref: "ASSET_A",
      name: "A",
      symbol: "A",
      decimals: 2,
      standard: "internal",
      ruleSet: {
        settleOut: false,
        spendableOn: ["*"],
        transfer: "internal",
        convertEdges: [{ to: "ASSET_B", rate: { kind: "fixed", ratio: aToB } } as ConvertEdge],
      },
    }
    const B: AssetDeclaration = {
      ref: "ASSET_B",
      name: "B",
      symbol: "B",
      decimals: 2,
      standard: "internal",
      ruleSet: {
        settleOut: false,
        spendableOn: ["*"],
        transfer: "internal",
        convertEdges: [{ to: "ASSET_A", rate: { kind: "fixed", ratio: bToA } } as ConvertEdge],
      },
    }
    return [A, B]
  }

  it("passes a value-preserving round trip (product == 1)", () => {
    const res = verifyNoArbitrage(mkPair(0.5, 2.0), fixedResolver)
    expect(res.ok).toBe(true)
  })

  it("flags a profitable cycle (product > 1)", () => {
    const res = verifyNoArbitrage(mkPair(0.5, 2.5), fixedResolver)
    expect(res.ok).toBe(false)
    expect(res.cycle).toBeDefined()
    expect(res.cycle!.length).toBeGreaterThan(0)
  })

  it("passes a single non-cyclic edge (points→credit, no way back)", () => {
    const res = verifyNoArbitrage([POINTS, CREDIT], fixedResolver)
    expect(res.ok).toBe(true)
  })
})
