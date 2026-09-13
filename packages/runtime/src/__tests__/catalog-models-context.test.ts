/**
 * `buildCatalogModels` surfaces the live-synced context window / max output
 * on every `CatalogRoute` row (formatted `1M`/`200k`, null when the id is
 * carried by no synced provider). All CONTEXT_WINDOWS providers — Anthropic,
 * Groq, xAI, Moonshot, Mistral, Google — flow through, not just Anthropic.
 */

import { describe, it, expect } from "vitest"
import { buildCatalogModels, type CatalogAdapterInput } from "../catalog-models.js"
import { registerBuiltinRoutes } from "../builtin-routes.js"

registerBuiltinRoutes()

const CLAUDE_CODE: CatalogAdapterInput = {
  slug: "claude-code",
  models: [{ id: "claude-opus-4-8" }],
  authDescriptor: { provider: "anthropic" },
}

const MOONSHOT_ROUTED: CatalogAdapterInput = {
  slug: "claude-code",
  models: [{ id: "moonshot/kimi-k2.7-code", mode: "moonshot" }],
  authDescriptor: { provider: "anthropic" },
}

const XAI_DIRECT: CatalogAdapterInput = {
  slug: "hermes",
  models: [{ id: "grok-4.5" }],
  authDescriptor: { provider: "xai" },
}

const UNKNOWN_ID: CatalogAdapterInput = {
  slug: "hermes",
  models: [{ id: "totally-unknown-model" }],
  authDescriptor: { provider: "openai" },
}

function findRoute(
  response: ReturnType<typeof buildCatalogModels>,
  vendor: string,
  product: string,
  route: string,
) {
  const v = response.vendors.find(x => x.vendor === vendor)
  const p = v?.products.find(x => x.product === product)
  return p?.routes.find(r => r.route === route)
}

describe("buildCatalogModels — contextWindow/maxOutput on route rows", () => {
  it("a direct Anthropic row carries its live-synced window (1M / 128k)", () => {
    const response = buildCatalogModels({ adapters: [CLAUDE_CODE], profiles: [] })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.contextWindow).toBe("1M")
    expect(route?.maxOutput).toBe("128k")
  })

  it("a gateway-routed moonshot row carries the window from the row's own product id", () => {
    const response = buildCatalogModels({ adapters: [MOONSHOT_ROUTED], profiles: [] })
    const route = findRoute(response, "moonshot", "kimi-k2.7-code", "moonshot")
    expect(route?.contextWindow).toBe("262.1k")
    // Moonshot's models list publishes no completion cap for this id.
    expect(route?.maxOutput).toBeNull()
  })

  it("an xAI row carries its window — CONTEXT_WINDOWS coverage is not Anthropic-only", () => {
    const response = buildCatalogModels({ adapters: [XAI_DIRECT], profiles: [] })
    const route = findRoute(response, "xai", "grok-4.5", "xai")
    expect(route).toBeDefined()
    expect(route?.contextWindow).toBe("500k")
  })

  it("an id no synced provider carries reports nulls on both fields", () => {
    const response = buildCatalogModels({ adapters: [UNKNOWN_ID], profiles: [] })
    // A fully unrecognized id falls through resolveModelId's last resort
    // (vendorFromIdPrefix ?? "unknown") — vendor AND route both land on
    // "unknown", not on the adapter's authDescriptor.provider ("openai"
    // here), which resolveModelId never consults.
    const route = findRoute(response, "unknown", "totally-unknown-model", "unknown")
    expect(route).toBeDefined()
    expect(route?.contextWindow).toBeNull()
    expect(route?.maxOutput).toBeNull()
  })
})
