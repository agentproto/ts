import { describe, expect, it } from "vitest"

import { renestCatalog } from "./daemonCompat.js"

const fullRow = {
  vendor: "anthropic",
  product: "claude-opus-4-8",
  route: "anthropic",
  ref: "anthropic/claude-opus-4-8",
  baseUrl: null,
  pricing: { inPer1M: 15, outPer1M: 75 },
  runnable: true,
  eligibleProfiles: ["personal"],
  adapterModes: [],
  adapters: ["claude-code"],
  curated: true,
}

const compactRow = {
  vendor: "moonshot",
  product: "kimi-k2",
  route: "moonshot",
  ref: "moonshot/kimi-k2",
  runnable: true,
  curated: false,
  multiModel: true,
}

describe("renestCatalog", () => {
  it("renests flat rows into the legacy nested tree, preserving order", () => {
    const out = renestCatalog({
      routes: [compactRow, fullRow],
    })
    expect(out.vendors.map(v => v.vendor)).toEqual(["moonshot", "anthropic"])
    expect(out.vendors[0]?.products).toHaveLength(1)
    expect(out.vendors[0]?.products[0]?.routes).toEqual([
      { ...compactRow, baseUrl: null, pricing: null, eligibleProfiles: [], adapterModes: [], adapters: [] },
    ])
    expect(out.vendors[1]?.products[0]?.routes).toEqual([fullRow])
  })

  it("passes an already-nested { vendors: [...] } payload through unchanged", () => {
    const nested = {
      vendors: [
        {
          vendor: "anthropic",
          products: [{ product: "claude-opus-4-8", routes: [fullRow] }],
        },
      ],
    }
    expect(renestCatalog(nested)).toEqual(nested)
  })

  it("default-fills the fields compact rows lack", () => {
    const out = renestCatalog({ routes: [compactRow] })
    const route = out.vendors[0]?.products[0]?.routes[0]!
    expect(route.baseUrl).toBeNull()
    expect(route.pricing).toBeNull()
    expect(route.eligibleProfiles).toEqual([])
    expect(route.adapterModes).toEqual([])
    expect(route.adapters).toEqual([])
    expect(route.route).toBe("moonshot")
    expect(route.ref).toBe("moonshot/kimi-k2")
    expect(route.runnable).toBe(true)
    expect(route.curated).toBe(false)
  })

  it("groups multiple products under one vendor", () => {
    const out = renestCatalog({
      routes: [
        { ...compactRow, product: "kimi-k2" },
        { ...compactRow, product: "kimi-linear" },
      ],
    })
    expect(out.vendors).toHaveLength(1)
    expect(out.vendors[0]?.products.map(p => p.product)).toEqual(["kimi-k2", "kimi-linear"])
  })

  it("groups rows across multiple vendors", () => {
    const out = renestCatalog({
      routes: [
        { ...compactRow, vendor: "moonshot" },
        { ...compactRow, vendor: "openrouter" },
        { ...compactRow, vendor: "moonshot" },
      ],
    })
    expect(out.vendors.map(v => v.vendor)).toEqual(["moonshot", "openrouter"])
    expect(out.vendors[0]?.products[0]?.routes).toHaveLength(2)
    expect(out.vendors[1]?.products[0]?.routes).toHaveLength(1)
  })

  it("is total: empty, undefined, and malformed input → { vendors: [] }", () => {
    expect(renestCatalog({ routes: [] })).toEqual({ vendors: [] })
    expect(renestCatalog(undefined)).toEqual({ vendors: [] })
    expect(renestCatalog(null)).toEqual({ vendors: [] })
    expect(renestCatalog("nope")).toEqual({ vendors: [] })
    expect(renestCatalog({ routes: [42, "x", null] })).toEqual({ vendors: [] })
  })

  it("accepts a bare flat rows array", () => {
    const out = renestCatalog([compactRow])
    expect(out.vendors[0]?.products[0]?.routes).toEqual([
      { ...compactRow, baseUrl: null, pricing: null, eligibleProfiles: [], adapterModes: [], adapters: [] },
    ])
  })

  it("skips malformed rows without losing valid ones", () => {
    const out = renestCatalog({
      routes: [{ vendor: "only" }, compactRow, { product: "only" }],
    })
    expect(out.vendors).toHaveLength(1)
    expect(out.vendors[0]?.vendor).toBe("moonshot")
  })
})
