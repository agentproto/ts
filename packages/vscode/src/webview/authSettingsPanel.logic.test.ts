import { describe, expect, it } from "vitest"

import {
  buildAuthSettingsHtml,
  buildAuthSettingsModel,
  esc,
} from "./authSettingsPanel.logic.js"
import { accessKind } from "./authModelMindmap.logic.js"
import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  ProviderPresetEntry,
} from "../client/types.js"

const catalog: CatalogModelsResponse = {
  vendors: [
    {
      vendor: "anthropic",
      products: [
        {
          product: "claude-fable-5",
          routes: [
            { route: "openrouter", ref: "anthropic/claude-fable-5", baseUrl: null, pricing: null, runnable: true, eligibleProfiles: ["openrouter-api"], adapterModes: [], adapters: [], curated: true },
            { route: "anthropic", ref: "claude-fable-5", baseUrl: null, pricing: null, runnable: false, eligibleProfiles: ["anthropic-sub"], adapterModes: [], adapters: [], curated: true },
          ],
        },
      ],
    },
  ],
}

const presets: ProviderPresetEntry[] = [
  { slug: "openrouter", name: "OpenRouter", status: "ready", info: { schemaFlavor: "openai", baseUrl: "x", keyEnv: "OPENROUTER_API_KEY" } },
  { slug: "moonshot", name: "Moonshot", status: "available", info: { schemaFlavor: "openai", baseUrl: "x", keyEnv: "MOONSHOT_API_KEY" } },
]

const profiles: AuthProfileSummary[] = [
  { id: "openrouter-api", endpoint: "openrouter", method: "api-key" },
  { id: "anthropic-sub", endpoint: "anthropic", method: "oauth-bearer", label: "My sub" },
]

const XAI_PRODUCTS = [
  "grok-4.5",
  "grok-4.20",
  "grok-4.20-reasoning",
  "grok-4.20-multi-agent",
  "grok-4.3",
  "grok-build-0.1",
]

function xaiCatalog(opts: { allowedIds?: string[] } = {}): CatalogModelsResponse {
  return {
    vendors: [
      {
        vendor: "xai",
        products: XAI_PRODUCTS.map(product => {
          const xaiRef = `xai/${product}`
          const isAllowed = !opts.allowedIds || opts.allowedIds.includes(xaiRef)
          return {
            product,
            routes: [
              {
                route: "xai",
                ref: xaiRef,
                baseUrl: null,
                pricing: null,
                runnable: isAllowed,
                eligibleProfiles: isAllowed ? ["xai-api"] : [],
                adapterModes: [],
                adapters: [],
                curated: false,
              },
              {
                route: "xai-anthropic",
                ref: `xai/${product}@xai-anthropic`,
                baseUrl: null,
                pricing: null,
                runnable: true,
                eligibleProfiles: ["xai-anthropic-api"],
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

describe("buildAuthSettingsModel", () => {
  it("carries the mind map's accessKind per wallet — single source of truth", () => {
    const subProfile: AuthProfileSummary = {
      id: "anthropic-refresh",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: "claude-code-oauth",
    }
    const model = buildAuthSettingsModel(presets, catalog, [...profiles, subProfile])
    const wallet = model.wallets.find(w => w.id === "anthropic-refresh")!
    expect(wallet.accessKind).toBe(accessKind(subProfile))
    expect(wallet.accessKind).toBe("subscription-refreshing")
  })

  it("marks presets connected and sorts unconnected first", () => {
    const model = buildAuthSettingsModel(presets, catalog, profiles)
    expect(model.presets.map(p => [p.slug, p.connected])).toEqual([
      ["moonshot", false],
      ["openrouter", true],
    ])
  })

  it("attaches serviced models + runnable count per wallet, busiest first", () => {
    const model = buildAuthSettingsModel(presets, catalog, profiles)
    const or = model.wallets.find(w => w.id === "openrouter-api")!
    expect(or.models.map(m => m.product)).toEqual(["claude-fable-5"])
    expect(or.runnableCount).toBe(1)
    expect(or.catalogCount).toBe(1)
    const sub = model.wallets.find(w => w.id === "anthropic-sub")!
    expect(sub.runnableCount).toBe(0) // eligible but the route isn't runnable
    expect(sub.catalogCount).toBe(1)
    expect(sub.label).toBe("My sub")
  })

  it("carries the real enable/disable state, key identity, and curation (WS2/WS3/WS5)", () => {
    const model = buildAuthSettingsModel(presets, catalog, [
      {
        id: "openrouter-api",
        endpoint: "openrouter",
        method: "api-key",
        disabled: true,
        keyStatus: "stored",
        fingerprint: "fp0000000000",
        last4: "abcd",
        models: { mode: "allow", ids: ["anthropic/claude-fable-5"] },
      },
    ])
    const w = model.wallets.find(x => x.id === "openrouter-api")!
    expect(w.enabled).toBe(false)
    expect(w.keyLabel).toBe("••••abcd · fp0000000000")
    expect(w.curatedIds).toEqual(["anthropic/claude-fable-5"])
  })

  it("carries the imported-from provenance (WS6)", () => {
    const model = buildAuthSettingsModel(presets, catalog, [
      { id: "env-openrouter", endpoint: "openrouter", method: "api-key", origin: "env" },
      { id: "openrouter-api", endpoint: "openrouter", method: "api-key" },
    ])
    expect(model.wallets.find(w => w.id === "env-openrouter")!.origin).toBe("env")
    // A hand-created profile has no origin.
    expect(model.wallets.find(w => w.id === "openrouter-api")!.origin).toBeUndefined()
  })

  it("counts every xAI catalog model for a native xai profile, not just curated ones", () => {
    const allowed = [
      "xai/grok-4.5",
      "xai/grok-4.3",
      "xai/grok-4.20",
      "xai/grok-build-0.1",
    ]
    const model = buildAuthSettingsModel(
      [],
      xaiCatalog({ allowedIds: allowed }),
      [{ id: "xai-api", endpoint: "xai", method: "api-key", models: { mode: "allow", ids: allowed } }],
    )
    const w = model.wallets.find(x => x.id === "xai-api")!
    expect(w.catalogCount).toBe(6)
    expect(w.curatedCount).toBe(4)
    expect(w.runnableCount).toBe(4)
    expect(w.models).toHaveLength(4)
    expect(w.unavailable).toHaveLength(2)
    expect(w.unavailable.every(u => u.reason === "curated out")).toBe(true)
  })

  it("keeps native xai and xai-anthropic profiles from cross-qualifying", () => {
    const model = buildAuthSettingsModel(
      [],
      xaiCatalog(),
      [{ id: "xai-anthropic-api", endpoint: "xai-anthropic", method: "api-key" }],
    )
    const w = model.wallets.find(x => x.id === "xai-anthropic-api")!
    expect(w.catalogCount).toBe(6)
    expect(w.curatedCount).toBe(6)
    expect(w.runnableCount).toBe(6)
    expect(w.models.map(m => m.route)).toEqual(Array(6).fill("xai-anthropic"))
  })

  it("reports a disabled xai profile as 0 runnable without blaming credentials", () => {
    const model = buildAuthSettingsModel(
      [],
      xaiCatalog(),
      [{ id: "xai-api", endpoint: "xai", method: "api-key", disabled: true }],
    )
    const w = model.wallets.find(x => x.id === "xai-api")!
    expect(w.enabled).toBe(false)
    expect(w.catalogCount).toBe(6)
    expect(w.runnableCount).toBe(0)
    expect(w.unavailable).toHaveLength(0)
  })
})

describe("buildAuthSettingsHtml", () => {
  it("renders an access-kind chip per wallet, matching the mind map's vocabulary", () => {
    const model = buildAuthSettingsModel(presets, catalog, [
      { id: "anthropic-sub", endpoint: "anthropic", method: "oauth-bearer", source: "claude-code-oauth" },
      { id: "openrouter-api", endpoint: "openrouter", method: "api-key" },
    ])
    const html = buildAuthSettingsHtml(model, "NONCE123")
    expect(html).toContain('class="badge kind-sub">SUB · SELF-REFRESH')
    expect(html).toContain('class="badge kind-key">API KEY')
  })

  it("renders a Connect button only for unconnected presets and echoes the nonce", () => {
    const model = buildAuthSettingsModel(presets, catalog, profiles)
    const html = buildAuthSettingsHtml(model, "NONCE123")
    expect(html).toContain('nonce="NONCE123"')
    expect(html).toContain('data-action="connect" data-slug="moonshot"')
    expect(html).not.toContain('data-slug="openrouter"') // connected → no connect button
    expect(html).toContain('data-action="delete" data-id="openrouter-api"')
    expect(html).toContain("claude-fable-5")
  })

  it("renders an 'imported from <origin>' badge for an imported wallet (WS6)", () => {
    const model = buildAuthSettingsModel(presets, catalog, [
      { id: "env-openrouter", endpoint: "openrouter", method: "api-key", origin: "env" },
    ])
    const html = buildAuthSettingsHtml(model, "NONCE123")
    expect(html).toContain("imported from env")
  })

  it("surfaces a source-backed local-login button in the Providers section", () => {
    const model = buildAuthSettingsModel(presets, catalog, profiles)
    const html = buildAuthSettingsHtml(model, "NONCE123")
    expect(html).toContain('data-action="connectLocal" data-source="claude-code-oauth"')
    expect(html).toContain("Use an existing local login")
    // The dispatcher must forward the source attribute for these buttons.
    expect(html).toContain("data-source")
  })

  it("renders a real disable/enable toggle and the read-only key line (WS2/WS5)", () => {
    const model = buildAuthSettingsModel(presets, catalog, [
      {
        id: "openrouter-api",
        endpoint: "openrouter",
        method: "api-key",
        keyStatus: "stored",
        fingerprint: "fp0000000000",
        last4: "abcd",
      },
    ])
    const html = buildAuthSettingsHtml(model, "NONCE123")
    // Enabled → offers Disable, badge reads "enabled", key line is present.
    expect(html).toContain('data-action="disable" data-id="openrouter-api"')
    expect(html).toContain(">enabled<")
    expect(html).toContain("••••abcd · fp0000000000")
  })

  it("offers Enable for a disabled wallet (WS2)", () => {
    const model = buildAuthSettingsModel(presets, catalog, [
      { id: "openrouter-api", endpoint: "openrouter", method: "api-key", disabled: true },
    ])
    const html = buildAuthSettingsHtml(model, "NONCE123")
    expect(html).toContain('data-action="enable" data-id="openrouter-api"')
    expect(html).toContain(">disabled<")
  })

  it("renders the WS4 '+ Models' picker button and removable curated chips", () => {
    const model = buildAuthSettingsModel(presets, catalog, [
      {
        id: "openrouter-api",
        endpoint: "openrouter",
        method: "api-key",
        models: { mode: "allow", ids: ["anthropic/claude-fable-5"] },
      },
    ])
    const html = buildAuthSettingsHtml(model, "NONCE123")
    // The "+" picker opens on the wallet id.
    expect(html).toContain('data-action="pickModels" data-id="openrouter-api"')
    // Each curated chip carries a remove toggle keyed by wallet id + model id.
    expect(html).toContain(
      'data-action="removeModel" data-id="openrouter-api" data-model="anthropic/claude-fable-5"',
    )
  })

  it("renders a catalog summary instead of a misleading active/total badge", () => {
    const allowed = ["xai/grok-4.5"]
    const model = buildAuthSettingsModel(
      [],
      xaiCatalog({ allowedIds: allowed }),
      [
        {
          id: "xai-api",
          endpoint: "xai",
          method: "api-key",
          models: { mode: "allow", ids: allowed },
        },
      ],
    )
    const html = buildAuthSettingsHtml(model, "NONCE123")
    expect(html).toContain("1 curated · 6 catalog · 1 active (5 excluded by curation)")
    expect(html).not.toContain("active /")
    // The five excluded models are surfaced as unavailable pills with a reason.
    expect(html).toContain('title="xai/grok-4.3 · curated out"')
  })

  it("renders a disabled profile summary without implying a broken credential", () => {
    const model = buildAuthSettingsModel(
      [],
      xaiCatalog(),
      [{ id: "xai-api", endpoint: "xai", method: "api-key", disabled: true }],
    )
    const html = buildAuthSettingsHtml(model, "NONCE123")
    expect(html).toContain("0 active · 6 catalog (profile disabled)")
    expect(html).toContain("Profile disabled — no models active.")
  })
  it("labels an uncurated wallet 'Allows all eligible models' with no remove chips", () => {
    const model = buildAuthSettingsModel(presets, catalog, [
      { id: "openrouter-api", endpoint: "openrouter", method: "api-key" },
    ])
    const html = buildAuthSettingsHtml(model, "NONCE123")
    expect(html).toContain("Allows all eligible models")
    expect(html).not.toContain('data-action="removeModel"')
    // The picker is still offered so an uncurated wallet can start curating.
    expect(html).toContain('data-action="pickModels" data-id="openrouter-api"')
  })

  it("escapes interpolated text", () => {
    expect(esc(`<b>"x"&'y'`)).toBe("&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;")
  })
})
