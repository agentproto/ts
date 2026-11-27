import { afterEach, describe, expect, it } from "vitest"
import {
  registerCatalogOverlay,
  clearCatalogOverlays,
} from "../index.js"
import { ANTHROPIC_GENERATED_PRICING } from "../../llm/anthropic-pricing.generated.js"
import { getModel, resolveAlias, listModels } from "../../registry/index.js"

// A core LLM id taken from the synced Anthropic table as it is, so a sync that
// retires a model cannot break the overlay tests.
const CORE_ID = (() => {
  const id = Object.keys(ANTHROPIC_GENERATED_PRICING).find(k => !k.includes(".") && getModel(k))
  if (!id) throw new Error("no resolvable Anthropic id in the synced tables")
  return id
})()

afterEach(() => clearCatalogOverlays())

describe("consumer catalog overlay", () => {
  it("adds a consumer alias that resolves to a core model", () => {
    // pick a real core LLM id
    const anthropicId = CORE_ID
    const before = getModel("legacy-opus")
    expect(before).toBeUndefined()

    registerCatalogOverlay({ aliases: { "legacy-opus": anthropicId } })

    const after = getModel("legacy-opus")
    expect(after?.kind).toBe("llm")
    // id echoes the requested alias; canonical points at the core id
    expect(after?.id).toBe("legacy-opus")
    expect(after && after.kind === "llm" ? after.canonicalId : null).toBe(
      anthropicId,
    )
    expect(resolveAlias("legacy-opus")).toBe(anthropicId)
  })

  it("adds a brand-new overlay LLM entry and lists it", () => {
    registerCatalogOverlay({
      llm: {
        "acme/private-1": {
          inputPer1M: 1,
          outputPer1M: 2,
          provider: "acme",
        } as never,
      },
    })
    const m = getModel("acme/private-1")
    expect(m?.kind).toBe("llm")
    const listed = listModels({ kind: "llm" }).some(
      x => x.id === "acme/private-1",
    )
    expect(listed).toBe(true)
  })

  it("overlay entry overrides a core entry with the same id (no dupes in list)", () => {
    const coreId = CORE_ID
    registerCatalogOverlay({
      llm: { [coreId]: { inputPer1M: 999, outputPer1M: 999, provider: "anthropic" } as never },
    })
    const m = getModel(coreId)
    expect(m && m.kind === "llm" ? m.pricing?.inputPer1M : null).toBe(999)
    const occurrences = listModels({ kind: "llm" }).filter(x => x.id === coreId)
    expect(occurrences).toHaveLength(1)
  })

  it("alias chains collapse and cycles don't hang", () => {
    registerCatalogOverlay({
      aliases: { a: "b", b: CORE_ID, x: "y", y: "x" },
    })
    expect(resolveAlias("a")).toBe(CORE_ID)
    // x→y→x cycle: resolves to a terminal without infinite loop
    expect(() => resolveAlias("x")).not.toThrow()
  })

  it("clearCatalogOverlays resets state", () => {
    registerCatalogOverlay({ aliases: { foo: CORE_ID } })
    expect(getModel("foo")).toBeDefined()
    clearCatalogOverlays()
    expect(getModel("foo")).toBeUndefined()
  })
})
