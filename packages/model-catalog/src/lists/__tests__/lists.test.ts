import { describe, expect, it } from "vitest"
import {
  ModelListError,
  clearModelListCache,
  explainModelList,
  inModelList,
  resolveModelList,
  type ModelList,
  type ModelListSource,
} from "../index.js"

function sourceOf(...lists: ModelList[]): ModelListSource {
  const byId = new Map(lists.map(list => [list.id, list]))
  return { get: id => byId.get(id) }
}

describe("resolveModelList selectors", () => {
  it("matches the access-target vocabulary: model, tag, provider, priceTier, kind", () => {
    const src = sourceOf(
      { id: "m", include: [{ kind: "model", id: "openai/gpt-4o" }] },
      { id: "t", include: [{ kind: "tag", value: "price:zero" }] },
      { id: "p", include: [{ kind: "provider", value: "openai" }] },
      { id: "tier", include: [{ kind: "priceTier", value: "low" }] },
      { id: "k", include: [{ kind: "kind", value: "llm" }] },
    )
    expect(resolveModelList("m", src)).toEqual(["openai/gpt-4o"])
    expect(resolveModelList("t", src)).toContain("opencode/big-pickle")
    expect(resolveModelList("p", src)).toContain("openai/gpt-4o")
    expect(resolveModelList("tier", src)).toContain("gpt-4o-mini")
    expect(resolveModelList("k", src)).toContain("openai/gpt-4o")
  })

  it("matches price, context and variant selectors", () => {
    const src = sourceOf(
      { id: "price", include: [{ kind: "price", maxInPer1M: 0, maxOutPer1M: 0 }] },
      { id: "ctx", include: [{ kind: "context", min: 1_000_000 }] },
      { id: "variant", include: [{ kind: "variant", value: "free" }] },
    )
    expect(resolveModelList("price", src)).toContain("opencode/big-pickle")
    expect(resolveModelList("price", src)).not.toContain("openai/gpt-4o")
    expect(resolveModelList("ctx", src)).toContain("claude-fable-5")
    expect(resolveModelList("ctx", src)).not.toContain("openai/gpt-4o")
    // OpenRouter variants are not separate route-table rows, so membership on
    // a variant-suffixed id is the meaningful assertion.
    expect(
      inModelList("deepseek/deepseek-chat:free@openrouter", "variant", src),
    ).toBe(true)
    expect(
      inModelList("deepseek/deepseek-chat@openrouter", "variant", src),
    ).toBe(false)
  })

  it("composes lists of lists, de-duplicated and in include order", () => {
    const src = sourceOf(
      { id: "a", ids: ["first"] },
      { id: "b", ids: ["second", "first"] },
      { id: "both", include: [{ kind: "list", id: "b" }, { kind: "list", id: "a" }] },
    )
    expect(resolveModelList("both", src)).toEqual(["second", "first"])
  })
})

describe("resolveModelList exclusion and ordering", () => {
  it("exclude wins over include and ids", () => {
    const src = sourceOf({
      id: "list",
      include: [{ kind: "model", id: "openai/gpt-4o" }],
      ids: ["openai/gpt-4o-mini"],
      exclude: [
        { kind: "model", id: "openai/gpt-4o" },
        { kind: "model", id: "openai/gpt-4o-mini" },
      ],
    })
    expect(resolveModelList("list", src)).toEqual([])
  })

  it("a model exclusion also removes an uncataloged ids pin", () => {
    const src = sourceOf({
      id: "pins",
      ids: ["custom/model", "keep/model"],
      exclude: [{ kind: "model", id: "custom/model" }],
    })
    expect(resolveModelList("pins", src)).toEqual(["keep/model"])
    expect(inModelList("custom/model", "pins", src)).toBe(false)
  })

  it("listed keeps insertion order, cheapest / largest-context / newest sort deterministically", () => {
    const src = sourceOf(
      {
        id: "listed",
        ids: ["openai/gpt-4o", "openai/gpt-4o-mini"],
        order: "listed",
      },
      {
        id: "cheapest",
        ids: ["openai/gpt-4o", "openai/gpt-4o-mini"],
        order: "cheapest",
      },
      {
        id: "context",
        ids: ["claude-haiku-4-5", "claude-fable-5"],
        order: "largest-context",
      },
      {
        id: "newest",
        ids: ["opencode/big-pickle", "opencode/glm-5.3-flash-free"],
        order: "newest",
      },
    )
    expect(resolveModelList("listed", src)).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
    ])
    expect(resolveModelList("cheapest", src)[0]).toBe("openai/gpt-4o-mini")
    expect(resolveModelList("context", src)[0]).toBe("claude-fable-5")
    expect(resolveModelList("newest", src)[0]).toBe("opencode/glm-5.3-flash-free")
  })

  it("memoizes subject ids and clears them with the candidate cache", () => {
    const src = sourceOf({ id: "pins", ids: ["custom/model"] })
    expect(inModelList("big-pickle", "pins", src)).toBe(false)
    expect(inModelList("big-pickle", "pins", src)).toBe(false)
    clearModelListCache()
    expect(inModelList("big-pickle", "pins", src)).toBe(false)
    const bare = sourceOf({ id: "bare", ids: ["opencode/big-pickle"] })
    expect(inModelList("big-pickle", "bare", bare)).toBe(true)
    clearModelListCache()
    expect(inModelList("big-pickle", "bare", bare)).toBe(true)
  })

  it("an uncataloged id matches through ids only", () => {
    const src = sourceOf(
      { id: "pins", ids: ["custom/model"] },
      { id: "models", include: [{ kind: "model", id: "openai/gpt-4o" }] },
    )
    expect(inModelList("custom/model", "pins", src)).toBe(true)
    expect(inModelList("custom/model@route", "pins", src)).toBe(true)
    expect(inModelList("custom/model", "models", src)).toBe(false)
  })
})

describe("resolveModelList errors and explanation", () => {
  it("throws ModelListError for an unknown list and for a cycle", () => {
    const src = sourceOf(
      { id: "a", include: [{ kind: "list", id: "b" }] },
      { id: "b", include: [{ kind: "list", id: "a" }] },
    )
    expect(() => resolveModelList("missing", src)).toThrow(ModelListError)
    expect(() => resolveModelList("missing", src)).toThrow(/unknown model list/)
    expect(() => resolveModelList("a", src)).toThrow(ModelListError)
    expect(() => resolveModelList("a", src)).toThrow(/cycle/)
  })

  it("explains the selector or pin that included each model", () => {
    const src = sourceOf({
      id: "zero-cost",
      label: "Zero-cost models",
      include: [{ kind: "tag", value: "price:zero" }],
      ids: ["custom/model"],
    })
    const explained = explainModelList("zero-cost", src)
    expect(explained).toContainEqual({
      model: "opencode/big-pickle",
      via: "tag:price:zero",
    })
    expect(explained).toContainEqual({ model: "custom/model", via: "ids" })
  })
})
