import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { OPENCODE_ZEN_ROUTES } from "../../llm/opencode-zen-routes.generated.js"
import { CONTEXT_WINDOWS } from "../../llm/context-windows.generated.js"
import { clearCatalogOverlays, registerCatalogOverlay } from "../../overlay/index.js"
import { listModels } from "../../registry/index.js"
import {
  ModelListError,
  clearModelListCache,
  explainModelList,
  inModelList,
  resolveModelList,
  type ModelList,
  type ModelListSource,
} from "../index.js"

// Selector subjects are overlay fixtures, not real models: the generated
// tables are rewritten by every catalog sync, so a real id/price/provider
// pinned here would break when the sync retires or reprices it. The context
// and "newest" selectors read synced data (context windows, addedAt), so
// their subjects are picked from the tables as they are.
const ZERO = "fixtureprov/zero-llm"
const CHEAP = "fixtureprov/cheap-llm"
const PRICEY = "fixtureprov/pricey-llm"
const PROVIDER = "fixtureprov"

beforeEach(() => {
  registerCatalogOverlay({
    llm: {
      [ZERO]: { inputPer1M: 0, outputPer1M: 0, provider: PROVIDER, vendor: "fixture" } as never,
      [CHEAP]: { inputPer1M: 0.15, outputPer1M: 0.6, provider: PROVIDER, vendor: "fixture" } as never,
      [PRICEY]: { inputPer1M: 5, outputPer1M: 15, provider: PROVIDER, vendor: "fixture" } as never,
    },
  })
  clearModelListCache()
})
afterEach(() => {
  clearCatalogOverlays()
  clearModelListCache()
})

/** A cataloged id whose synced window is ≥ 1M, and one below it. */
function contextSubjects(): { big: string; small: string } {
  const ids = new Set(listModels({ kind: "llm" }).map(m => m.id))
  const known = Object.entries(CONTEXT_WINDOWS).filter(([id]) => ids.has(id))
  const big = known.find(([, e]) => e.contextWindow >= 1_000_000)?.[0]
  const small = known.find(([, e]) => e.contextWindow < 1_000_000)?.[0]
  if (!big || !small) throw new Error("synced tables expose no big/small context pair")
  return { big, small }
}

function sourceOf(...lists: ModelList[]): ModelListSource {
  const byId = new Map(lists.map(list => [list.id, list]))
  return { get: id => byId.get(id) }
}

describe("resolveModelList selectors", () => {
  it("matches the access-target vocabulary: model, tag, provider, priceTier, kind", () => {
    const src = sourceOf(
      { id: "m", include: [{ kind: "model", id: PRICEY }] },
      { id: "t", include: [{ kind: "tag", value: "price:zero" }] },
      { id: "p", include: [{ kind: "provider", value: PROVIDER }] },
      { id: "tier", include: [{ kind: "priceTier", value: "low" }] },
      { id: "k", include: [{ kind: "kind", value: "llm" }] },
    )
    expect(resolveModelList("m", src)).toEqual([PRICEY])
    expect(resolveModelList("t", src)).toContain(ZERO)
    expect(resolveModelList("p", src)).toEqual(expect.arrayContaining([ZERO, CHEAP, PRICEY]))
    expect(resolveModelList("tier", src)).toContain(CHEAP)
    expect(resolveModelList("k", src)).toContain(PRICEY)
  })

  it("matches price, context and variant selectors", () => {
    const src = sourceOf(
      { id: "price", include: [{ kind: "price", maxInPer1M: 0, maxOutPer1M: 0 }] },
      { id: "ctx", include: [{ kind: "context", min: 1_000_000 }] },
      { id: "variant", include: [{ kind: "variant", value: "free" }] },
    )
    const { big, small } = contextSubjects()
    expect(resolveModelList("price", src)).toContain(ZERO)
    expect(resolveModelList("price", src)).not.toContain(PRICEY)
    expect(resolveModelList("ctx", src)).toContain(big)
    expect(resolveModelList("ctx", src)).not.toContain(small)
    // OpenRouter variants are not separate route-table rows, so membership on
    // a variant-suffixed id is the meaningful assertion.
    expect(
      inModelList(`${PRICEY}:free@openrouter`, "variant", src),
    ).toBe(true)
    expect(
      inModelList(`${PRICEY}@openrouter`, "variant", src),
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
      include: [{ kind: "model", id: PRICEY }],
      ids: [CHEAP],
      exclude: [
        { kind: "model", id: PRICEY },
        { kind: "model", id: CHEAP },
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
    // "newest" reads the synced addedAt dates: pick the oldest and newest
    // distinct rows from the table as it is, so retirements/backfills never
    // pin this test to an id. The guard keeps the assertion non-vacuous.
    const dated = Object.entries(OPENCODE_ZEN_ROUTES)
      .filter(([, r]) => (r as { addedAt?: string }).addedAt)
      .map(([id, r]) => [id, (r as { addedAt: string }).addedAt] as const)
      .sort((x, y) => x[1].localeCompare(y[1]))
    const pinOlder = dated[0]![0]
    const pinNewer = dated[dated.length - 1]![0]
    expect(dated[dated.length - 1]![1] > dated[0]![1]).toBe(true)
    const { big, small } = contextSubjects()
    const src = sourceOf(
      { id: "listed", ids: [PRICEY, CHEAP], order: "listed" },
      { id: "cheapest", ids: [PRICEY, CHEAP], order: "cheapest" },
      { id: "context", ids: [small, big], order: "largest-context" },
      { id: "newest", ids: [pinOlder, pinNewer], order: "newest" },
    )
    expect(resolveModelList("listed", src)).toEqual([PRICEY, CHEAP])
    expect(resolveModelList("cheapest", src)[0]).toBe(CHEAP)
    expect(resolveModelList("context", src)[0]).toBe(big)
    expect(resolveModelList("newest", src)[0]).toBe(pinNewer)
  })

  it("memoizes subject ids and clears them with the candidate cache", () => {
    const src = sourceOf({ id: "pins", ids: ["custom/model"] })
    const full = Object.keys(OPENCODE_ZEN_ROUTES)[0]!
    const bareId = full.replace(/^opencode\//, "")
    expect(inModelList(bareId, "pins", src)).toBe(false)
    expect(inModelList(bareId, "pins", src)).toBe(false)
    clearModelListCache()
    expect(inModelList(bareId, "pins", src)).toBe(false)
    const bare = sourceOf({ id: "bare", ids: [full] })
    expect(inModelList(bareId, "bare", bare)).toBe(true)
    clearModelListCache()
    expect(inModelList(bareId, "bare", bare)).toBe(true)
  })

  it("an uncataloged id matches through ids only", () => {
    const src = sourceOf(
      { id: "pins", ids: ["custom/model"] },
      { id: "models", include: [{ kind: "model", id: PRICEY }] },
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
      model: ZERO,
      via: "tag:price:zero",
    })
    expect(explained).toContainEqual({ model: "custom/model", via: "ids" })
  })
})
