import { describe, expect, it } from "vitest"
import { stripContinuedSuffix } from "../session-continue-fresh.js"

describe("stripContinuedSuffix", () => {
  it("strips the plain legacy tail", () => {
    expect(stripContinuedSuffix("pm-agentproto (continued)")).toBe("pm-agentproto")
  })
  it("strips a numbered legacy tail", () => {
    expect(stripContinuedSuffix("pm-agentproto (continued 3)")).toBe("pm-agentproto")
  })
  it("strips a repeated tail at any depth", () => {
    expect(stripContinuedSuffix("sup (continued) (continued) (continued) (continued)")).toBe("sup")
  })
  it("counts nothing (leaves other labels alone)", () => {
    expect(stripContinuedSuffix("continued-work")).toBe("continued-work")
  })
  it("leaves labels that merely look adjacent", () => {
    expect(stripContinuedSuffix("foo (contested)")).toBe("foo (contested)")
  })
  it("leaves labels without the tail untouched", () => {
    expect(stripContinuedSuffix("pm-agentproto")).toBe("pm-agentproto")
  })
  it("only strips the tail, keeping interior occurrences", () => {
    expect(stripContinuedSuffix("foo (continued) bar")).toBe("foo (continued) bar")
  })
  it("trims the whitespace before the tail", () => {
    expect(stripContinuedSuffix("foo  (continued)")).toBe("foo")
  })
})
