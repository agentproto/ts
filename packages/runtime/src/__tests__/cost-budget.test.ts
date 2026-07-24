import { describe, it, expect } from "vitest"
import { evaluateCostBudget } from "../cost-budget.js"
import type { CostBudget } from "@agentproto/auth"

const budget = (maxCostUsd: number): CostBudget => ({
  maxCostUsd,
  window: "5h",
  scope: "session",
})

describe("evaluateCostBudget", () => {
  it("under budget → not tripped, zero overage", () => {
    const d = evaluateCostBudget({ budget: budget(10), spentUsd: 4 })
    expect(d.tripped).toBe(false)
    expect(d.overageUsd).toBe(0)
    expect(d.spentUsd).toBe(4)
    expect(d.maxCostUsd).toBe(10)
    expect(d.window).toBe("5h")
    expect(d.scope).toBe("session")
  })

  it("exactly AT the cap → not tripped (strict >), zero overage", () => {
    const d = evaluateCostBudget({ budget: budget(10), spentUsd: 10 })
    expect(d.tripped).toBe(false)
    expect(d.overageUsd).toBe(0)
  })

  it("over budget → tripped, overage is spend minus cap", () => {
    const d = evaluateCostBudget({ budget: budget(10), spentUsd: 12.5 })
    expect(d.tripped).toBe(true)
    expect(d.overageUsd).toBeCloseTo(2.5, 10)
  })

  it("zero spend against a positive cap → not tripped", () => {
    const d = evaluateCostBudget({ budget: budget(10), spentUsd: 0 })
    expect(d.tripped).toBe(false)
    expect(d.overageUsd).toBe(0)
  })

  it("zero cap with any positive spend → tripped, overage equals spend", () => {
    const d = evaluateCostBudget({ budget: budget(0), spentUsd: 3 })
    expect(d.tripped).toBe(true)
    expect(d.overageUsd).toBe(3)
  })

  it("echoes the profile scope + window verbatim", () => {
    const d = evaluateCostBudget({
      budget: { maxCostUsd: 50, window: "P7D", scope: "profile" },
      spentUsd: 51,
    })
    expect(d.tripped).toBe(true)
    expect(d.scope).toBe("profile")
    expect(d.window).toBe("P7D")
  })
})
