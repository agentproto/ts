import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { runTool } from "@agentproto/driver"
import {
  stylePairwiseTool,
  makeStylePairwiseDriver,
  pairwiseWinRate,
  type PairwiseVerdict,
  type JudgeFn,
} from "../index.js"

describe("eval.style-pairwise — runTool", () => {
  it("maps a judge verdict.value >= 0.5 to a-wins", async () => {
    const judge: JudgeFn = async () => ({ value: 0.9, rationale: "a is closer" })
    const driver = makeStylePairwiseDriver(judge)
    const score = await runTool({
      tool: stylePairwiseTool,
      candidates: [driver],
      input: { reference: "ref", a: "candidate a", b: "candidate b", criteria: "closer to ref?" },
    })
    expect(score.label).toBe("style-pairwise")
    expect(score.value).toBe(0.9)
    expect(score.passed).toBe(true)
    expect(score.rationale).toBe("a is closer")
  })

  it("maps a judge verdict.value < 0.5 to b-wins", async () => {
    const judge: JudgeFn = async () => ({ value: 0.1 })
    const driver = makeStylePairwiseDriver(judge)
    const score = await runTool({
      tool: stylePairwiseTool,
      candidates: [driver],
      input: { reference: "ref", a: "candidate a", b: "candidate b", criteria: "closer to ref?" },
    })
    expect(score.passed).toBe(false)
  })

  it("passes reference/a/b through to the judge as output", async () => {
    const seen: unknown[] = []
    const judge: JudgeFn = async ({ output }) => {
      seen.push(output)
      return { value: 0.5 }
    }
    const driver = makeStylePairwiseDriver(judge)
    await runTool({
      tool: stylePairwiseTool,
      candidates: [driver],
      input: { reference: "R", a: "A", b: "B", criteria: "c" },
    })
    expect(seen[0]).toEqual({ reference: "R", a: "A", b: "B" })
  })

  it("fails the score (no throw) when the judge returns a malformed verdict", async () => {
    // Cast through unknown: JudgeFn is caller-injected and only nominally
    // typed — this simulates a misbehaving judge at the runtime boundary.
    const judge = (async () => ({ value: Number.NaN })) as unknown as JudgeFn
    const driver = makeStylePairwiseDriver(judge)
    const score = await runTool({
      tool: stylePairwiseTool,
      candidates: [driver],
      input: { reference: "ref", a: "A", b: "B", criteria: "c" },
    })
    expect(score.passed).toBe(false)
    expect(score.value).toBe(0)
    expect(score.rationale).toMatch(/malformed/u)
  })
})

function verdict(item: string, judge: string, order: "normal" | "swapped", winner: "a" | "b" | "tie"): PairwiseVerdict {
  return { item, judge, order, winner }
}

describe("pairwiseWinRate", () => {
  it("gives kappa = 1 when two judges agree perfectly on the same items", () => {
    const verdicts: PairwiseVerdict[] = [
      verdict("item-1", "j1", "normal", "a"),
      verdict("item-1", "j2", "normal", "a"),
      verdict("item-2", "j1", "normal", "b"),
      verdict("item-2", "j2", "normal", "b"),
      verdict("item-3", "j1", "normal", "tie"),
      verdict("item-3", "j2", "normal", "tie"),
      verdict("item-4", "j1", "normal", "a"),
      verdict("item-4", "j2", "normal", "a"),
    ]
    const result = pairwiseWinRate(verdicts)
    expect(result.kappa).toBeCloseTo(1, 10)
    expect(result.n).toBe(8)
  })

  it("gives kappa close to 0 for chance-level agreement", () => {
    // Deterministic pseudo-random categorical sequences: j1 cycles a/b/tie
    // every 3, j2 cycles a/b/tie every 7 — mutually out of phase over a
    // large sample, so observed agreement tracks the chance rate. Both
    // judges rate the same item at each step.
    const categories: Array<"a" | "b" | "tie"> = ["a", "b", "tie"]
    const verdicts: PairwiseVerdict[] = []
    const n = 900
    for (let i = 0; i < n; i++) {
      const item = `item-${i}`
      verdicts.push(verdict(item, "j1", "normal", categories[i % 3]!))
      verdicts.push(verdict(item, "j2", "normal", categories[i % 7 % 3]!))
    }
    const result = pairwiseWinRate(verdicts)
    expect(result.kappa).not.toBeNull()
    expect(Math.abs(result.kappa!)).toBeLessThan(0.2)
  })

  it("returns kappa = null with a single judge", () => {
    const verdicts: PairwiseVerdict[] = [
      verdict("item-1", "j1", "normal", "a"),
      verdict("item-2", "j1", "normal", "b"),
    ]
    const result = pairwiseWinRate(verdicts)
    expect(result.kappa).toBeNull()
  })

  it("returns kappa = null when two judges rated disjoint items (fewer than 2 in common)", () => {
    const verdicts: PairwiseVerdict[] = [
      verdict("item-1", "j1", "normal", "a"),
      verdict("item-2", "j1", "normal", "b"),
      verdict("item-3", "j2", "normal", "a"),
      verdict("item-4", "j2", "normal", "b"),
    ]
    const result = pairwiseWinRate(verdicts)
    expect(result.kappa).toBeNull()
  })

  it("joins by item — a common item is one observation even with normal+swapped duplicates", () => {
    // j1 rates item-1 twice (normal + swapped, both un-swap to "a"); j2 rates
    // it once. Only item-1 and item-2 are common, so kappa needs both — the
    // duplicate must not be double-counted as a second common item.
    const verdicts: PairwiseVerdict[] = [
      verdict("item-1", "j1", "normal", "a"),
      verdict("item-1", "j1", "swapped", "b"), // unswaps to "a" — same observation as above
      verdict("item-1", "j2", "normal", "a"),
      verdict("item-2", "j1", "normal", "b"),
      verdict("item-2", "j2", "normal", "b"),
    ]
    const result = pairwiseWinRate(verdicts)
    expect(result.kappa).toBeCloseTo(1, 10)
  })

  it("neutralizes a judge with pure position bias into a ~0.5 win rate", () => {
    // This judge always reports "a" — i.e. always the physically-first
    // option — regardless of content, so raw winner === order's "normal"-ness.
    const verdicts: PairwiseVerdict[] = [
      verdict("item-1", "j1", "normal", "a"),
      verdict("item-2", "j1", "swapped", "a"),
      verdict("item-3", "j1", "normal", "a"),
      verdict("item-4", "j1", "swapped", "a"),
    ]
    const result = pairwiseWinRate(verdicts)
    expect(result.winRate).toBeCloseTo(0.5, 10)
    expect(result.balanced).toBe(true)
    expect(result.nNormal).toBe(2)
    expect(result.nSwapped).toBe(2)
  })

  it("computes winRate directly (no bias) counting ties as 0.5", () => {
    const verdicts: PairwiseVerdict[] = [
      verdict("item-1", "j1", "normal", "a"),
      verdict("item-2", "j1", "normal", "a"),
      verdict("item-3", "j1", "normal", "b"),
      verdict("item-4", "j1", "normal", "tie"),
    ]
    const result = pairwiseWinRate(verdicts)
    // (1 + 1 + 0 + 0.5) / 4
    expect(result.winRate).toBeCloseTo(2.5 / 4, 10)
  })

  it("flags balanced: false and reports nNormal/nSwapped when an order is entirely missing", () => {
    const verdicts: PairwiseVerdict[] = [
      verdict("item-1", "j1", "normal", "a"),
      verdict("item-2", "j1", "normal", "a"),
      verdict("item-3", "j1", "normal", "a"),
    ]
    const result = pairwiseWinRate(verdicts)
    expect(result.balanced).toBe(false)
    expect(result.nNormal).toBe(3)
    expect(result.nSwapped).toBe(0)
    // No swapped data to de-bias against — winRate falls back to the normal-only rate.
    expect(result.winRate).toBeCloseTo(1, 10)
  })

  it("returns n=0 / winRate=0 / kappa=null for an empty input", () => {
    const result = pairwiseWinRate([])
    expect(result).toEqual({ winRate: 0, kappa: null, n: 0, nNormal: 0, nSwapped: 0, balanced: false })
  })
})

describe("style/ carries no network import", () => {
  it("never calls fetch( anywhere under src/style/", () => {
    const styleDir = path.dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/u, "style")
    const offenders: string[] = []
    for (const file of readdirSync(styleDir)) {
      if (!file.endsWith(".ts")) continue
      const contents = readFileSync(path.join(styleDir, file), "utf8")
      if (contents.includes("fetch(")) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
