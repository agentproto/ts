import { describe, expect, it } from "vitest"

import {
  buildAuthSettingsHtml,
  buildAuthSettingsModel,
  esc,
} from "./authSettingsPanel.logic.js"
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

describe("buildAuthSettingsModel", () => {
  it("marks presets connected and sorts unconnected first", () => {
    const model = buildAuthSettingsModel(presets, catalog, profiles)
    expect(model.presets.map(p => [p.slug, p.connected])).toEqual([
      ["moonshot", false],
      ["openrouter", true],
    ])
  })

  it("attaches serviced models + active count per wallet, busiest first", () => {
    const model = buildAuthSettingsModel(presets, catalog, profiles)
    const or = model.wallets.find(w => w.id === "openrouter-api")!
    expect(or.models.map(m => m.product)).toEqual(["claude-fable-5"])
    expect(or.activeCount).toBe(1)
    const sub = model.wallets.find(w => w.id === "anthropic-sub")!
    expect(sub.activeCount).toBe(0) // eligible but the route isn't runnable
    expect(sub.label).toBe("My sub")
  })
})

describe("buildAuthSettingsHtml", () => {
  it("renders a Connect button only for unconnected presets and echoes the nonce", () => {
    const model = buildAuthSettingsModel(presets, catalog, profiles)
    const html = buildAuthSettingsHtml(model, "NONCE123")
    expect(html).toContain('nonce="NONCE123"')
    expect(html).toContain('data-action="connect" data-slug="moonshot"')
    expect(html).not.toContain('data-slug="openrouter"') // connected → no connect button
    expect(html).toContain('data-action="delete" data-id="openrouter-api"')
    expect(html).toContain("claude-fable-5")
  })

  it("escapes interpolated text", () => {
    expect(esc(`<b>"x"&'y'`)).toBe("&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;")
  })
})
