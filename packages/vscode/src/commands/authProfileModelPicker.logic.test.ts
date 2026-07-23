/**
 * Pure picker logic (authProfileModelPicker.logic.ts) — the WS4 "+" picker /
 * chip toggle → `setAuthProfileModels` mapping. Fails on `main` (the module
 * doesn't exist there) and on Track A alone (this is the WS4 writer).
 */

import { describe, it, expect } from "vitest"
import type { CatalogProviderModel } from "../client/types.js"
import {
  buildModelPickItems,
  modelPriceLabel,
  resolveModelSelection,
  toggleModelInAllowlist,
} from "./authProfileModelPicker.logic.js"

const llm = (id: string, inP = 3, outP = 15): CatalogProviderModel => ({
  id,
  kind: "llm",
  label: id, // LLM label == id
  route: "anthropic",
  pricing: { inPer1M: inP, outPer1M: outP },
})

const media = (id: string, name: string): CatalogProviderModel => ({
  id,
  kind: "image",
  label: name, // media carries a distinct display name
  route: "replicate",
  pricing: null,
})

describe("modelPriceLabel", () => {
  it("formats LLM per-1M pricing and blanks the media kinds", () => {
    expect(modelPriceLabel(llm("claude-opus-4-8", 15, 75))).toBe("$15/$75 per 1M")
    expect(modelPriceLabel(media("nano-banana", "Nano Banana"))).toBe("")
  })
})

describe("buildModelPickItems", () => {
  it("pre-checks the current allowlist and sorts picked-first then by id", () => {
    const models = [llm("claude-sonnet-5"), llm("claude-opus-4-8"), llm("claude-haiku-4-5")]
    const items = buildModelPickItems(models, ["claude-opus-4-8"])
    // opus is picked → first; the rest alphabetical.
    expect(items.map(i => i.id)).toEqual([
      "claude-opus-4-8",
      "claude-haiku-4-5",
      "claude-sonnet-5",
    ])
    expect(items.find(i => i.id === "claude-opus-4-8")?.picked).toBe(true)
    expect(items.find(i => i.id === "claude-sonnet-5")?.picked).toBe(false)
  })

  it("carries the id in description only when the label differs (media), route+price in detail", () => {
    const [image] = buildModelPickItems([media("google/nano-banana", "Nano Banana")], [])
    expect(image?.label).toBe("Nano Banana")
    expect(image?.description).toBe("google/nano-banana") // searchable id
    expect(image?.detail).toBe("replicate")

    const [model] = buildModelPickItems([llm("claude-opus-4-8", 15, 75)], [])
    // LLM label already IS the id, so no redundant description.
    expect(model?.description).toBeUndefined()
    expect(model?.detail).toBe("anthropic · $15/$75 per 1M")
  })

  it("writes exactly the read tool's id — never a reshaped ref (openrouter form preserved)", () => {
    const items = buildModelPickItems(
      [{ id: "z-ai/glm-5.2", kind: "llm", label: "z-ai/glm-5.2", route: "openrouter", pricing: null }],
      [],
    )
    expect(items[0]?.id).toBe("z-ai/glm-5.2")
  })
})

describe("resolveModelSelection", () => {
  it("a non-empty selection narrows to allow(ids), deduped + sorted", () => {
    expect(resolveModelSelection(["b", "a", "b"])).toEqual({ mode: "allow", ids: ["a", "b"] })
  })

  it("an empty selection clears the allowlist to allow-all (never empty-allow)", () => {
    expect(resolveModelSelection([])).toEqual({ mode: "all", ids: [] })
  })
})

describe("toggleModelInAllowlist", () => {
  it("adds an id not yet present", () => {
    expect(toggleModelInAllowlist(["a"], "b")).toEqual({ mode: "allow", ids: ["a", "b"] })
  })

  it("removes an id already present", () => {
    expect(toggleModelInAllowlist(["a", "b"], "a")).toEqual({ mode: "allow", ids: ["b"] })
  })

  it("reverts to allow-all when the last curated id is removed", () => {
    expect(toggleModelInAllowlist(["a"], "a")).toEqual({ mode: "all", ids: [] })
  })
})
