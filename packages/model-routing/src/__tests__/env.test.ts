import { describe, expect, it } from "vitest"
import { envKeySuffix, envLayer, parseRouteRef } from "../env.js"

describe("envKeySuffix", () => {
  it("matches the original envSuffix() examples verbatim", () => {
    expect(envKeySuffix("triage-inline")).toBe("TRIAGE_INLINE")
    expect(envKeySuffix("speak")).toBe("SPEAK")
    expect(envKeySuffix("deepThink")).toBe("DEEP_THINK")
  })
})

describe("parseRouteRef", () => {
  it("splits a known provider: prefix", () => {
    expect(parseRouteRef("anthropic:claude-sonnet-5", ["anthropic", "openai"])).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    })
  })

  it("leaves a value with no known provider prefix whole", () => {
    expect(parseRouteRef("kimi-k2.6", ["anthropic", "openai"])).toEqual({ model: "kimi-k2.6" })
  })

  it("does not split on a colon-free slash id (OpenRouter-shaped)", () => {
    expect(parseRouteRef("anthropic/claude-3-5-sonnet-20241022", ["openrouter"])).toEqual({
      model: "anthropic/claude-3-5-sonnet-20241022",
    })
  })
})

describe("envLayer", () => {
  it("is pure: reading process.env happens at the call site, not inside the builder", () => {
    const env = { ROUTER_TRIAGE_MODEL: "gpt-4o" }
    const layer = envLayer("ROUTER", ["triage", "speak"], env)
    expect(layer).toEqual({
      source: "env",
      entries: { triage: { model: "gpt-4o" } },
    })
  })

  it("builds a catchAll from the DEFAULT suffix unless disabled", () => {
    const layer = envLayer("ROUTER", ["triage"], { ROUTER_DEFAULT_MODEL: "gpt-4o-mini" })
    expect(layer.catchAll).toEqual({ model: "gpt-4o-mini" })

    const disabled = envLayer("ROUTER", ["triage"], { ROUTER_DEFAULT_MODEL: "gpt-4o-mini" }, { catchAllSuffix: null })
    expect(disabled.catchAll).toBeUndefined()
  })
})
