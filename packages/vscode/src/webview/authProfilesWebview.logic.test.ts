import { describe, expect, it } from "vitest"

import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  LlmEndpointStatusResult,
  ProviderPresetEntry,
} from "../client/types.js"
import { accessKind } from "./authModelMindmap.logic.js"
import { profileCuratedIds } from "../views/authProfilesTree.logic.js"
import {
  buildAuthProfilesWebviewModel,
  routerStatusFor,
  type AuthProfilesExpandedState,
} from "./authProfilesWebview.logic.js"

function preset(over: Partial<ProviderPresetEntry> = {}): ProviderPresetEntry {
  const slug = over.slug ?? "anthropic"
  const name = over.name ?? slug.charAt(0).toUpperCase() + slug.slice(1)
  return {
    slug,
    name,
    status: "ready",
    info: { schemaFlavor: "openai", baseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY" },
    ...over,
  }
}

function profile(over: Partial<AuthProfileSummary> = {}): AuthProfileSummary {
  return { id: "anthropic-local", endpoint: "anthropic", method: "oauth-bearer", ...over }
}

const NO_CATALOG: CatalogModelsResponse = { vendors: [] }

function xaiCatalog(opts: { allowedIds?: string[] } = {}): CatalogModelsResponse {
  const products = ["grok-4.5", "grok-4.20", "grok-4.20-reasoning", "grok-4.20-multi-agent", "grok-4.3", "grok-build-0.1"]
  return {
    vendors: [
      {
        vendor: "xai",
        products: products.map(product => {
          const ref = `xai/${product}`
          const isAllowed = !opts.allowedIds || opts.allowedIds.includes(ref)
          return {
            product,
            routes: [
              {
                route: "xai",
                ref,
                baseUrl: null,
                pricing: null,
                runnable: isAllowed,
                eligibleProfiles: isAllowed ? ["xai-api"] : [],
                adapterModes: [],
                adapters: [],
                curated: false,
              },
            ],
          }
        }),
      },
    ],
  }
}

const ALL_EXPANDED: AuthProfilesExpandedState = { providers: true, router: true }

const STOPPED_ROUTER: LlmEndpointStatusResult | null = {
  running: false,
  pid: null,
  port: null,
  baseUrl: null,
  healthy: false,
  startedAt: null,
  status: "never-started",
}

const RUNNING_ROUTER: LlmEndpointStatusResult = {
  running: true,
  pid: 123,
  port: 18090,
  baseUrl: "http://localhost:18090",
  healthy: true,
  startedAt: "2026-01-01T00:00:00Z",
  status: "running",
}

describe("routerStatusFor", () => {
  it("is ready when serving", () => {
    expect(routerStatusFor(RUNNING_ROUTER)).toBe("ready")
  })

  it("is available while running but not healthy or starting", () => {
    expect(routerStatusFor({ ...RUNNING_ROUTER, healthy: false })).toBe("available")
    expect(routerStatusFor({ ...RUNNING_ROUTER, status: "starting" })).toBe("available")
  })

  it("is dim when stopped or missing", () => {
    expect(routerStatusFor(STOPPED_ROUTER)).toBe("dim")
    expect(routerStatusFor(null)).toBe("dim")
  })
})

describe("buildAuthProfilesWebviewModel", () => {
  it("groups profiles into provider columns with the mind map's accessKind, single-source-of-truth", () => {
    const anthropicSub = profile({ id: "anthropic-sub", endpoint: "anthropic", method: "oauth-bearer", source: "claude-code-oauth" })
    const anthropicKey = profile({ id: "anthropic-key", endpoint: "anthropic", method: "api-key" })
    const model = buildAuthProfilesWebviewModel(
      [],
      [anthropicSub, anthropicKey],
      NO_CATALOG,
      STOPPED_ROUTER,
      "",
      ALL_EXPANDED,
      false,
    )
    const anthropic = model.providers.rows.find(p => p.endpoint === "anthropic")!
    expect(anthropic.subscriptionCount).toBe(1)
    expect(anthropic.apiKeyCount).toBe(1)
    const sub = anthropic.wallets.find(w => w.id === "anthropic-sub")!
    const key = anthropic.wallets.find(w => w.id === "anthropic-key")!
    // The webview's per-wallet access kind must equal what the mind map's
    // accessKind() computes directly — no duplicated classification.
    expect(sub.accessKind).toBe(accessKind(anthropicSub))
    expect(key.accessKind).toBe(accessKind(anthropicKey))
  })

  it("marks a disabled wallet's enabled flag false", () => {
    const model = buildAuthProfilesWebviewModel(
      [],
      [profile({ id: "disabled", disabled: true })],
      NO_CATALOG,
      STOPPED_ROUTER,
      "",
      ALL_EXPANDED,
      false,
    )
    const wallet = model.providers.rows[0]!.wallets[0]!
    expect(wallet.enabled).toBe(false)
  })

  it("folds long-tail providers behind 'more' at the same count as the map", () => {
    const profiles = Array.from({ length: 8 }, (_, i) => profile({ id: `p${i}`, endpoint: `endpoint${i}` }))
    const model = buildAuthProfilesWebviewModel([], profiles, NO_CATALOG, STOPPED_ROUTER, "", ALL_EXPANDED, false)
    expect(model.providers.rows).toHaveLength(6)
    expect(model.moreCount).toBe(2)
  })

  it("shows every provider once showAllProviders is set", () => {
    const profiles = Array.from({ length: 8 }, (_, i) => profile({ id: `p${i}`, endpoint: `endpoint${i}` }))
    const model = buildAuthProfilesWebviewModel([], profiles, NO_CATALOG, STOPPED_ROUTER, "", ALL_EXPANDED, true)
    expect(model.providers.rows).toHaveLength(8)
    expect(model.moreCount).toBe(0)
  })

  it("lists presets with no wallet yet as unconnected", () => {
    const model = buildAuthProfilesWebviewModel(
      [preset({ slug: "anthropic" }), preset({ slug: "openai", name: "OpenAI" })],
      [profile({ id: "anthropic-local", endpoint: "anthropic" })],
      NO_CATALOG,
      STOPPED_ROUTER,
      "",
      ALL_EXPANDED,
      false,
    )
    expect(model.unconnected.map(u => u.slug)).toEqual(["openai"])
    expect(model.providers.rows.map(p => p.endpoint)).toEqual(["anthropic"])
  })

  it("renders router status in its own section", () => {
    const model = buildAuthProfilesWebviewModel([], [], NO_CATALOG, RUNNING_ROUTER, "", ALL_EXPANDED, false)
    expect(model.router.rows[0]?.status).toBe("ready")
    expect(model.router.rows[0]?.name).toContain("running")
    expect(String(model.router.count)).toBe("healthy")
  })

  it("filters providers and unconnected presets by search", () => {
    const model = buildAuthProfilesWebviewModel(
      [preset({ slug: "openai", name: "OpenAI" })],
      [profile({ id: "anthropic-local", endpoint: "anthropic" })],
      NO_CATALOG,
      STOPPED_ROUTER,
      "anthropic",
      ALL_EXPANDED,
      false,
    )
    expect(model.providers.rows.map(p => p.endpoint)).toEqual(["anthropic"])
    expect(model.unconnected).toHaveLength(0)
  })

  it("honors expanded state per section", () => {
    const collapsed: AuthProfilesExpandedState = { providers: false, router: false }
    const model = buildAuthProfilesWebviewModel([], [], NO_CATALOG, STOPPED_ROUTER, "", collapsed, false)
    expect(model.providers.expanded).toBe(false)
    expect(model.router.expanded).toBe(false)
  })
})

describe("buildAuthProfilesWebviewModel — curation summary (migrated from Auth Settings)", () => {
  it("summarizes curated vs active in a single terse line, not a chip wall", () => {
    const allowed = ["xai/grok-4.5", "xai/grok-4.3", "xai/grok-4.20", "xai/grok-build-0.1"]
    const p = profile({ id: "xai-api", endpoint: "xai", models: { mode: "allow", ids: allowed } })
    const model = buildAuthProfilesWebviewModel([], [p], xaiCatalog({ allowedIds: allowed }), STOPPED_ROUTER, "", ALL_EXPANDED, false)
    const wallet = model.providers.rows[0]!.wallets[0]!
    expect(wallet.curationSummary).toBe("4 curated · 4 active")
  })

  it("reports a disabled wallet's summary without implying a broken credential", () => {
    const p = profile({ id: "xai-api", endpoint: "xai", disabled: true })
    const model = buildAuthProfilesWebviewModel([], [p], xaiCatalog(), STOPPED_ROUTER, "", ALL_EXPANDED, false)
    const wallet = model.providers.rows[0]!.wallets[0]!
    expect(wallet.curationSummary).toBe("0 active · 6 catalog (disabled)")
  })

  it("reports 'no catalog models' when nothing in the catalog bills this endpoint", () => {
    const model = buildAuthProfilesWebviewModel([], [profile({ id: "anthropic-local" })], NO_CATALOG, STOPPED_ROUTER, "", ALL_EXPANDED, false)
    const wallet = model.providers.rows[0]!.wallets[0]!
    expect(wallet.curationSummary).toBe("no catalog models")
  })

  it("carries the curated ids straight from profileCuratedIds — single source of truth", () => {
    const p = profile({ id: "anthropic-local", models: { mode: "allow", ids: ["anthropic/claude-fable-5"] } })
    const model = buildAuthProfilesWebviewModel([], [p], NO_CATALOG, STOPPED_ROUTER, "", ALL_EXPANDED, false)
    const wallet = model.providers.rows[0]!.wallets[0]!
    expect(wallet.curatedIds).toEqual(profileCuratedIds(p))
  })

  it("keeps native xai and xai-anthropic profiles from cross-qualifying", () => {
    const xaiP = profile({ id: "xai-api", endpoint: "xai" })
    const model = buildAuthProfilesWebviewModel([], [xaiP], xaiCatalog(), STOPPED_ROUTER, "", ALL_EXPANDED, false)
    const wallet = model.providers.rows[0]!.wallets[0]!
    expect(wallet.curationSummary).toBe("6 curated · 6 active")
  })
})
