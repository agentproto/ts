import { describe, expect, it } from "vitest"

import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  LlmEndpointLinksResult,
  ProviderPresetEntry,
  UserPreset,
} from "../client/types.js"
import {
  buildAuthExplorerView,
  toggleWalletModel,
  toggleWalletVendor,
  type AuthExplorerData,
} from "./authExplorer.logic.js"

function preset(slug: string, name?: string): ProviderPresetEntry {
  return { slug, name: name ?? slug, status: "ready" }
}

function profile(over: Partial<AuthProfileSummary> = {}): AuthProfileSummary {
  return { id: "openrouter-env", endpoint: "openrouter", method: "api-key", ...over }
}

function route(over: Partial<CatalogModelsResponse["vendors"][0]["products"][0]["routes"][0]> = {}) {
  return {
    route: "openrouter",
    ref: "x@openrouter",
    baseUrl: null,
    pricing: null,
    runnable: true,
    eligibleProfiles: [] as string[],
    adapterModes: [] as string[],
    adapters: [] as string[],
    curated: false,
    ...over,
  }
}

/** deepseek/{flash,pro} + anthropic/fable, all billed on openrouter. */
function catalog(eligible: string[]): CatalogModelsResponse {
  return {
    vendors: [
      {
        vendor: "deepseek",
        products: [
          {
            product: "deepseek-v4-flash",
            routes: [route({ ref: "deepseek/deepseek-v4-flash@openrouter", eligibleProfiles: eligible })],
          },
          {
            product: "deepseek-v4-pro",
            routes: [route({ ref: "deepseek/deepseek-v4-pro@openrouter", runnable: false })],
          },
        ],
      },
      {
        vendor: "anthropic",
        products: [
          {
            product: "claude-fable-5",
            routes: [
              route({
                ref: "anthropic/claude-fable-5@openrouter",
                eligibleProfiles: ["other-wallet"],
                pricing: { inPer1M: 10, outPer1M: 50 },
              }),
            ],
          },
        ],
      },
    ],
  }
}

function data(over: Partial<AuthExplorerData> = {}): AuthExplorerData {
  return {
    presets: [preset("openrouter", "OpenRouter"), preset("deepseek", "DeepSeek")],
    profiles: [profile()],
    catalog: catalog(["openrouter-env"]),
    adapters: [],
    userPresets: [],
    links: null,
    routerStatus: null,
    ...over,
  }
}

describe("buildAuthExplorerView — providers & wallets", () => {
  it("puts connected providers first and surfaces unconnected presets", () => {
    const view = buildAuthExplorerView(data())
    expect(view.providers.map(p => [p.slug, p.connected])).toEqual([
      ["openrouter", true],
      ["deepseek", false],
    ])
    expect(view.counts).toMatchObject({ wallets: 1, providers: 1 })
  })

  it("includes an endpoint that has a wallet but no provider preset", () => {
    const view = buildAuthExplorerView(
      data({ profiles: [profile(), profile({ id: "custom", endpoint: "my-proxy" })] }),
    )
    const proxy = view.providers.find(p => p.slug === "my-proxy")!
    expect(proxy.connected).toBe(true)
    expect(proxy.wallets.map(w => w.id)).toEqual(["custom"])
  })

  it("statuses each catalog model per wallet: active / billed-elsewhere / unbillable", () => {
    const view = buildAuthExplorerView(data())
    const wallet = view.providers[0]!.wallets[0]!
    expect(wallet.models.map(m => [m.writeId, m.status])).toEqual([
      ["anthropic/claude-fable-5", "inactive"],
      ["deepseek/deepseek-v4-flash", "active"],
      ["deepseek/deepseek-v4-pro", "unbillable"],
    ])
    expect(wallet.models[2]!.hint).toContain("no connected wallet can bill this model on openrouter")
    expect(wallet.catalogCount).toBe(3)
    expect(wallet.allowedCount).toBe(3)
    expect(wallet.activeCount).toBe(1)
    expect(wallet.curationMode).toBe("all")
    expect(wallet.models[0]!.price).toBe("$10/$50 per 1M")
  })

  it("marks curated-out models allowed=false and collects unlisted allowlist ids", () => {
    const view = buildAuthExplorerView(
      data({
        profiles: [
          profile({ models: { mode: "allow", ids: ["deepseek/deepseek-v4-flash", "deepseek/typo-model"] } }),
        ],
      }),
    )
    const wallet = view.providers[0]!.wallets[0]!
    expect(wallet.curationMode).toBe("allow")
    expect(wallet.models.map(m => [m.writeId, m.allowed])).toEqual([
      ["anthropic/claude-fable-5", false],
      ["deepseek/deepseek-v4-flash", true],
      ["deepseek/deepseek-v4-pro", false],
    ])
    expect(wallet.unlistedIds).toEqual(["deepseek/typo-model"])
  })

  it("disables every model row when the wallet is disabled", () => {
    const view = buildAuthExplorerView(data({ profiles: [profile({ disabled: true })] }))
    const wallet = view.providers[0]!.wallets[0]!
    expect(wallet.enabled).toBe(false)
    expect(wallet.models.every(m => m.status === "inactive")).toBe(true)
    expect(wallet.models[0]!.hint).toContain("wallet disabled")
  })
})

describe("buildAuthExplorerView — presets, links, pivot", () => {
  const userPresets: UserPreset[] = [
    { id: "fav-1", label: "Cheap", harness: "hermes", model: "deepseek-v4-flash", access: { profileRef: "openrouter-env" } },
    { id: "fav-2", label: "Other", adapter: "codex", model: "gpt-x" },
  ]

  it("groups user presets under their harness and back-links them on the wallet", () => {
    const view = buildAuthExplorerView(
      data({
        adapters: [{ slug: "hermes" }, { slug: "codex" }],
        userPresets,
      }),
    )
    const hermes = view.harnesses.find(h => h.slug === "hermes")!
    expect(hermes.presets.map(p => p.id)).toEqual(["fav-1"])
    const wallet = view.providers[0]!.wallets[0]!
    expect(wallet.usedByPresets.map(p => p.id)).toEqual(["fav-1"])
    expect(view.counts.presets).toBe(2)
  })

  it("exposes upstream link state on the provider and back-links it on the wallet", () => {
    const links: LlmEndpointLinksResult = {
      links: { openrouter: "openrouter-env" },
      upstreams: [
        {
          provider: "openrouter",
          linkedProfile: "openrouter-env",
          eligible: [{ id: "openrouter-env", label: "OpenRouter (env key)", method: "api-key", endpoint: "openrouter" }],
        },
      ],
    }
    const view = buildAuthExplorerView(data({ links }))
    const provider = view.providers[0]!
    expect(provider.upstream).toEqual({
      linkedProfile: "openrouter-env",
      eligible: [{ id: "openrouter-env", label: "OpenRouter (env key)" }],
    })
    expect(provider.wallets[0]!.upstreamOf).toEqual(["openrouter"])
  })

  it("pivots models served actively by two or more wallets", () => {
    const second = profile({ id: "openrouter-2" })
    const cat = catalog(["openrouter-env", "openrouter-2"])
    const view = buildAuthExplorerView(data({ profiles: [profile(), second], catalog: cat }))
    expect(view.multiServed.map(m => [m.key, m.servedBy.length])).toEqual([
      ["deepseek/deepseek-v4-flash", 2],
    ])
  })
})

describe("toggleWalletModel / toggleWalletVendor", () => {
  const wallet = () => buildAuthExplorerView(data()).providers[0]!.wallets[0]!

  it("narrows an 'all' wallet to an explicit allowlist when toggling one off", () => {
    expect(toggleWalletModel(wallet(), "deepseek/deepseek-v4-pro")).toEqual({
      mode: "allow",
      ids: ["anthropic/claude-fable-5", "deepseek/deepseek-v4-flash"],
    })
  })

  it("returns to 'all' when the last missing model is toggled back on", () => {
    const view = buildAuthExplorerView(
      data({
        profiles: [
          profile({ models: { mode: "allow", ids: ["anthropic/claude-fable-5", "deepseek/deepseek-v4-flash"] } }),
        ],
      }),
    )
    expect(toggleWalletModel(view.providers[0]!.wallets[0]!, "deepseek/deepseek-v4-pro")).toEqual({
      mode: "all",
      ids: [],
    })
  })

  it("preserves unlisted allowlist ids across a toggle", () => {
    const view = buildAuthExplorerView(
      data({
        profiles: [profile({ models: { mode: "allow", ids: ["deepseek/deepseek-v4-flash", "deepseek/typo-model"] } })],
      }),
    )
    expect(toggleWalletModel(view.providers[0]!.wallets[0]!, "deepseek/deepseek-v4-pro")).toEqual({
      mode: "allow",
      ids: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "deepseek/typo-model"],
    })
  })

  it("vendor toggle selects all when partially on, deselects all when fully on", () => {
    const partial = buildAuthExplorerView(
      data({ profiles: [profile({ models: { mode: "allow", ids: ["deepseek/deepseek-v4-flash"] } })] }),
    ).providers[0]!.wallets[0]!
    expect(toggleWalletVendor(partial, "deepseek")).toEqual({
      mode: "allow",
      ids: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
    })
    const full = wallet()
    expect(toggleWalletVendor(full, "deepseek")).toEqual({
      mode: "allow",
      ids: ["anthropic/claude-fable-5"],
    })
  })
})
