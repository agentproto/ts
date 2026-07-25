/**
 * `buildCatalogModels` (catalog-models.ts) — the pure join behind the
 * read-only catalog/vendor endpoint (SPEC §5, `GET /catalog/models` +
 * `catalog_models`). Every assertion here fails on `main`: the module,
 * its exports, and this whole vendor/product/route join don't exist yet.
 */

import { describe, it, expect } from "vitest"
import type { AuthProfile } from "@agentproto/auth"
import { buildCatalogModels, type CatalogAdapterInput } from "../catalog-models.js"
import { registerBuiltinRoutes } from "../builtin-routes.js"

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

describe("buildCatalogModels — first-party ids whose vendor/product COLLIDES with a router pricing key stay runnable on their own anthropic route (#688 regression)", () => {
  // `anthropic/claude-sonnet-5` and `anthropic/claude-fable-5` are keyed in the
  // OpenRouter pricing data with the SAME dash spelling Anthropic uses and
  // `provider:"openrouter"`, so `getModelProvider` resolves them to the ROUTER
  // and the direct `anthropic` route would drop out of `serviceableModelRoutes`
  // — flipping the wallet-eligibility gate and rendering these models
  // non-runnable even with an eligible anthropic subscription profile. The
  // `resolvePricingExact` restore (catalog-models.ts) re-adds the vendor route.
  // Their non-colliding siblings (`claude-opus-4-8`, `claude-haiku-4-5`) never
  // hit the collision — assert them side-by-side so a future regression can't
  // silently single out the collision ids again.
  const CLAUDE_CODE_FULL: CatalogAdapterInput = {
    slug: "claude-code",
    models: [
      { id: "claude-sonnet-5" },
      { id: "claude-fable-5" },
      { id: "claude-opus-4-8" },
      { id: "claude-haiku-4-5" },
    ],
    authDescriptor: {
      provider: "anthropic",
      authSubscription: { setEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
    },
  }

  for (const product of [
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
  ]) {
    it(`${product} is runnable on its anthropic route via an oauth-bearer subscription profile`, () => {
      const response = buildCatalogModels({
        adapters: [CLAUDE_CODE_FULL],
        profiles: [anthropicOauth],
      })
      const route = findRoute(response, "anthropic", product, "anthropic")
      expect(route?.runnable).toBe(true)
      expect(route?.eligibleProfiles).toEqual(["jeremy-max"])
    })
  }
})

describe("buildCatalogModels — whole-profile disable (WS2) + per-model curation (WS3)", () => {
  it("HARD INVARIANT: output is byte-identical when profiles carry no `models`/`disabled`", () => {
    // The same profiles, once as shipped today and once explicitly asserting
    // the additive fields are absent — the full join must be deep-equal, so a
    // profile that predates WS2/WS3 keeps exactly its old eligibility.
    const adapters = [CLAUDE_CODE, HERMES, MOONSHOT_ROUTED]
    const profiles = [anthropicOauth, anthropicApiKey, moonshotApiKey]
    const baseline = buildCatalogModels({ adapters, profiles })
    const again = buildCatalogModels({
      adapters,
      // Same profiles, spread through a fresh array — no `disabled`, no `models`.
      profiles: profiles.map(p => ({ ...p })),
    })
    expect(again).toEqual(baseline)
  })

  it("a disabled profile drops every model it would service to non-runnable (WS2)", () => {
    const enabled = buildCatalogModels({ adapters: [CLAUDE_CODE], profiles: [anthropicOauth] })
    const disabled = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [{ ...anthropicOauth, disabled: true }],
    })
    expect(findRoute(enabled, "anthropic", "claude-opus-4-8", "anthropic")?.runnable).toBe(true)
    const route = findRoute(disabled, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.runnable).toBe(false)
    expect(route?.eligibleProfiles).toEqual([])
  })

  it("an `allow` allowlist that includes the model keeps it runnable (WS3)", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [
        {
          ...anthropicApiKey,
          models: { mode: "allow", ids: ["anthropic/claude-opus-4-8"] },
        },
      ],
    })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toEqual(["work-anthropic-key"])
  })

  it("an `allow` allowlist that excludes the model drops it to non-runnable, without disabling the profile elsewhere (WS3)", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [
        {
          ...anthropicApiKey,
          models: { mode: "allow", ids: ["anthropic/some-other-model"] },
        },
      ],
    })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.runnable).toBe(false)
    expect(route?.eligibleProfiles).toEqual([])
  })

  it("an explicit `mode:\"all\"` curation is identical to no curation", () => {
    const bare = buildCatalogModels({ adapters: [CLAUDE_CODE], profiles: [anthropicApiKey] })
    const allMode = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [{ ...anthropicApiKey, models: { mode: "all", ids: [] } }],
    })
    expect(allMode).toEqual(bare)
  })
})

describe("buildCatalogModels — bare-product allowlist tolerance (WP-A)", () => {
  // The vscode "+ Models" picker writes bare pricing-catalog ids
  // (`claude-opus-4-8`) into a profile allowlist for single-vendor DIRECT
  // endpoints, not the vendor/product or route-qualified form. The read-side
  // curation gate accepts the bare product on DIRECT routes so those existing
  // allowlists work with zero data migration — but NOT on multi-vendor gateway
  // routes (openrouter/requesty), where a bare id would over-widen across
  // sibling vendors and the vendor/product form is required instead.

  it("a bare product id (`claude-opus-4-8`) keeps its model runnable", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [{ ...anthropicApiKey, models: { mode: "allow", ids: ["claude-opus-4-8"] } }],
    })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toEqual(["work-anthropic-key"])
  })

  it("a bare product id does NOT match a multi-vendor GATEWAY route (would over-widen across sibling vendors), but the vendor/product form does", () => {
    // openrouter/requesty host the same bare product under many vendor
    // prefixes, so a bare `glm-5.2` allow must NOT admit the `z-ai/glm-5.2@openrouter`
    // gateway row — only the ref or the `vendor/product` form may.
    const bareKey: AuthProfile = {
      id: "or-bare",
      endpoint: "openrouter",
      method: "api-key",
      credentialRef: "ref-or",
      models: { mode: "allow", ids: ["glm-5.2"] },
    }
    const blocked = buildCatalogModels({ adapters: [MASTRA_AGENT], profiles: [bareKey] })
    const blockedRoute = findRoute(blocked, "z-ai", "glm-5.2", "openrouter")
    expect(blockedRoute?.runnable).toBe(false)
    expect(blockedRoute?.eligibleProfiles).toEqual([])

    const vendorProductKey: AuthProfile = {
      id: "or-vp",
      endpoint: "openrouter",
      method: "api-key",
      credentialRef: "ref-or",
      models: { mode: "allow", ids: ["z-ai/glm-5.2"] },
    }
    const allowed = buildCatalogModels({ adapters: [MASTRA_AGENT], profiles: [vendorProductKey] })
    const allowedRoute = findRoute(allowed, "z-ai", "glm-5.2", "openrouter")
    expect(allowedRoute?.runnable).toBe(true)
    expect(allowedRoute?.eligibleProfiles).toEqual(["or-vp"])
  })

  it("the `vendor/product` form still matches (no regression)", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [{ ...anthropicApiKey, models: { mode: "allow", ids: ["anthropic/claude-opus-4-8"] } }],
    })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toEqual(["work-anthropic-key"])
  })

  it("the route-qualified `ref` form still matches (no regression)", () => {
    const openrouterKey: AuthProfile = {
      id: "or-ref",
      endpoint: "openrouter",
      method: "api-key",
      credentialRef: "ref-or",
      models: { mode: "allow", ids: ["z-ai/glm-5.2@openrouter"] },
    }
    const response = buildCatalogModels({ adapters: [MASTRA_AGENT], profiles: [openrouterKey] })
    const route = findRoute(response, "z-ai", "glm-5.2", "openrouter")
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toEqual(["or-ref"])
  })

  it("a bare id that matches nothing keeps the model blocked", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [{ ...anthropicApiKey, models: { mode: "allow", ids: ["not-a-real-model"] } }],
    })
    const route = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
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

describe("buildCatalogModels — multiModel + servable-models-per-route (WP1 / SPEC §3)", () => {
  // Two Anthropic products on the direct `anthropic` route + one Kimi routed
  // through the single-model `moonshot` gateway mode.
  const MULTI: CatalogAdapterInput = {
    slug: "claude-code",
    models: [
      { id: "claude-opus-4-8" },
      { id: "claude-sonnet-5" },
      { id: "moonshot/kimi-k2.7-code", mode: "moonshot" },
    ],
    authDescriptor: { provider: "anthropic", authSubscription: { setEnv: "x" } },
  }

  it("marks a route serving >1 distinct model multiModel:true", () => {
    const response = buildCatalogModels({ adapters: [MULTI], profiles: [] })
    expect(findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")?.multiModel).toBe(true)
    expect(findRoute(response, "anthropic", "claude-sonnet-5", "anthropic")?.multiModel).toBe(true)
  })

  it("marks a single-model gateway route multiModel:false (drives tier pinning, SPEC §5.3)", () => {
    const response = buildCatalogModels({ adapters: [MULTI], profiles: [] })
    const kimi = findRoute(response, "moonshot", "kimi-k2.7-code", "moonshot")
    expect(kimi).toBeDefined()
    expect(kimi?.multiModel).toBe(false)
  })

  it("exposes servable-models-per-route in the top-level, route-sorted `routes` index (SPEC §3.9)", () => {
    const response = buildCatalogModels({ adapters: [MULTI], profiles: [] })
    const anthropic = response.routes.find(r => r.route === "anthropic")
    expect(anthropic?.multiModel).toBe(true)
    expect(anthropic?.servableModels).toEqual(
      expect.arrayContaining(["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-5"]),
    )
    const moonshot = response.routes.find(r => r.route === "moonshot")
    expect(moonshot?.servableModels).toEqual(["moonshot/kimi-k2.7-code"])
    expect(moonshot?.multiModel).toBe(false)
    // The index is sorted by route id.
    const ids = response.routes.map(r => r.route)
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
  })

  it("counts a product served by several adapters once (dedup by vendor/product)", () => {
    // Two adapters both curate anthropic/claude-opus-4-8 on the direct route:
    // it's one servable model, so a lone shared product must NOT read as
    // multiModel just because two adapters offer it.
    const response = buildCatalogModels({
      adapters: [
        { slug: "claude-code", models: [{ id: "claude-opus-4-8" }] },
        { slug: "claude-sdk", models: [{ id: "claude-opus-4-8" }] },
      ],
      profiles: [],
    })
    const anthropic = response.routes.find(r => r.route === "anthropic")
    expect(anthropic?.servableModels).toEqual(["anthropic/claude-opus-4-8"])
    expect(anthropic?.multiModel).toBe(false)
    expect(findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")?.multiModel).toBe(false)
  })

  it("keeps multiModel intrinsic — a route shared across vendors stays multiModel under a vendor filter", () => {
    // openrouter serves BOTH z-ai/glm-5.2 and deepseek/deepseek-v4-pro across
    // the full join. Filtering the tree to one vendor must not flip the
    // route's multiModel: the count is the route's real capacity, not a view
    // of the filtered result.
    const filtered = buildCatalogModels({
      adapters: [MASTRA_AGENT],
      profiles: [],
      query: { vendor: "z-ai" },
    })
    expect(filtered.vendors.map(v => v.vendor)).toEqual(["z-ai"])
    expect(findRoute(filtered, "z-ai", "glm-5.2", "openrouter")?.multiModel).toBe(true)
    // The unfiltered `routes` index still reports openrouter as multiModel.
    expect(filtered.routes.find(r => r.route === "openrouter")?.multiModel).toBe(true)
  })
})

describe("buildCatalogModels — catalog↔spawn wallet-eligibility parity (SPEC §1c)", () => {
  // claude-opus-4.7 is curated by claude-code (a real Anthropic-vendor id
  // reachable through the adapter's model list) but bills ONLY openrouter/
  // requesty in the pricing catalog: its OpenRouter route key `anthropic/
  // claude-opus-4.7` carries NO first-party bare pricing entry (Anthropic's own
  // dash-form ids are `claude-opus-4-8` etc.), so the direct anthropic SDK
  // genuinely cannot serve it — the exact gateway-only-model-on-a-fixed-
  // subscription-wallet shape the spawn guard (`checkModelWalletEligibility`,
  // session-spawn.ts:1143) rejects with `model_wallet_ineligible`. Before that
  // guard the catalog reported the direct anthropic route as runnable, which
  // then 500'd on a real spawn.
  //
  // NB: a first-party id whose `<vendor>/<product>` form COLLIDES with a router
  // key (claude-sonnet-5 / claude-fable-5 — SAME dash spelling) is the OPPOSITE
  // case: it IS serviceable on the direct anthropic route and MUST stay
  // runnable. See the "first-party ↔ router-key collision" describe below.
  const CLAUDE_CODE_GATEWAY_ONLY: CatalogAdapterInput = {
    slug: "claude-code",
    models: [{ id: "claude-opus-4.7" }],
    authDescriptor: {
      provider: "anthropic",
      authSubscription: { setEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
    },
  }

  it("a gateway-only model is NOT runnable on its adapter's direct (fixed-wallet) route — matches the spawn 500", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE_GATEWAY_ONLY],
      profiles: [anthropicOauth, anthropicApiKey],
    })
    const direct = findRoute(response, "anthropic", "claude-opus-4.7", "anthropic")
    expect(direct).toBeDefined()
    expect(direct?.runnable).toBe(false)
    expect(direct?.eligibleProfiles).toEqual([])
  })

  it("the same gateway-only model stays runnable on the router route it actually bills", () => {
    const openrouterKey: AuthProfile = {
      id: "openrouter-key",
      endpoint: "openrouter",
      method: "api-key",
      credentialRef: "ref-openrouter",
    }
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE_GATEWAY_ONLY],
      profiles: [openrouterKey],
    })
    const openrouter = findRoute(response, "anthropic", "claude-opus-4.7", "openrouter")
    expect(openrouter).toBeDefined()
    expect(openrouter?.runnable).toBe(true)
    expect(openrouter?.eligibleProfiles).toEqual(["openrouter-key"])
  })

  it("a genuinely sub-serviceable model (claude-sonnet-5) is unaffected — keeps its direct-route profiles", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [anthropicOauth, anthropicApiKey],
    })
    const direct = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(direct?.runnable).toBe(true)
    expect(direct?.eligibleProfiles.sort()).toEqual(["jeremy-max", "work-anthropic-key"])
  })

  it("a moonshot-mode route whose mode id coincidentally equals its vendor is NOT gated (explicit gateway naming, never second-guessed)", () => {
    const response = buildCatalogModels({
      adapters: [MOONSHOT_ROUTED],
      profiles: [moonshotApiKey],
    })
    const moonshot = findRoute(response, "moonshot", "kimi-k2.7-code", "moonshot")
    expect(moonshot?.runnable).toBe(true)
    expect(moonshot?.eligibleProfiles).toEqual(["personal-moonshot"])
  })
})

describe("buildCatalogModels — first-party ↔ router-key collision (firstparty-eligibility bug)", () => {
  // Regression for the first-party-eligibility bug: OpenRouter keys
  // `anthropic/claude-sonnet-5` and `anthropic/claude-fable-5` with the SAME
  // dash spelling Anthropic's OWN first-party ids use (tagged
  // `provider:"openrouter"`), so `resolvePricing`/`getModelProvider` on the
  // `<vendor>/<product>` form resolve to the ROUTER and the direct anthropic
  // route dropped out of `serviceableModelRoutes` — the wallet gate then
  // rejected the genuine direct route and reported `runnable:false` /
  // `eligibleProfiles:[]` for these two, while `claude-opus-4-8` (OpenRouter
  // spells it `claude-opus-4.8`, dot — no collision) was spared. The fix
  // restores the direct vendor route whenever the BARE product is itself a
  // first-party model of that vendor.
  const firstPartyCollisionAdapter = (id: string): CatalogAdapterInput => ({
    slug: "claude-code",
    models: [{ id }],
    authDescriptor: {
      provider: "anthropic",
      authSubscription: { setEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
    },
  })

  for (const product of ["claude-sonnet-5", "claude-fable-5"]) {
    it(`${product} is runnable on the direct anthropic route with the uncurated sub/api-key profiles`, () => {
      const response = buildCatalogModels({
        adapters: [firstPartyCollisionAdapter(product)],
        profiles: [anthropicOauth, anthropicApiKey],
      })
      const direct = findRoute(response, "anthropic", product, "anthropic")
      expect(direct).toBeDefined()
      expect(direct?.runnable).toBe(true)
      expect(direct?.eligibleProfiles.sort()).toEqual(["jeremy-max", "work-anthropic-key"])
    })

    it(`${product} still exposes its router (@openrouter) route, unaffected by the fix`, () => {
      const openrouterKey: AuthProfile = {
        id: "openrouter-key",
        endpoint: "openrouter",
        method: "api-key",
        credentialRef: "ref-openrouter",
      }
      const response = buildCatalogModels({
        adapters: [firstPartyCollisionAdapter(product)],
        profiles: [openrouterKey],
      })
      const openrouter = findRoute(response, "anthropic", product, "openrouter")
      expect(openrouter?.runnable).toBe(true)
      expect(openrouter?.eligibleProfiles).toEqual(["openrouter-key"])
    })
  }

  it("regression guard: claude-opus-4-8 (no dash/dot collision) stays runnable on the direct anthropic route", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE],
      profiles: [anthropicOauth, anthropicApiKey],
    })
    const direct = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(direct?.runnable).toBe(true)
    expect(direct?.eligibleProfiles.sort()).toEqual(["jeremy-max", "work-anthropic-key"])
  })

  // The OTHER half of the fix, and the coverage hole that let the substring bug
  // through: an openrouter-only sibling variant whose bare product only
  // SUBSTRING-matches a first-party pricing row (`gemini-2.5-flash-image` →
  // `gemini-2.5-flash`, provider google) must NOT be revived onto its vendor's
  // direct wallet. The pre-fix `resolvePricing` substring fallback flipped this
  // route runnable:true under a google api-key; `resolvePricingExact` keeps the
  // direct google route runnable:false — google's own SDK cannot bill it.
  it("an openrouter-only sibling variant (google/gemini-2.5-flash-image) stays NOT runnable on the direct google route", () => {
    const geminiCli: CatalogAdapterInput = {
      slug: "gemini-cli",
      models: [{ id: "google/gemini-2.5-flash-image" }],
      authDescriptor: { provider: "google" },
    }
    const googleApiKey: AuthProfile = {
      id: "my-google",
      endpoint: "google",
      method: "api-key",
      credentialRef: "ref-google",
    }
    const response = buildCatalogModels({
      adapters: [geminiCli],
      profiles: [googleApiKey],
    })
    const direct = findRoute(response, "google", "gemini-2.5-flash-image", "google")
    // The direct google route row exists (google curated it) but is unbillable.
    expect(direct).toBeDefined()
    expect(direct?.runnable).toBe(false)
    expect(direct?.eligibleProfiles).toEqual([])
  })
})

describe("buildCatalogModels — curated @llm-endpoint proxy route (PR-5)", async () => {
  // The built-in `llm-endpoint` custom route must be registered for a curated
  // `<vendor>/<product>@llm-endpoint` row to carry a baseUrl to spawn against.
  // `registerBuiltinRoutes` writes it into the (module-global, idempotent)
  // custom-route map — the same call `createGateway` makes at daemon boot.
  await registerBuiltinRoutes()

  // claude-code curates a native id, an @openrouter id, and an @llm-endpoint id
  // — mirroring the real adapter allowlist, so the same fixture proves the new
  // llm-endpoint row is runnable AND the existing direct/@openrouter rows are
  // untouched by it.
  const CLAUDE_CODE_LLM: CatalogAdapterInput = {
    slug: "claude-code",
    models: [
      { id: "claude-opus-4-8" },
      { id: "z-ai/glm-5.2@openrouter" },
      { id: "moonshot/kimi-k2.7-code@llm-endpoint" },
    ],
    authDescriptor: {
      provider: "anthropic",
      authSubscription: { setEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
    },
  }

  // The CRUX (STEP 0b): a gateway route bills its OWN route id, so an
  // llm-endpoint profile must carry `endpoint: "llm-endpoint"` + `method:
  // "api-key"` — NOT the underlying model's vendor (`moonshot`).
  const llmEndpointKey: AuthProfile = {
    id: "llm-endpoint-key",
    endpoint: "llm-endpoint",
    method: "api-key",
    credentialRef: "ref-llm-endpoint",
  }
  const openrouterKey: AuthProfile = {
    id: "personal-openrouter",
    endpoint: "openrouter",
    method: "api-key",
    credentialRef: "ref-or",
  }

  it("runnable:true given an enabled api-key profile whose endpoint is `llm-endpoint`", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE_LLM],
      profiles: [llmEndpointKey],
    })
    const route = findRoute(response, "moonshot", "kimi-k2.7-code", "llm-endpoint")
    expect(route).toBeDefined()
    expect(route?.runnable).toBe(true)
    expect(route?.baseUrl).toBe("http://localhost:18090")
    expect(route?.eligibleProfiles).toEqual(["llm-endpoint-key"])
  })

  it("runnable:false without an llm-endpoint api-key profile (anthropic/openrouter don't bill it)", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE_LLM],
      profiles: [anthropicOauth, openrouterKey],
    })
    const route = findRoute(response, "moonshot", "kimi-k2.7-code", "llm-endpoint")
    expect(route).toBeDefined()
    expect(route?.runnable).toBe(false)
    expect(route?.eligibleProfiles).toEqual([])
  })

  it("a gateway route never accepts an oauth-bearer profile, even at the right endpoint", () => {
    const llmEndpointOauth: AuthProfile = {
      id: "llm-endpoint-oauth",
      endpoint: "llm-endpoint",
      method: "oauth-bearer",
      credentialRef: "ref-oauth",
    }
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE_LLM],
      profiles: [llmEndpointOauth],
    })
    const route = findRoute(response, "moonshot", "kimi-k2.7-code", "llm-endpoint")
    expect(route?.runnable).toBe(false)
  })

  it("a disabled llm-endpoint profile drops the row to non-runnable (WS2)", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE_LLM],
      profiles: [{ ...llmEndpointKey, disabled: true }],
    })
    const route = findRoute(response, "moonshot", "kimi-k2.7-code", "llm-endpoint")
    expect(route?.runnable).toBe(false)
  })

  it("leaves the direct and @openrouter rows unchanged by the llm-endpoint wiring", () => {
    const response = buildCatalogModels({
      adapters: [CLAUDE_CODE_LLM],
      profiles: [anthropicOauth, openrouterKey, llmEndpointKey],
    })
    // Direct anthropic route: still runnable via the Claude subscription.
    const direct = findRoute(response, "anthropic", "claude-opus-4-8", "anthropic")
    expect(direct?.runnable).toBe(true)
    expect(direct?.eligibleProfiles).toEqual(["jeremy-max"])
    // @openrouter route: still runnable via the openrouter api-key, and never
    // eligible for the llm-endpoint profile.
    const openrouter = findRoute(response, "z-ai", "glm-5.2", "openrouter")
    expect(openrouter?.runnable).toBe(true)
    expect(openrouter?.eligibleProfiles).toEqual(["personal-openrouter"])
  })
})
