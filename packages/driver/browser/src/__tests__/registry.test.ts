import { describe, expect, it } from "vitest"
import { createBrowserRegistry, makeBrowserProviderLister } from "../index.js"
import { makeFakeProvider } from "./fake-provider.js"

describe("browser registry", () => {
  it("registers, looks up and lists in registration order", () => {
    const a = makeFakeProvider({ id: "alpha" }).provider
    const b = makeFakeProvider({ id: "beta" }).provider
    const registry = createBrowserRegistry()
    registry.register(a)
    registry.register(b)
    expect(registry.has("alpha")).toBe(true)
    expect(registry.get("beta")).toBe(b)
    expect(registry.get("nope")).toBeUndefined()
    expect(registry.list().map((p) => p.id)).toEqual(["alpha", "beta"])
  })

  it("rejects a duplicate id", () => {
    const registry = createBrowserRegistry([makeFakeProvider({ id: "alpha" }).provider])
    expect(() => registry.register(makeFakeProvider({ id: "alpha" }).provider)).toThrow(
      /'alpha' is already registered/,
    )
  })

  it("require throws and names the known ids", () => {
    const registry = createBrowserRegistry([makeFakeProvider({ id: "alpha" }).provider])
    expect(registry.require("alpha").id).toBe("alpha")
    expect(() => registry.require("ghost")).toThrow(/unknown browser provider 'ghost'.*alpha/)
  })

  it("the provider-kit lister lists registered providers without calling check()", async () => {
    let checked = false
    const remote = makeFakeProvider({
      id: "remote",
      location: "remote",
      transport: "http",
      capabilities: { cdp: true },
    }).provider
    const registry = createBrowserRegistry([
      makeFakeProvider({ id: "alpha" }).provider,
      { ...remote, check: async () => ((checked = true), true) },
    ])
    const entries = await makeBrowserProviderLister({ registry })()
    expect(entries.map((e) => [e.slug, e.status])).toEqual([
      ["alpha", "ready"],
      ["remote", "ready"],
    ])
    expect(entries[1]?.info).toMatchObject({
      id: "remote",
      transport: "http",
      location: "remote",
      capabilities: { cdp: true },
    })
    expect(checked).toBe(false)
  })
})
