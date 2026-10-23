import { describe, expect, it } from "vitest"
import { listModels } from "@agentproto/model-catalog"
import { inModelList } from "@agentproto/model-catalog/lists"
import {
  formatModelRef,
  listRouterLlmRoutes,
} from "@agentproto/model-catalog/route-identity"
import { seedModelListSource, ZERO_COST_LIST_ID } from "../model-list-store.js"

/**
 * The old runtime predicate, copied verbatim from origin/main
 * (`turn-retry-policy.ts`, `isOpencodeFreeModel`) as the comparison fixture.
 */
function oldIsOpencodeFreeModel(model: string): boolean {
  const id = (model.split("@")[0] ?? model).split("/").pop()?.toLowerCase() ?? ""
  return id === "big-pickle" || id.endsWith("-free")
}

const ROUTERS = ["openrouter", "requesty", "huggingface", "opencode", "opencode-go"] as const

function catalogPricing(): Map<string, { inputPer1M: number; outputPer1M: number } | undefined> {
  const all = new Map<string, { inputPer1M: number; outputPer1M: number } | undefined>()
  for (const model of listModels({ kind: "llm" })) {
    all.set(model.id, model.kind === "llm" ? model.pricing : undefined)
  }
  for (const router of ROUTERS) {
    for (const route of listRouterLlmRoutes(router)) {
      const id = formatModelRef(route.ref)
      if (!all.has(id)) all.set(id, route.pricing)
    }
  }
  return all
}

const source = seedModelListSource()

describe("zero-cost list equivalence with the old free predicate", () => {
  it("classifies every catalog LLM id the same way, except zero-priced ids with no -free suffix", () => {
    const all = catalogPricing()
    const regressions: string[] = []
    const unexplained: string[] = []
    const differences: string[] = []

    for (const [id, pricing] of all) {
      const oldVerdict = oldIsOpencodeFreeModel(id)
      const newVerdict = inModelList(id, ZERO_COST_LIST_ID, source)
      if (oldVerdict === newVerdict) continue
      differences.push(id)
      const zero = pricing?.inputPer1M === 0 && pricing?.outputPer1M === 0
      // A model that used to be free must never stop being zero-cost.
      if (oldVerdict && !zero) regressions.push(id)
      // Every new inclusion must be a zero-priced catalog entry. This adapts
      // to catalog regeneration instead of hardcoding today's ids.
      if (!oldVerdict && !zero) unexplained.push(id)
    }

    expect(regressions).toEqual([])
    expect(unexplained).toEqual([])
    for (const id of differences) {
      const pricing = all.get(id)
      expect(pricing?.inputPer1M === 0 && pricing.outputPer1M === 0, id).toBe(true)
    }
  })

  it("resolves the bare and @route-suffixed forms the same as the old predicate", () => {
    for (const form of [
      "big-pickle",
      "glm-5.3-flash-free",
      "opencode/big-pickle",
      "opencode-go/minimax-m3.1-flash-free@opencode",
      "opencode/glm-5.3-flash-free@opencode",
    ]) {
      expect(inModelList(form, ZERO_COST_LIST_ID, source), form).toBe(
        oldIsOpencodeFreeModel(form),
      )
    }
  })

  it("a zero-priced id without the suffix is now in the list, and fails the old predicate", () => {
    const id = "prism-ml/Ternary-Bonsai-27B-AWQ-4bit@huggingface"
    expect(oldIsOpencodeFreeModel(id)).toBe(false)
    expect(inModelList(id, ZERO_COST_LIST_ID, source)).toBe(true)
  })
})
