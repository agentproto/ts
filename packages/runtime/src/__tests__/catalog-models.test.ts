/**
 * `buildCatalogModels` (catalog-models.ts) — the pure join behind the
 * read-only catalog/vendor endpoint (SPEC §5, `GET /catalog/models` +
 * `catalog_models`). Every assertion here fails on `main`: the module,
 * its exports, and this whole vendor/product/route join don't exist yet.
 */

import { describe, it, expect } from "vitest"
import type { AuthProfile } from "@agentproto/auth"
import { buildCatalogModels, type CatalogAdapterInput } from "../catalog-models.js"

const CLAUDE_CODE: CatalogAdapterInput = {
  slug: "claude-code",
  models: [{ id: "claude-opus-4-8" }],
  // Direct-route billing-auth capability (spawn-defaults.ts's
  // AdapterAuthDescriptor shape): a fixed anthropic provider + subscription
  // support, mirroring the real claude-code manifest facts the auth
  // package's eligibility fixtures already document.
  authDescriptor: {
    provider: "anthropic",
    authSubscription: { setEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
  },
}

const HERMES: CatalogAdapterInput = {
  slug: "hermes",
  models: [{ id: "anthropic/claude-opus-4-8" }],
  // hermes presents api-key only — never oauth-bearer (SPEC §1c).
  authDescriptor: { provider: "anthropic" },
}

// A Moonshot-built model (Kimi K2), reached through claude-code's
// `moonshot` adapter mode — the mode id happens to equal the model's own
// resolved vendor here, which is exactly the case `isDirectRoute` must
// still classify as a gateway redirection, not a direct route (SPEC §1c).
const MOONSHOT_ROUTED: CatalogAdapterInput = {
  slug: "claude-code",
  models: [{ id: "moonshot/kimi-k2.7-code", mode: "moonshot" }],
  authDescriptor: { provider: "anthropic", authSubscription: { setEnv: "x" } },
}

const anthropicOauth: AuthProfile = {
  id: "jeremy-max",
  endpoint: "anthropic",
  method: "oauth-bearer",
  credentialRef: "ref-oauth",
}
const anthropicApiKey: AuthProfile = {
  id: "work-anthropic-key",
  endpoint: "anthropic",
  method: "api-key",
  credentialRef: "ref-api-key",
}
const moonshotApiKey: AuthProfile = {
  id: "personal-moonshot",
  endpoint: "moonshot",
  method: "api-key",
  credentialRef: "ref-moonshot",
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

describe("buildCatalogModels — runnable is profile-aware (SPEC §5.3)", () => {
  it("runnable:true with an eligible profile attached", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [anthropicOauth],
    })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toEqual(["jeremy-max"])
  })

  it("runnable:false with zero profiles configured — the old bare hasKey check is subsumed, not just true/false on a bare key", () => {
    const response = buildCatalogModels({ adapters: [CLAUDE_CODE], profiles: [] })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.runnable).toBe(false)
    expect(route?.eligibleProfiles).toEqual([])
  })

  it("an oauth-bearer profile is eligible for claude-code (authSubscription) but not for hermes (api-key only)", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE, HERMES],
      profiles: [anthropicOauth],
    })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    // Both adapters curate the same (vendor, product, route) — merged into one row.
    expect(route?.adapters.sort()).toEqual(["claude-code", "hermes"])
    // hermes can't present oauth-bearer, but claude-code can — the union still runs.
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toEqual(["jeremy-max"])
  })

  it("a gateway-routed model bills the gateway's own vendor, never the underlying model vendor (SPEC §1c)", () => {
    const response = buildCatalogModels({
      adapters: [MOONSHOT_ROUTED],
      profiles: [anthropicOauth, moonshotApiKey],
    })
    const route = findRoute(response, "moonshot", "kimi-k2.7-code", "moonshot")
    expect(route).toBeDefined()
    // The Claude subscription is NOT eligible on the moonshot route.
    expect(route?.eligibleProfiles).toEqual(["personal-moonshot"])
    expect(route?.runnable).toBe(true)
    expect(route?.adapterModes).toEqual(["moonshot"])
  })

  it("a gateway route never accepts an oauth-bearer profile, even for the right vendor id", () => {
    const bogusOauthMoonshot: AuthProfile = {
      id: "bogus",
      endpoint: "moonshot",
      method: "oauth-bearer",
      credentialRef: "x",
    }
    const response = buildCatalogModels({
      adapters: [MOONSHOT_ROUTED],
      profiles: [bogusOauthMoonshot],
    })
    const route = findRoute(response, "moonshot", "kimi-k2.7-code", "moonshot")
    expect(route?.runnable).toBe(false)
    expect(route?.eligibleProfiles).toEqual([])
  })
})

describe("buildCatalogModels — curated vs catalog-known routes (SPEC §5.1/§5.3)", () => {
  it("marks an adapter-declared route curated:true", () => {
    const response = buildCatalogModels({ adapters: [CLAUDE_CODE], profiles: [] })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.curated).toBe(true)
    expect(route?.adapters).toEqual(["claude-code"])
  })

  it("widens beyond the adapter's own model list: the same product also appears on a router route, marked curated:false", () => {
    // anthropic/claude-opus-4-8 has a real Requesty route
    // (requesty-routes.generated.ts) that claude-code never declares.
    const response = buildCatalogModels({ adapters: [CLAUDE_CODE], profiles: [] })
    const product = response.vendors
      .find(v => v.vendor === "anthropic")
      ?.products.find(p => p.product === "claude-opus-4-8")
    const requesty = product?.routes.find(r => r.route === "requesty")
    expect(requesty).toBeDefined()
    expect(requesty?.curated).toBe(false)
    expect(requesty?.adapters).toEqual([])
    expect(requesty?.adapterModes).toEqual([])
    // The curated direct route is still present alongside it.
    const direct = product?.routes.find(r => r.route === "anthropic")
    expect(direct?.curated).toBe(true)
  })

  it("a non-curated route is still runnable given an eligible profile — it's just reached via route+model+base_url, not a specific adapter", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [{ id: "requesty-key", endpoint: "requesty", method: "api-key", credentialRef: "x" }],
    })
    const requesty = findRoute(response, "anthropic", "claude-opus-4-8", "requesty")
    expect(requesty?.runnable).toBe(true)
    expect(requesty?.eligibleProfiles).toEqual(["requesty-key"])
  })
})

describe("buildCatalogModels — query filters", () => {
  it("?adapter= keeps only routes reachable via that adapter slug", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE, HERMES],
      profiles: [],
      query: { adapter: "hermes" },
    })
    // Both adapters curate this exact route, so it survives the filter —
    // its `adapters` list still names both, honestly reporting who else
    // can also reach it.
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.adapters).toContain("hermes")
    // The widened, adapter-less requesty route has no adapter at all, so it
    // drops out under an `adapter` filter.
    const requesty = findRoute(response, "anthropic", "claude-opus-4-8", "requesty")
    expect(requesty).toBeUndefined()
  })

  it("?vendor= keeps only that vendor's entry", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE, MOONSHOT_ROUTED],
      profiles: [],
      query: { vendor: "anthropic" },
    })
    expect(response.vendors.map(v => v.vendor)).toEqual(["anthropic"])
  })

  it("?route= keeps only routes with that route id", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [],
      query: { route: "requesty" },
    })
    const product = response.vendors
      .find(v => v.vendor === "anthropic")
      ?.products.find(p => p.product === "claude-opus-4-8")
    expect(product?.routes.map(r => r.route)).toEqual(["requesty"])
  })

  it("?runnableOnly=true drops every unrunnable route, and drops empty products/vendors entirely", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [], // no profiles at all ⇒ nothing is runnable
      query: { runnableOnly: true },
    })
    expect(response.vendors).toEqual([])
  })

  it("?runnableOnly=true keeps a vendor/product when at least one of its routes is runnable", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [anthropicOauth],
      query: { runnableOnly: true },
    })
    const product = response.vendors
      .find(v => v.vendor === "anthropic")
      ?.products.find(p => p.product === "claude-opus-4-8")
    expect(product?.routes.every(r => r.runnable)).toBe(true)
    expect(product?.routes.find(r => r.route === "anthropic")).toBeDefined()
  })
})

describe("buildCatalogModels — pricing + ref enrichment", () => {
  it("resolves a bare adapter-declared id to a priced vendor/product ref", () => {
    const response = buildCatalogModels({ adapters: [CLAUDE_CODE], profiles: [] })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.ref).toBe("anthropic/claude-opus-4-8")
    expect(route?.pricing).toEqual({ inPer1M: 5.0, outPer1M: 25.0 })
  })

  it("an unknown model id still gets a vendor via the id-prefix heuristic, with no pricing", () => {
    const response = buildCatalogModels({
      adapters: [{ slug: "x", models: [{ id: "claude-totally-made-up" }] }],
      profiles: [],
    })
    const route = findRoute(response, "anthropic", "claude-totally-made-up", "anthropic")
    expect(route).toBeDefined()
    expect(route?.pricing).toBeNull()
  })
})

// The regression this PR closes: a router-prefixed Mastra id like
// `openrouter/z-ai/glm-5.2` (adapters/mastra-agent/src/index.ts:78) is a
// 3-segment `<router>/<vendor>/<product>` string. `parseModelRef` splits on
// the FIRST `/` and rejects a product still holding one, so before the fix
// this threw `InvalidModelRefError` and 500'd the WHOLE catalog. These
// fixtures mirror mastra-agent's real `models.allowed`.
const MASTRA_AGENT: CatalogAdapterInput = {
  slug: "mastra-agent",
  models: [
    { id: "openrouter/z-ai/glm-5.2" },
    { id: "openrouter/deepseek/deepseek-v4-pro" },
    { id: "openai/gpt-5" },
  ],
  // OpenRouter/OpenAI api-key gateway — never subscription (SPEC §1c).
  authDescriptor: { provider: "openrouter" },
}

describe("buildCatalogModels — router-prefixed OpenRouter ids (regression)", () => {
  it("does not throw on the exact id that crashed the endpoint", () => {
    expect(() =>
      buildCatalogModels({ adapters: [MASTRA_AGENT], profiles: [] }),
    ).not.toThrow()
  })

  it("represents `openrouter/z-ai/glm-5.2` as the canonical z-ai/glm-5.2@openrouter row", () => {
    const response = buildCatalogModels({ adapters: [MASTRA_AGENT], profiles: [] })
    // vendor z-ai, product glm-5.2, route openrouter — NOT the 3-segment
    // `openrouter/z-ai/glm-5.2` mangling, and NOT dropped from the catalog.
    const route = findRoute(response, "z-ai", "glm-5.2", "openrouter")
    expect(route).toBeDefined()
    expect(route?.ref).toBe("z-ai/glm-5.2@openrouter")
    expect(route?.curated).toBe(true)
    expect(route?.adapters).toContain("mastra-agent")
    // Priced from the REAL committed OpenRouter snapshot
    // (openrouter-routes.generated.ts, keyed `z-ai/glm-5.2`).
    expect(route?.pricing).not.toBeNull()
    expect(route?.pricing?.inPer1M).toBeGreaterThan(0)
  })

  it("resolves the second router-prefixed id (`openrouter/deepseek/deepseek-v4-pro`) too", () => {
    const response = buildCatalogModels({ adapters: [MASTRA_AGENT], profiles: [] })
    const route = findRoute(response, "deepseek", "deepseek-v4-pro", "openrouter")
    expect(route).toBeDefined()
    expect(route?.ref).toBe("deepseek/deepseek-v4-pro@openrouter")
  })

  it("keeps an OpenRouter id whose product has no snapshot pricing as a valid, unpriced row", () => {
    // A router-prefixed id for a product NOT in the OpenRouter snapshot must
    // still surface as a valid `<vendor>/<product>@openrouter` row (parsed,
    // just unpriced) rather than being dropped or crashing.
    const response = buildCatalogModels({
      adapters: [
        { slug: "x", models: [{ id: "openrouter/z-ai/glm-does-not-exist" }] },
      ],
      profiles: [],
    })
    const route = findRoute(response, "z-ai", "glm-does-not-exist", "openrouter")
    expect(route).toBeDefined()
    expect(route?.ref).toBe("z-ai/glm-does-not-exist@openrouter")
    expect(route?.pricing).toBeNull()
  })

  it("leaves a 2-segment direct id (`openai/gpt-5`) as a direct-route row", () => {
    const response = buildCatalogModels({ adapters: [MASTRA_AGENT], profiles: [] })
    const route = findRoute(response, "openai", "gpt-5", "openai")
    expect(route).toBeDefined()
    expect(route?.ref).toBe("openai/gpt-5")
  })

  it("marks the z-ai/glm route runnable for an openrouter api-key profile", () => {
    const openrouterKey: AuthProfile = {
      id: "personal-openrouter",
      endpoint: "openrouter",
      method: "api-key",
      credentialRef: "ref-or",
    }
    const response = buildCatalogModels({
      adapters: [MASTRA_AGENT],
      profiles: [openrouterKey],
    })
    const route = findRoute(response, "z-ai", "glm-5.2", "openrouter")
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toContain("personal-openrouter")
  })

  it("never lets one unparseable id 500 the response — a garbage id is skipped-in-place, siblings survive", () => {
    // An id normalization can't rescue (unknown 3-segment prefix) must not
    // throw: it degrades to a best-effort row and the good rows still build.
    const response = buildCatalogModels({
      adapters: [
        {
          slug: "weird",
          models: [{ id: "notaroute/z-ai/glm-5.2" }, { id: "openrouter/z-ai/glm-5.2" }],
        },
      ],
      profiles: [],
    })
    expect(findRoute(response, "z-ai", "glm-5.2", "openrouter")).toBeDefined()
  })
})
