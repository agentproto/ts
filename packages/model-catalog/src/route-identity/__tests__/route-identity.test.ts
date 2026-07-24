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
 *   - :pin grammar (variant vs inferenceProvider) and the legacy route: prefix
 *   - tryParseModelRef (never-throw)
 *   - HuggingFace route resolution (pinned provider vs cheapest-live pricing)
 */

import { describe, it, expect, beforeEach } from "vitest"
import {
  parseModelRef,
  tryParseModelRef,
  formatModelRef,
  stripRouteSuffix,
  isModelRefString,
  InvalidModelRefError,
  resolveLlmModelRoute,
  registerCustomRoute,
  clearCustomRoutes,
  diagnoseModelRef,
  OPENROUTER_VARIANTS,
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

describe("parseModelRef — :pin grammar", () => {
  it("classifies a closed-list suffix as variant on the implicit route", () => {
    const ref = parseModelRef("deepseek/deepseek-chat:free")
    expect(ref.vendor).toBe("deepseek")
    expect(ref.product).toBe("deepseek-chat")
    expect(ref.route).toBe("deepseek")
    expect(ref.variant).toBe("free")
    expect(ref.inferenceProvider).toBeUndefined()
  })

  it("classifies every OPENROUTER_VARIANTS entry as variant on @openrouter", () => {
    for (const variant of OPENROUTER_VARIANTS) {
      const ref = parseModelRef(`deepseek/deepseek-chat:${variant}@openrouter`)
      expect(ref.variant).toBe(variant)
      expect(ref.inferenceProvider).toBeUndefined()
    }
  })

  it("classifies a non-variant suffix as inferenceProvider on @openrouter", () => {
    const ref = parseModelRef("openai/gpt-4o:azure@openrouter")
    expect(ref.inferenceProvider).toBe("azure")
    expect(ref.variant).toBeUndefined()
  })

  it("classifies any suffix as inferenceProvider on a non-openrouter route (huggingface)", () => {
    const ref = parseModelRef("meta-llama/Llama-3.1-8B:cerebras@huggingface")
    expect(ref.route).toBe("huggingface")
    expect(ref.inferenceProvider).toBe("cerebras")
    expect(ref.variant).toBeUndefined()
  })

  it("classifies a variant-named suffix as inferenceProvider on a non-openrouter route", () => {
    // "free" is only a variant in OpenRouter's context — on huggingface it's
    // just an (unusual) provider pin.
    const ref = parseModelRef("meta-llama/Llama-3.1-8B:free@huggingface")
    expect(ref.inferenceProvider).toBe("free")
    expect(ref.variant).toBeUndefined()
  })

  it("rejects an empty pin", () => {
    expect(() => parseModelRef("openai/gpt-4o:")).toThrow(InvalidModelRefError)
  })
})

describe("parseModelRef — legacy route: prefix", () => {
  it("parses the legacy prefix form to the same vendor/product/route as @route", () => {
    const prefixed = parseModelRef("openrouter:anthropic/claude-sonnet-4.5")
    const suffixed = parseModelRef("anthropic/claude-sonnet-4.5@openrouter")
    expect({ ...prefixed, raw: undefined }).toEqual({ ...suffixed, raw: undefined })
    expect(prefixed.route).toBe("openrouter")
  })

  it("combines prefix and pin", () => {
    const ref = parseModelRef("openrouter:deepseek/deepseek-chat:free")
    expect(ref.route).toBe("openrouter")
    expect(ref.variant).toBe("free")
  })

  it("@route wins over the legacy prefix on conflict", () => {
    const ref = parseModelRef("openrouter:openai/gpt-4o@requesty")
    expect(ref.route).toBe("requesty")
  })

  it("does not treat an unknown prefix as a route (colon stays embedded, segment invalid)", () => {
    expect(() => parseModelRef("totallyunknown:openai/gpt-4o")).toThrow(
      InvalidModelRefError
    )
  })

  it("formatModelRef always emits the canonical suffix form, never the prefix", () => {
    const ref = parseModelRef("openrouter:anthropic/claude-sonnet-4.5")
    expect(formatModelRef(ref)).toBe("anthropic/claude-sonnet-4.5@openrouter")
  })
})

describe("tryParseModelRef", () => {
  it("returns the same ModelRef as parseModelRef for valid input", () => {
    expect(tryParseModelRef("openai/gpt-4o@openrouter")).toEqual(
      parseModelRef("openai/gpt-4o@openrouter")
    )
  })

  it("returns undefined instead of throwing for invalid input", () => {
    expect(tryParseModelRef("gpt-4o")).toBeUndefined()
    expect(tryParseModelRef("")).toBeUndefined()
    expect(tryParseModelRef("gpt-4o@openrouter")).toBeUndefined()
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

  it("includes the pin between product and route", () => {
    const ref: ModelRef = {
      raw: "deepseek/deepseek-chat:free@openrouter",
      vendor: "deepseek",
      product: "deepseek-chat",
      route: "openrouter",
      variant: "free",
    }
    expect(formatModelRef(ref)).toBe("deepseek/deepseek-chat:free@openrouter")
  })

  it("includes an inferenceProvider pin with no route suffix when route === vendor", () => {
    const ref: ModelRef = {
      raw: "meta-llama/Llama-3.1-8B:cerebras",
      vendor: "meta-llama",
      product: "Llama-3.1-8B",
      route: "meta-llama",
      inferenceProvider: "cerebras",
    }
    expect(formatModelRef(ref)).toBe("meta-llama/Llama-3.1-8B:cerebras")
  })

  it("round-trips through parseModelRef (idempotent)", () => {
    const original = "meta-llama/Llama-3.1-8B:cerebras@huggingface"
    const ref = parseModelRef(original)
    expect(formatModelRef(ref)).toBe(original)
    expect(parseModelRef(formatModelRef(ref))).toEqual(ref)
  })
})

describe("stripRouteSuffix", () => {
  it("strips the gateway @route suffix from a canonical ref (OpenRouter form)", () => {
    expect(stripRouteSuffix("z-ai/glm-5.2@openrouter")).toBe("z-ai/glm-5.2")
  })

  it("strips @requesty while keeping vendor/product", () => {
    expect(stripRouteSuffix("sference/glm-5.2@requesty")).toBe("sference/glm-5.2")
  })

  it("keeps the pin (variant) but drops the route", () => {
    expect(stripRouteSuffix("deepseek/deepseek-chat:free@openrouter")).toBe(
      "deepseek/deepseek-chat:free",
    )
  })

  it("keeps an inferenceProvider pin but drops the route", () => {
    expect(stripRouteSuffix("meta-llama/Llama-3.1-8B:cerebras@huggingface")).toBe(
      "meta-llama/Llama-3.1-8B:cerebras",
    )
  })

  it("strips a trailing @route from a vendor-less proxy alias the strict grammar rejects", () => {
    // `glm-5.2@llm-endpoint` has no vendor slash → parseModelRef rejects it;
    // the naive-but-safe last-`@` fallback still bares it (the SEGMENT grammar
    // forbids `@` anywhere but the route separator).
    expect(stripRouteSuffix("glm-5.2@llm-endpoint")).toBe("glm-5.2")
  })

  it("leaves a bare native model id unchanged (no route)", () => {
    expect(stripRouteSuffix("claude-opus-4-8")).toBe("claude-opus-4-8")
  })

  it("leaves a direct vendor/product route unchanged (route === vendor)", () => {
    expect(stripRouteSuffix("openai/gpt-4o")).toBe("openai/gpt-4o")
  })

  it("is idempotent — a stripped id re-strips to itself", () => {
    const bare = stripRouteSuffix("z-ai/glm-5.2@openrouter")
    expect(stripRouteSuffix(bare)).toBe(bare)
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

  // ── llm-endpoint built-in proxy route (PR-5) ──────────────────────────────
  // The runtime registers this route at daemon boot via `registerBuiltinRoutes`
  // (packages/runtime/src/builtin-routes.ts) with the SAME config asserted here,
  // derived from the `llm-endpoint` gateway preset. model-catalog can't depend
  // on the runtime (wrong direction), so these tests register it directly — the
  // route-identity contract the runtime relies on.
  const LLM_ENDPOINT_CONFIG: CustomRouteConfig = {
    label: "LLM Endpoint",
    flavor: "anthropic",
    baseUrl: "http://localhost:18090",
    authEnv: "LLM_ENDPOINT_API_KEY",
  }

  it("resolves a curated <vendor>/<product>@llm-endpoint ref (Anthropic surface)", () => {
    registerCustomRoute("llm-endpoint", LLM_ENDPOINT_CONFIG)
    const route = resolveLlmModelRoute("moonshot/kimi-k2.7-code@llm-endpoint")
    expect(route).toBeDefined()
    expect(route!.route).toBe("llm-endpoint")
    expect(route!.vendor).toBe("moonshot")
    expect(route!.product).toBe("kimi-k2.7-code")
    expect(route!.transport.flavor).toBe("anthropic")
    expect(route!.transport.baseUrl).toBe("http://localhost:18090")
    expect(route!.availability).toBe("available")
  })

  it("resolves a routeless product on @llm-endpoint via DEFAULT_PRICING", () => {
    // A product with NO direct pricing catalog entry ("routeless") still
    // resolves through the custom route — the custom branch falls back to
    // DEFAULT_PRICING rather than dropping the ref, so the proxy can serve
    // upstreams the catalog has never priced.
    registerCustomRoute("llm-endpoint", LLM_ENDPOINT_CONFIG)
    const route = resolveLlmModelRoute("acme/no-such-model-xyz@llm-endpoint")
    expect(route).toBeDefined()
    expect(route!.route).toBe("llm-endpoint")
    expect(route!.transport.flavor).toBe("anthropic")
    expect(route!.transport.baseUrl).toBe("http://localhost:18090")
    expect(route!.pricing.inputPer1M).toBe(0.15)
    expect(route!.pricing.outputPer1M).toBe(0.6)
  })

  it("returns undefined for a @llm-endpoint ref when the route is unregistered", () => {
    // No registerCustomRoute this test (beforeEach cleared the map) → the ref
    // does not resolve, proving the built-in registration is load-bearing.
    const route = resolveLlmModelRoute("moonshot/kimi-k2.7-code@llm-endpoint")
    expect(route).toBeUndefined()
  })

  it("returns undefined for an unregistered @bogus-route even alongside llm-endpoint", () => {
    registerCustomRoute("llm-endpoint", LLM_ENDPOINT_CONFIG)
    expect(resolveLlmModelRoute("moonshot/kimi-k2.7-code@bogus-route")).toBeUndefined()
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

  // "google/gemma-4-31B-it" (real committed snapshot row, verified
  // 2026-07-18): 5 live providers — novita/together/deepinfra priced +
  // context 262144, cerebras/featherless-ai live but sparse (no
  // pricing/context at all).
  describe("HuggingFace route", () => {
    it("prices from the cheapest live provider when no inferenceProvider pin is given", () => {
      const route = resolveLlmModelRoute("google/gemma-4-31B-it@huggingface")
      expect(route).toBeDefined()
      expect(route!.route).toBe("huggingface")
      expect(route!.transport).toEqual({
        flavor: "openai",
        baseUrl: "https://router.huggingface.co/v1",
      })
      expect(route!.pricing.provider).toBe("huggingface")
      expect(route!.pricing.vendor).toBe("google")
      // deepinfra (0.13 + 0.38 = 0.51) undercuts novita (0.54) and together (1.36).
      expect(route!.pricing.inputPer1M).toBe(0.13)
      expect(route!.pricing.outputPer1M).toBe(0.38)
      expect(route!.limits.contextWindow).toBe(262144)
    })

    it("prices from the pinned inferenceProvider when the pin is a priced provider", () => {
      const route = resolveLlmModelRoute("google/gemma-4-31B-it:novita@huggingface")
      expect(route).toBeDefined()
      expect(route!.pricing.inputPer1M).toBe(0.14)
      expect(route!.pricing.outputPer1M).toBe(0.4)
      expect(route!.limits.contextWindow).toBe(262144)
    })

    it("falls back to default pricing and no context limit for a pinned sparse provider", () => {
      // cerebras is live but carries no pricing/context_length for this model.
      const route = resolveLlmModelRoute("google/gemma-4-31B-it:cerebras@huggingface")
      expect(route).toBeDefined()
      expect(route!.pricing.provider).toBe("huggingface")
      expect(route!.limits.contextWindow).toBeUndefined()
    })

    it("returns undefined when the pinned inferenceProvider does not serve the model", () => {
      const route = resolveLlmModelRoute("google/gemma-4-31B-it:groq@huggingface")
      expect(route).toBeUndefined()
    })

    it("returns undefined for an unknown HuggingFace model", () => {
      const route = resolveLlmModelRoute(
        "totally-unknown-org/totally-unknown-model@huggingface"
      )
      expect(route).toBeUndefined()
    })
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
