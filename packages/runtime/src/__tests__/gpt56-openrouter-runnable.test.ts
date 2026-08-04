/**
 * The OpenRouter-routed OpenAI `gpt-5.6` series (`gpt-5.6-luna` / `gpt-5.6-sol`
 * / `gpt-5.6-terra`, each with a `-pro` variant) must be SELECTABLE in the
 * vscode "+" picker AND LAUNCHABLE through an OpenRouter api-key profile.
 *
 * These ids are served by OpenRouter as `openai/gpt-5.6-*` and land in the
 * generated pricing catalog (`openrouter-routes.generated.ts`, keyed
 * `openai/gpt-5.6-*`, `provider:"openrouter"`). They are NOT curated by any
 * harness adapter — their `buildCatalogModels` rows carry `adapters:[]` — so
 * this file proves the two surfaces that do NOT depend on adapter curation:
 *
 *  1. Enumeration (picker visibility) — `buildCatalogProviderModels`.
 *  2. Wallet/route eligibility (the launch gate) — `serviceableModelRoutes` +
 *     `checkModelWalletEligibility`, and the same predicate through the real
 *     `buildCatalogModels` join and the `spawnAgentSession` money-safety guard.
 *
 * Everything rides the REAL regenerated catalog data (no injected pricing
 * fixture), so a future catalog refresh that dropped/repriced the series would
 * redden these.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { AuthProfile } from "@agentproto/auth"
import {
  buildCatalogModels,
  serviceableModelRoutes,
  checkModelWalletEligibility,
  type CatalogAdapterInput,
} from "../catalog-models.js"
import { buildCatalogProviderModels } from "../catalog-provider-models.js"

// Deterministic providers.json api-key lookup (the resolver's store source),
// mirroring spawn-model-eligibility.test.ts — never touch the real
// ~/.agentproto file.
const storeKeys = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }))
vi.mock("../providers-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers-store.js")>()
  return { ...actual, getProviderKey: vi.fn(async (p: string) => storeKeys.value[p]) }
})

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

// The three base products + their `-pro` variants, with the input/output
// per-1M prices committed in openrouter-routes.generated.ts. Asserting the
// numbers proves the row is genuinely priced (a launchable wallet needs it),
// not merely present.
const GPT56 = [
  // OpenRouter repriced the two lower tiers (sol unchanged), moving the
  // ladder from 1 / 2.5 / 5 to 0.1 / 1 / 5. Both tiers moved consistently
  // across their base and -pro variants, so this is a real price cut, not a
  // stray decimal on one row.
  { product: "gpt-5.6-luna", inPer1M: 0.1, outPer1M: 0.6 },
  { product: "gpt-5.6-luna-pro", inPer1M: 0.1, outPer1M: 0.6 },
  { product: "gpt-5.6-sol", inPer1M: 5, outPer1M: 30 },
  { product: "gpt-5.6-sol-pro", inPer1M: 5, outPer1M: 30 },
  { product: "gpt-5.6-terra", inPer1M: 1, outPer1M: 6 },
  { product: "gpt-5.6-terra-pro", inPer1M: 1, outPer1M: 6 },
] as const

const openrouterKey: AuthProfile = {
  id: "personal-openrouter",
  endpoint: "openrouter",
  method: "api-key",
  credentialRef: "ref-or",
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

describe("gpt-5.6 series — picker visibility (buildCatalogProviderModels)", () => {
  it("the OpenRouter provider enumeration lists every gpt-5.6 product with pricing", () => {
    const res = buildCatalogProviderModels({ endpoint: "openrouter" })
    expect(res.provider).toBe("openrouter")
    for (const { product, inPer1M, outPer1M } of GPT56) {
      const row = res.models.find(m => m.id === `openai/${product}`)
      expect(row, `openai/${product} must appear in the "+" picker`).toBeDefined()
      expect(row?.route).toBe("openrouter")
      expect(row?.pricing?.inPer1M).toBe(inPer1M)
      expect(row?.pricing?.outPer1M).toBe(outPer1M)
    }
  })
})

describe("gpt-5.6 series — wallet/route eligibility (the launch gate)", () => {
  it("serviceableModelRoutes resolves the series to the openrouter route (bare AND @openrouter forms)", () => {
    for (const { product } of GPT56) {
      const bare = serviceableModelRoutes(`openai/${product}`)
      expect(bare, `openai/${product}`).toContain("openrouter")
      const pinned = serviceableModelRoutes(`openai/${product}@openrouter`)
      expect(pinned, `openai/${product}@openrouter`).toContain("openrouter")
      // NB: the series is ALSO a first-party OpenAI model (catalog.ts, provider
      // "openai"), so the native `openai` wallet legitimately bills it too — it
      // is NOT gateway-only. OpenRouter is one of several serviceable routes.
      expect(bare).toContain("openai")
    }
  })

  it("checkModelWalletEligibility ACCEPTS the series on an openrouter wallet (and the native openai wallet), REJECTS an unrelated vendor wallet", () => {
    for (const { product } of GPT56) {
      // The deliverable's focus: launchable through an OpenRouter api-key wallet.
      expect(checkModelWalletEligibility(`openai/${product}`, "openrouter").ok).toBe(true)
      // Also billable on its native OpenAI wallet (first-party catalog row).
      expect(checkModelWalletEligibility(`openai/${product}`, "openai").ok).toBe(true)
      // Money-safety: a wallet that genuinely cannot bill it (anthropic) is
      // rejected, and the verdict points at the real routes — openrouter among them.
      const rejected = checkModelWalletEligibility(`openai/${product}`, "anthropic")
      expect(rejected.ok).toBe(false)
      expect(rejected.suggestedRoutes).toContain("openrouter")
      expect(rejected.suggestedRoutes).not.toContain("anthropic")
    }
  })
})

describe("gpt-5.6 series — runnable through the buildCatalogModels join", () => {
  // An adapter that offers the series as explicit `@openrouter` refs (the shape
  // a harness allowlist writes for a gateway model). Even absent this, the
  // series is launchable via route+model+base_url — but curating it here proves
  // the full tree join marks it runnable with the openrouter api-key profile.
  const GATEWAY_ADAPTER: CatalogAdapterInput = {
    slug: "openrouter-gateway",
    models: GPT56.map(({ product }) => ({ id: `openai/${product}@openrouter` })),
    authDescriptor: { provider: "openrouter" },
  }

  it("gpt-5.6-sol@openrouter and gpt-5.6-luna@openrouter come back runnable:true with an OpenRouter api-key profile", () => {
    const response = buildCatalogModels({
      adapters: [GATEWAY_ADAPTER],
      profiles: [openrouterKey],
    })
    for (const { product, inPer1M, outPer1M } of GPT56) {
      const route = findRoute(response, "openai", product, "openrouter")
      expect(route, `openai/${product}@openrouter`).toBeDefined()
      expect(route?.runnable).toBe(true)
      expect(route?.eligibleProfiles).toEqual(["personal-openrouter"])
      expect(route?.ref).toBe(`openai/${product}@openrouter`)
      expect(route?.pricing).toEqual({ inPer1M, outPer1M })
    }
  })

  it("without any profile the same rows are present but non-runnable (nothing bills them)", () => {
    const response = buildCatalogModels({ adapters: [GATEWAY_ADAPTER], profiles: [] })
    const sol = findRoute(response, "openai", "gpt-5.6-sol", "openrouter")
    expect(sol).toBeDefined()
    expect(sol?.runnable).toBe(false)
    expect(sol?.eligibleProfiles).toEqual([])
  })
})

describe("gpt-5.6 series — launchable end-to-end through the spawn money-safety guard", () => {
  let acpCounter = 0
  function fakeAgentSession(): AgentSessionLike {
    return {
      sessionId: `acp_${acpCounter++}`,
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> {
        return
      },
      async cancel() {},
      async close() {},
    }
  }

  const CLAUDE_CODE_DESC: AdapterAuthDescriptor = {
    provider: "anthropic",
    authEnforce: "always",
    authSubscription: { setEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
  }

  function makeResolver(descriptor: AdapterAuthDescriptor) {
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolver: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      defaultModel: "claude-sonnet-5",
      authDescriptor: descriptor,
    })
    return { resolver, startSession }
  }

  function deps(resolver: AgentAdapterResolver): SpawnAgentSessionDeps {
    return {
      registry: createSessionsRegistry({ persist: false }),
      resolveAgentAdapter: resolver,
      loadDefaultsConfig: async () => undefined,
    }
  }

  beforeEach(() => {
    storeKeys.value = {}
  })

  it("ACCEPTS a gpt-5.6-sol spawn on a route.gateway=openrouter api-key wallet", async () => {
    storeKeys.value = { openrouter: "sk-or-v1-testkey000000" }
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "openai/gpt-5.6-sol",
      route: { gateway: "openrouter" },
      auth: { mode: "api-key" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it("REJECTS the same gpt-5.6-sol spawn on the fixed anthropic subscription wallet (money-safety)", async () => {
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "openai/gpt-5.6-sol",
      auth: { mode: "subscription", token: "sk-ant-oat01-testtoken00000" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected rejection")
    expect(result.code).toBe("model_wallet_ineligible")
    expect(result.message).toContain('route.gateway="openrouter"')
    expect(startSession).not.toHaveBeenCalled()
  })
})
