import { describe, expect, it } from "vitest"
import { definePack } from "../pack.js"
import { resolve } from "../resolve.js"
import type { Layer } from "../types.js"

type Role = "triage" | "speak" | "deepThink"

const pack = definePack<Role>({
  id: "simone",
  label: "Simone",
  keyspace: "role",
  routes: {
    triage: { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
    speak: { model: "kimi-k2.6" },
    deepThink: null,
  },
})

describe("resolve — §3 layers and precedence", () => {
  it("falls through to the pack when no layer has an opinion", () => {
    expect(resolve(pack, "speak", [])).toEqual({
      model: "kimi-k2.6",
      key: "speak",
      source: "pack",
    })
  })

  it("reports which layer won — source is normative (§3)", () => {
    const override: Layer<Role> = { source: "override", entries: { triage: { model: "o3-pro" } } }
    const env: Layer<Role> = { source: "env", entries: { triage: { model: "gpt-4o" } } }
    // override listed first ⇒ highest precedence
    const resolved = resolve(pack, "triage", [override, env])
    expect(resolved?.source).toBe("override")
    expect(resolved?.model).toBe("o3-pro")
  })

  it("env wins over pack, override wins over env — full three-layer stack", () => {
    const envOnly = resolve(pack, "triage", [{ source: "env", entries: { triage: { model: "gpt-4o" } } }])
    expect(envOnly).toMatchObject({ model: "gpt-4o", source: "env" })

    const both = resolve(pack, "triage", [
      { source: "override", entries: { triage: { model: "o3-pro" } } },
      { source: "env", entries: { triage: { model: "gpt-4o" } } },
    ])
    expect(both).toMatchObject({ model: "o3-pro", source: "override" })
  })

  it("custom layers beyond override/env/pack are expressible and reported by name (§3)", () => {
    const tierLayer: Layer<Role> = { source: "tier:enterprise", entries: { speak: { model: "gpt-5.5" } } }
    const resolved = resolve(pack, "speak", [tierLayer])
    expect(resolved?.source).toBe("tier:enterprise")
  })
})

describe("resolve — §4 null is a non-overridable capability gate", () => {
  it("a gated key resolves to null with no layers", () => {
    expect(resolve(pack, "deepThink", [])).toBeNull()
  })

  it("a catch-all MUST NOT re-enable a key the pack gated to null", () => {
    const catchAllOnly: Layer<Role> = { source: "override", catchAll: { model: "gpt-4o" } }
    expect(resolve(pack, "deepThink", [catchAllOnly])).toBeNull()
    // and the catch-all still applies normally to a non-gated key
    expect(resolve(pack, "speak", [catchAllOnly])).toMatchObject({ model: "gpt-4o", source: "override" })
  })

  it("only a layer naming the key EXPLICITLY may re-enable it", () => {
    const named: Layer<Role> = { source: "override", entries: { deepThink: { model: "o3-pro" } } }
    expect(resolve(pack, "deepThink", [named])).toMatchObject({ model: "o3-pro", source: "override" })
  })

  it("a catch-all at a lower layer is also blocked by a gate set at a higher layer", () => {
    // env explicitly re-enables deepThink...
    const env: Layer<Role> = { source: "env", entries: { deepThink: { model: "gpt-4o" } } }
    // ...but an override catch-all above it must not stomp that re-enable with a blanket default,
    // UNLESS the override also gates it explicitly.
    const overrideCatchAll: Layer<Role> = { source: "override", catchAll: { model: "claude-sonnet-5" } }
    expect(resolve(pack, "deepThink", [overrideCatchAll, env])).toMatchObject({
      model: "claude-sonnet-5",
      source: "override",
    })

    const overrideGate: Layer<Role> = { source: "override", entries: { deepThink: null } }
    expect(resolve(pack, "deepThink", [overrideGate, env])).toBeNull()
  })
})

describe("resolve — extra route metadata (verified capability fields, §1) passes through", () => {
  interface RouteWithLimits {
    model: string
    provider?: string
    contextWindow?: number
  }

  it("carries fields beyond the base Route shape end to end", () => {
    const p = definePack<"a", RouteWithLimits>({
      id: "p",
      label: "P",
      keyspace: "model",
      routes: { a: { model: "claude-fable-5", provider: "anthropic", contextWindow: 200000 } },
    })
    expect(resolve(p, "a", [])).toMatchObject({ contextWindow: 200000 })
  })
})
