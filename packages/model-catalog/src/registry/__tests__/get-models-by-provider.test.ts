/**
 * `getModelsByProvider` — router-aware provider enumeration.
 *
 * OpenRouter's routes are already folded into `LLM_PRICING_CATALOG` (bare
 * `vendor/product` ids), so the router-table pass must add zero net new
 * entries there. Requesty and HuggingFace have no such overlap, so their
 * generated route tables are the only source and must show up in full
 * (minus the handful of keys `listRouterLlmRoutes` can't express as a ref).
 */

import { describe, it, expect } from "vitest"
import { getModelsByProvider } from "../index.js"

describe("getModelsByProvider — router awareness", () => {
  it("widens Requesty from empty to its route table surface", () => {
    const models = getModelsByProvider("requesty")
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(m => m.kind === "llm")).toBe(true)
    expect(models.some(m => m.id.endsWith("@requesty"))).toBe(true)
  })

  it("widens HuggingFace from empty to its route table surface", () => {
    const models = getModelsByProvider("huggingface")
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(m => m.kind === "llm")).toBe(true)
    expect(models.some(m => m.id.endsWith("@huggingface"))).toBe(true)
  })

  it("does not regress or duplicate OpenRouter's existing bare-id surface", () => {
    const models = getModelsByProvider("openrouter")
    expect(models.length).toBeGreaterThan(100)
    const ids = models.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    // The pre-existing bare-id surface stays bare — no `@openrouter`-suffixed
    // duplicate of an id already served through LLM_PRICING_CATALOG.
    expect(models.every(m => !m.id.endsWith("@openrouter"))).toBe(true)
  })

  it("returns an empty list for an unknown provider, never throws", () => {
    expect(() => getModelsByProvider("no-such-provider-xyz")).not.toThrow()
    expect(getModelsByProvider("no-such-provider-xyz")).toEqual([])
  })
})
