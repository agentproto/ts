/**
 * Route-identity parser, formatter, and resolver tests.
 *
 * Coverage:
 *   - parser/formatting, valid and invalid inputs
 *   - implicit route (route = vendor) vs explicit route
 *   - direct vendor route vs OpenRouter route disambiguation
 *   - custom route config validation and resolution
 *   - legacy bare-id compatibility
 *   - ambiguity diagnostics
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  parseModelRef,
  formatModelRef,
  isModelRefString,
  InvalidModelRefError,
  resolveLlmModelRoute,
  registerCustomRoute,
  clearCustomRoutes,
  diagnoseModelRef,
  type ModelRef,
  type CustomRouteConfig,
} from "../index.js"

describe("parseModelRef", () => {
  it("parses vendor/product with implicit route = vendor", () => {
    const ref = parseModelRef("openai/gpt-4o")
    expect(ref).toEqual({
      raw: "openai/gpt-4o",
      vendor: "openai",
      product: "gpt-4o",
      route: "openai",
    })
  })

  it("parses vendor/product@route with explicit route", () => {
    const ref = parseModelRef("openai/gpt-4o@openrouter")
    expect(ref).toEqual({
      raw: "openai/gpt-4o@openrouter",
      vendor: "openai",
      product: "gpt-4o",
      route: "openrouter",
    })
  })

  it("parses custom proxy route", () => {
    const ref = parseModelRef("openai/gpt-4o@agentik-proxy")
    expect(ref.route).toBe("agentik-proxy")
  })

  it("trims whitespace", () => {
    const ref = parseModelRef("  openai/gpt-4o@openrouter  ")
    expect(ref.vendor).toBe("openai")
    expect(ref.product).toBe("gpt-4o")
    expect(ref.route).toBe("openrouter")
  })

  it("accepts dots, underscores, and hyphens in segments", () => {
    expect(() => parseModelRef("anthropic/claude-sonnet-4.5")).not.toThrow()
    expect(() => parseModelRef("meta-llama/llama-3.1-8b")).not.toThrow()
    expect(() => parseModelRef("openai/gpt-4o@some_route")).not.toThrow()
  })

  it("rejects empty input", () => {
    expect(() => parseModelRef("")).toThrow(InvalidModelRefError)
  })

  it("rejects unscoped xx@yy form", () => {
    expect(() => parseModelRef("gpt-4o@openrouter")).toThrow(InvalidModelRefError)
    expect(() => parseModelRef("gpt-4o@openrouter")).toThrow(
      /unscoped @ route is not allowed/
    )
  })

  it("rejects missing vendor or product", () => {
    expect(() => parseModelRef("/gpt-4o")).toThrow(InvalidModelRefError)
    expect(() => parseModelRef("openai/")).toThrow(InvalidModelRefError)
    expect(() => parseModelRef("gpt-4o")).toThrow(InvalidModelRefError)
  })

  it("rejects segments containing /", () => {
    expect(() => parseModelRef("openai/gpt/4o")).toThrow(InvalidModelRefError)
  })
})

describe("formatModelRef", () => {
  it("omits route suffix for implicit direct route", () => {
    const ref: ModelRef = {
      raw: "openai/gpt-4o",
      vendor: "openai",
      product: "gpt-4o",
      route: "openai",
    }
    expect(formatModelRef(ref)).toBe("openai/gpt-4o")
  })

  it("includes route suffix for explicit route", () => {
    const ref: ModelRef = {
      raw: "openai/gpt-4o@openrouter",
      vendor: "openai",
      product: "gpt-4o",
      route: "openrouter",
    }
    expect(formatModelRef(ref)).toBe("openai/gpt-4o@openrouter")
  })
})

describe("isModelRefString", () => {
  it("returns true for canonical refs", () => {
    expect(isModelRefString("openai/gpt-4o")).toBe(true)
    expect(isModelRefString("openai/gpt-4o@openrouter")).toBe(true)
  })

  it("returns false for bare ids and invalid forms", () => {
    expect(isModelRefString("gpt-4o")).toBe(false)
    expect(isModelRefString("gpt-4o@openrouter")).toBe(false)
    expect(isModelRefString("")).toBe(false)
  })
})

describe("resolveLlmModelRoute", () => {
  beforeEach(() => {
    clearCustomRoutes()
  })

  it("resolves direct vendor route for openai/gpt-4o", () => {
    const route = resolveLlmModelRoute("openai/gpt-4o")
    expect(route).toBeDefined()
    expect(route!.vendor).toBe("openai")
    expect(route!.product).toBe("gpt-4o")
    expect(route!.route).toBe("openai")
    expect(route!.transport.flavor).toBe("openai")
    expect(route!.pricing.provider).toBe("openai")
    expect(route!.pricing.vendor).toBe("openai")
  })

  it("direct route uses canonical product id after alias resolution", () => {
    const route = resolveLlmModelRoute("openai/gpt-5.4")
    expect(route).toBeDefined()
    expect(route!.canonicalProductId).toBe("gpt-5.4")
  })

  it("resolves distinct OpenRouter route for openai/gpt-4o@openrouter", () => {
    const direct = resolveLlmModelRoute("openai/gpt-4o")
    const openrouter = resolveLlmModelRoute("openai/gpt-4o@openrouter")
    expect(openrouter).toBeDefined()
    expect(openrouter!.route).toBe("openrouter")
    expect(openrouter!.transport.flavor).toBe("openrouter")
    expect(openrouter!.pricing.provider).toBe("openrouter")
    // OpenRouter route pricing may differ from direct; here it is the same
    // value in the fixture, but the resolved objects are distinct routes.
    expect(openrouter!.pricing).not.toBe(direct!.pricing)
  })

  it("returns undefined for unknown OpenRouter route", () => {
    const route = resolveLlmModelRoute("openai/nonexistent-model@openrouter")
    expect(route).toBeUndefined()
  })

  it("resolves distinct Requesty route for openai/gpt-4.1@requesty", () => {
    const direct = resolveLlmModelRoute("openai/gpt-4.1")
    const requesty = resolveLlmModelRoute("openai/gpt-4.1@requesty")
    expect(requesty).toBeDefined()
    expect(requesty!.route).toBe("requesty")
    expect(requesty!.transport.flavor).toBe("requesty")
    expect(requesty!.pricing.provider).toBe("requesty")
    expect(requesty!.pricing).not.toBe(direct!.pricing)
  })

  it("prices a Requesty-only model that has no direct vendor route", () => {
    // sference/* is served only via Requesty, so the bare ref is unresolvable
    // while the routed ref prices — the case the @route suffix exists for.
    expect(
      resolveLlmModelRoute("sference/thinkingcap-qwen3.6-27b")
    ).toBeUndefined()
    const routed = resolveLlmModelRoute(
      "sference/thinkingcap-qwen3.6-27b@requesty"
    )
    expect(routed).toBeDefined()
    expect(routed!.pricing.inputPer1M).toBe(0.4)
    expect(routed!.pricing.outputPer1M).toBe(3)
  })

  it("keeps the direct vendor route unchanged by the Requesty table", () => {
    // Regression guard: REQUESTY_ROUTES must not be spread into
    // LLM_PRICING_CATALOG, or a bare openai/gpt-4.1 would silently pick up
    // Requesty's router pricing.
    const direct = resolveLlmModelRoute("openai/gpt-4.1")
    expect(direct).toBeDefined()
    expect(direct!.route).toBe("openai")
    expect(direct!.pricing.provider).not.toBe("requesty")
  })

  it("returns undefined for unknown Requesty route", () => {
    const route = resolveLlmModelRoute("openai/nonexistent-model@requesty")
    expect(route).toBeUndefined()
  })

  it("resolves registered custom route", () => {
    const config: CustomRouteConfig = {
      label: "Operator proxy",
      flavor: "openai",
      baseUrl: "http://localhost:8080/v1",
      authEnv: "AGENTIK_PROXY_API_KEY",
      availability: "preview",
      limits: { contextWindow: 128_000 },
      pricing: { inputPer1M: 1.0, outputPer1M: 2.0 },
    }
    registerCustomRoute("agentik-proxy", config)

    const route = resolveLlmModelRoute("openai/gpt-4o@agentik-proxy")
    expect(route).toBeDefined()
    expect(route!.route).toBe("agentik-proxy")
    expect(route!.transport.flavor).toBe("openai")
    expect(route!.transport.baseUrl).toBe("http://localhost:8080/v1")
    expect(route!.availability).toBe("preview")
    expect(route!.limits.contextWindow).toBe(128_000)
    expect(route!.pricing.inputPer1M).toBe(1.0)
    expect(route!.pricing.outputPer1M).toBe(2.0)
  })

  it("custom route falls back to product pricing when no override given", () => {
    registerCustomRoute("agentik-proxy", { flavor: "openai" })
    const route = resolveLlmModelRoute("openai/gpt-4o@agentik-proxy")
    expect(route).toBeDefined()
    expect(route!.pricing.inputPer1M).toBe(2.5)
    expect(route!.pricing.outputPer1M).toBe(10.0)
    expect(route!.pricing.provider).toBe("openai")
  })

  it("returns undefined for unregistered custom route", () => {
    const route = resolveLlmModelRoute("openai/gpt-4o@unknown-proxy")
    expect(route).toBeUndefined()
  })

  it("preserves legacy bare id compatibility", () => {
    const route = resolveLlmModelRoute("gpt-4o")
    expect(route).toBeDefined()
    expect(route!.vendor).toBe("openai")
    expect(route!.product).toBe("gpt-4o")
    expect(route!.route).toBe("openai")
    expect(route!.ref.raw).toBe("gpt-4o")
  })

  it("returns undefined for unknown bare id", () => {
    const route = resolveLlmModelRoute("totally-unknown-model-xyz")
    expect(route).toBeUndefined()
  })

  it("accepts a pre-parsed ModelRef", () => {
    const ref = parseModelRef("anthropic/claude-sonnet-4.5@openrouter")
    const route = resolveLlmModelRoute(ref)
    expect(route).toBeDefined()
    expect(route!.vendor).toBe("anthropic")
    expect(route!.route).toBe("openrouter")
  })
})

describe("diagnoseModelRef", () => {
  beforeEach(() => {
    clearCustomRoutes()
  })

  it("reports direct and OpenRouter availability for ambiguous vendor/product", () => {
    const diag = diagnoseModelRef("openai/gpt-4o")
    expect(diag).toBeDefined()
    expect(diag!.directAvailable).toBe(true)
    expect(diag!.openRouterAvailable).toBe(true)
    expect(diag!.customRouteAvailable).toBe(false)
    expect(diag!.note).toContain("@openrouter")
  })

  it("reports legacy bare id note", () => {
    const diag = diagnoseModelRef("gpt-4o")
    expect(diag).toBeDefined()
    expect(diag!.legacyBareId).toBe(true)
    expect(diag!.note).toContain("legacy form")
  })

  it("reports custom route availability", () => {
    registerCustomRoute("agentik-proxy", { flavor: "openai" })
    const diag = diagnoseModelRef("openai/gpt-4o@agentik-proxy")
    expect(diag).toBeDefined()
    expect(diag!.customRouteAvailable).toBe(true)
  })

  it("returns undefined for unknown bare id", () => {
    const diag = diagnoseModelRef("unknown-model-xyz")
    expect(diag).toBeUndefined()
  })
})
