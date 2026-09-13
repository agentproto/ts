import { describe, expect, it } from "vitest"
import { definePack, overlay } from "../pack.js"

describe("definePack", () => {
  it("is total over its keyspace — every declared key has a Route or an explicit null", () => {
    const pack = definePack({
      id: "p",
      label: "P",
      keyspace: "role",
      routes: {
        triage: { model: "haiku" },
        deepThink: null,
      },
    })
    expect(pack.routes.triage).toEqual({ model: "haiku" })
    expect(pack.routes.deepThink).toBeNull()
  })
})

describe("overlay", () => {
  const base = definePack({
    id: "base",
    label: "Base",
    keyspace: "model",
    routes: {
      "kimi-k3": { model: "kimi-k3", provider: "moonshot" },
      "gpt-4o": { model: "gpt-4o", provider: "openai" },
    },
  })

  it("replaces only the patched keys — the provider-outage lever (§2)", () => {
    const patched = overlay(base, {
      id: "base-failover",
      label: "Base (moonshot down)",
      routes: {
        "kimi-k3": { model: "kimi-k3", provider: "openrouter" },
      },
    })
    expect(patched.routes["kimi-k3"]).toEqual({ model: "kimi-k3", provider: "openrouter" })
    // untouched key survives unchanged
    expect(patched.routes["gpt-4o"]).toEqual({ model: "gpt-4o", provider: "openai" })
    // base itself is untouched — overlay does not mutate
    expect(base.routes["kimi-k3"]).toEqual({ model: "kimi-k3", provider: "moonshot" })
  })

  it("keeps the base keyspace", () => {
    const patched = overlay(base, { id: "x", label: "X", routes: {} })
    expect(patched.keyspace).toBe("model")
  })

  it("can gate a key via overlay too — an overlay entry is just another Pack entry", () => {
    const patched = overlay(base, {
      id: "gated",
      label: "Gated",
      routes: { "gpt-4o": null },
    })
    expect(patched.routes["gpt-4o"]).toBeNull()
  })
})
