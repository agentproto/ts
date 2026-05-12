import { describe, expect, it, vi } from "vitest"
import { createCatalog } from "../create-catalog.js"
import { CollectionSource } from "../collection-source.js"
import { CatalogSourceDuplicateError, CatalogSourceNotFoundError } from "../errors.js"
import type { CatalogSource } from "../types.js"

type Skill = { id: string; name: string; tags?: string[] }

function makeSource(
  id: string,
  tier: CatalogSource<Skill>["tier"],
  items: Skill[],
): CatalogSource<Skill> {
  return { id, label: id, tier, fetch: async () => items }
}

describe("createCatalog", () => {
  it("returns empty result with no sources", async () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    const result = await catalog.fetch()
    expect(result.items).toEqual([])
    expect(result.errors).toEqual([])
  })

  it("addSource / hasSource / getSources / removeSource", () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    const source = makeSource("builtin", "builtin", [])

    catalog.addSource(source)
    expect(catalog.hasSource("builtin")).toBe(true)
    expect(catalog.getSources()).toHaveLength(1)

    catalog.removeSource("builtin")
    expect(catalog.hasSource("builtin")).toBe(false)
  })

  it("throws CatalogSourceDuplicateError on duplicate id", () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    catalog.addSource(makeSource("a", "builtin", []))
    expect(() => catalog.addSource(makeSource("a", "marketplace", []))).toThrow(
      CatalogSourceDuplicateError,
    )
  })

  it("throws CatalogSourceNotFoundError on removeSource for missing id", () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    expect(() => catalog.removeSource("ghost")).toThrow(CatalogSourceNotFoundError)
  })

  it("merges items from multiple sources", async () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    catalog
      .addSource(makeSource("builtin", "builtin", [{ id: "a", name: "A" }]))
      .addSource(makeSource("market", "marketplace", [{ id: "b", name: "B" }]))

    const result = await catalog.fetch()
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "b"])
  })

  it("deduplicates by key — builtin beats marketplace", async () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    const builtinSkill: Skill = { id: "search", name: "Search (builtin)" }
    const marketSkill: Skill = { id: "search", name: "Search (market)" }

    catalog
      .addSource(makeSource("market", "marketplace", [marketSkill]))
      .addSource(makeSource("builtin", "builtin", [builtinSkill]))

    const result = await catalog.fetch()
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.name).toBe("Search (builtin)")
    expect(result.entries[0]!.alternateSources).toContain("market")
  })

  it("bySource groups winning items by source", async () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    catalog
      .addSource(makeSource("builtin", "builtin", [{ id: "a", name: "A" }]))
      .addSource(makeSource("market", "marketplace", [{ id: "b", name: "B" }]))

    const result = await catalog.fetch()
    expect(result.bySource["builtin"]).toHaveLength(1)
    expect(result.bySource["market"]).toHaveLength(1)
  })

  it("captures errors from failing sources without aborting", async () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    const failing: CatalogSource<Skill> = {
      id: "bad",
      label: "bad",
      tier: "marketplace",
      fetch: async () => { throw new Error("network error") },
    }
    catalog
      .addSource(makeSource("builtin", "builtin", [{ id: "a", name: "A" }]))
      .addSource(failing)

    const result = await catalog.fetch()
    expect(result.items).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.sourceId).toBe("bad")
  })

  it("uses custom keyBy", async () => {
    type BySlug = { slug: string; title: string }
    const catalog = createCatalog<BySlug>({
      family: "test",
      keyBy: (i) => i.slug,
    })
    catalog.addSource({
      id: "a",
      label: "a",
      tier: "builtin",
      fetch: async () => [
        { slug: "foo", title: "Foo v1" },
        { slug: "bar", title: "Bar" },
      ],
    })
    catalog.addSource({
      id: "b",
      label: "b",
      tier: "marketplace",
      fetch: async () => [{ slug: "foo", title: "Foo v2" }],
    })

    const result = await catalog.fetch()
    expect(result.items).toHaveLength(2)
    const foo = result.items.find((i) => i.slug === "foo")
    expect(foo?.title).toBe("Foo v1")
  })
})

describe("CollectionSource", () => {
  it("picks items by explicit picks list", async () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    catalog.addSource(
      makeSource("builtin", "builtin", [
        { id: "search", name: "Search" },
        { id: "write", name: "Write" },
        { id: "read", name: "Read" },
      ]),
    )

    const collection = new CollectionSource<Skill>({
      id: "featured",
      label: "Featured",
      catalog,
      picks: ["search", "read"],
    })

    const items = await collection.fetch()
    expect(items.map((i) => i.id).sort()).toEqual(["read", "search"])
  })

  it("filters items by predicate", async () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    catalog.addSource(
      makeSource("builtin", "builtin", [
        { id: "a", name: "A", tags: ["ai"] },
        { id: "b", name: "B", tags: ["util"] },
        { id: "c", name: "C", tags: ["ai"] },
      ]),
    )

    const collection = new CollectionSource<Skill>({
      id: "ai-skills",
      label: "AI Skills",
      catalog,
      predicate: (item) => item.tags?.includes("ai") ?? false,
    })

    const items = await collection.fetch()
    expect(items.map((i) => i.id).sort()).toEqual(["a", "c"])
  })

  it("exposes tier as collection", () => {
    const catalog = createCatalog<Skill>({ family: "skills" })
    const col = new CollectionSource({ id: "x", label: "x", catalog })
    expect(col.tier).toBe("collection")
  })

  it("can be added as a source to a catalog (registry of collections)", async () => {
    const baseCatalog = createCatalog<Skill>({ family: "skills" })
    baseCatalog.addSource(
      makeSource("builtin", "builtin", [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ]),
    )

    const metaCatalog = createCatalog<Skill>({ family: "skills-meta" })
    metaCatalog.addSource(baseCatalog.getSources()[0]!)
    metaCatalog.addSource(
      new CollectionSource({ id: "featured", label: "Featured", catalog: baseCatalog, picks: ["a"] }),
    )

    const result = await metaCatalog.fetch()
    // "a" appears in builtin and collection — builtin wins dedup
    expect(result.items).toHaveLength(2)
  })
})
