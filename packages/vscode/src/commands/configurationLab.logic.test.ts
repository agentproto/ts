import { describe, expect, it } from "vitest"

import type {
  AdapterInfo,
  AuthProfileSummary,
  CatalogModelsResponse,
  ConfigurationLabRawData,
  ConfigurationLabSelectionInput,
  HarnessCapabilities,
} from "../client/types.js"
import {
  buildConfigurationLabSnapshot,
  fetchConfigurationLabData,
  findAdapter,
  findHarnessCapabilities,
  labSelectionToSpawnArgs,
} from "./configurationLab.logic.js"

function adapter(overrides: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    slug: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    protocol: "acp",
    models: ["claude-opus-4-8", "claude-sonnet-5"],
    modelDetails: [
      { id: "claude-opus-4-8", provider: "anthropic" },
      { id: "claude-sonnet-5", provider: "anthropic" },
    ],
    modes: [{ id: "plan" }, { id: "default" }],
    status: "ready",
    ...overrides,
  }
}

function capabilities(overrides: Partial<HarnessCapabilities> = {}): HarnessCapabilities {
  return {
    adapter: "claude-code",
    source: "discovered",
    authStores: ["keychain"],
    providers: [{ id: "anthropic", ready: true }],
    models: { defaultModel: "claude-sonnet-5", supported: ["claude-opus-4-8", "claude-sonnet-5"] },
    application: { defaultOptions: { skills: "agentproto" }, supportedOptions: ["skills"] },
    ...overrides,
  }
}

function profile(overrides: Partial<AuthProfileSummary> = {}): AuthProfileSummary {
  return {
    id: "anthropic-sub",
    endpoint: "anthropic",
    method: "oauth-bearer",
    label: "Anthropic Subscription",
    keyStatus: "stored",
    ...overrides,
  }
}

function catalog(): CatalogModelsResponse {
  return {
    vendors: [
      {
        vendor: "anthropic",
        products: [
          {
            product: "claude-opus-4-8",
            routes: [
              {
                route: "anthropic",
                ref: "anthropic/claude-opus-4-8",
                baseUrl: null,
                pricing: null,
                runnable: true,
                eligibleProfiles: ["anthropic-sub"],
                adapterModes: ["default"],
                adapters: ["claude-code"],
                curated: true,
              },
            ],
          },
          {
            product: "claude-sonnet-5",
            routes: [
              {
                route: "anthropic",
                ref: "anthropic/claude-sonnet-5",
                baseUrl: null,
                pricing: null,
                runnable: true,
                eligibleProfiles: ["anthropic-sub"],
                adapterModes: ["default"],
                adapters: ["claude-code"],
                curated: true,
              },
            ],
          },
        ],
      },
    ],
  }
}

function rawData(overrides: Partial<ConfigurationLabRawData> = {}): ConfigurationLabRawData {
  return {
    adapters: [adapter()],
    capabilities: [capabilities()],
    catalog: catalog(),
    profiles: [profile()],
    presets: [],
    ...overrides,
  }
}

describe("findAdapter", () => {
  it("returns the matching adapter", () => {
    const a = adapter({ slug: "codex" })
    expect(findAdapter([adapter(), a], "codex")?.slug).toBe("codex")
  })

  it("returns undefined when no slug is given", () => {
    expect(findAdapter([adapter()], undefined)).toBeUndefined()
  })
})

describe("findHarnessCapabilities", () => {
  it("returns the matching capabilities", () => {
    expect(findHarnessCapabilities([capabilities()], "claude-code")?.adapter).toBe("claude-code")
  })
})

describe("buildConfigurationLabSnapshot", () => {
  it("returns a blank snapshot when no harness is selected", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), {})
    expect(snapshot.harness).toBeNull()
    expect(snapshot.axes.models).toHaveLength(0)
    expect(snapshot.issues[0]?.message).toContain("Select a harness")
  })

  it("populates the harness layer when an adapter is selected", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), { adapter: "claude-code" })
    expect(snapshot.harness?.slug).toBe("claude-code")
    expect(snapshot.harness?.name).toBe("Claude Code")
    expect(snapshot.harness?.capabilities?.models?.defaultModel).toBe("claude-sonnet-5")
  })

  it("seeds the default model when only a harness is selected", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), { adapter: "claude-code" })
    expect(snapshot.selection.model).toBe("claude-sonnet-5")
    expect(snapshot.axes.models.map((m) => m.id)).toContain("claude-opus-4-8")
  })

  it("tags explicit selections as explicit and defaults as default", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), {
      adapter: "claude-code",
      model: "claude-opus-4-8",
      posture: "plan",
    })
    const byKey = Object.fromEntries(snapshot.effective.map((f) => [f.key, f]))
    expect(byKey["Harness"]?.source).toBe("explicit")
    expect(byKey["Model"]?.value).toBe("claude-opus-4-8")
    expect(byKey["Model"]?.source).toBe("explicit")
    expect(byKey["Posture"]?.value).toBe("plan")
    expect(byKey["Posture"]?.source).toBe("explicit")
    expect(byKey["Route / gateway"]?.source).toBe("default")
    expect(byKey["Route / gateway"]?.value).toBe("anthropic")
    expect(byKey["Auth profile"]?.source).toBe("default")
    expect(byKey["Auth profile"]?.value).toBe("anthropic-sub")
  })

  it("marks route rows runnable based on eligible profiles", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), {
      adapter: "claude-code",
      model: "claude-opus-4-8",
    })
    const route = snapshot.axes.routes.find((r) => r.value === "anthropic")
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toContain("anthropic-sub")
  })

  it("flags an ineligible profile selection as an error", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), {
      adapter: "claude-code",
      model: "claude-opus-4-8",
      route: "anthropic",
      profile: "some-other-profile",
    })
    const error = snapshot.issues.find((i) => i.severity === "error")
    expect(error?.axis).toBe("profile")
    expect(error?.message).toContain("not eligible")
  })

  it("flags a non-runnable route as an error", () => {
    const data = rawData({
      catalog: {
        vendors: [
          {
            vendor: "anthropic",
            products: [
              {
                product: "claude-opus-4-8",
                routes: [
                  {
                    route: "anthropic",
                    ref: "anthropic/claude-opus-4-8",
                    baseUrl: null,
                    pricing: null,
                    runnable: false,
                    eligibleProfiles: [],
                    adapterModes: [],
                    adapters: ["claude-code"],
                    curated: true,
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    const snapshot = buildConfigurationLabSnapshot(data, {
      adapter: "claude-code",
      model: "claude-opus-4-8",
      route: "anthropic",
    })
    const error = snapshot.issues.find((i) => i.severity === "error" && i.axis === "route")
    expect(error?.message).toContain("no eligible auth profile")
  })

  it("flags an unsupported effort as a warning", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), {
      adapter: "claude-code",
      model: "claude-opus-4-8",
      effort: "ultracode",
    })
    const warning = snapshot.issues.find((i) => i.severity === "warning" && i.axis === "effort")
    expect(warning?.message).toContain("not offered")
  })

  it("warns about custom models not in the declared list", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), {
      adapter: "claude-code",
      model: "custom-model",
    })
    const warning = snapshot.issues.find((i) => i.severity === "warning" && i.axis === "model")
    expect(warning?.message).toContain("not in claude-code's declared model list")
  })

  it("warns about advisory postures", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), {
      adapter: "claude-code",
      model: "claude-opus-4-8",
      posture: "bypass",
    })
    const warning = snapshot.issues.find((i) => i.severity === "warning" && i.axis === "posture")
    expect(warning?.message).toContain("advisory")
  })

  it("surfaces Codex's fixed OpenAI route and eligible profiles", () => {
    const data = rawData({
      adapters: [
        adapter({
          slug: "codex",
          name: "Codex",
          models: ["gpt-5-codex"],
          modelDetails: [{ id: "gpt-5-codex", provider: "openai" }],
        }),
      ],
      capabilities: [
        capabilities({
          adapter: "codex",
          models: { defaultModel: "gpt-5-codex", supported: ["gpt-5-codex"] },
          providers: [{ id: "openai", ready: true }],
        }),
      ],
      catalog: {
        vendors: [
          {
            vendor: "openai",
            products: [
              {
                product: "gpt-5-codex",
                routes: [
                  {
                    route: "openai",
                    ref: "openai/gpt-5-codex",
                    baseUrl: null,
                    pricing: null,
                    runnable: true,
                    eligibleProfiles: ["openai-api"],
                    adapterModes: ["default"],
                    adapters: ["codex"],
                    curated: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      profiles: [profile({ id: "openai-api", endpoint: "openai", label: "OpenAI API Key" })],
    })
    const snapshot = buildConfigurationLabSnapshot(data, { adapter: "codex" })
    const route = snapshot.axes.routes.find((r) => r.value === "openai")
    expect(route).toBeDefined()
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toContain("openai-api")
    expect(snapshot.selection.route).toBe("openai")
    expect(snapshot.selection.profile).toBe("openai-api")
    const byKey = Object.fromEntries(snapshot.effective.map((f) => [f.key, f]))
    expect(byKey["Route / gateway"]?.source).toBe("default")
    expect(byKey["Route / gateway"]?.value).toBe("openai")
    expect(byKey["Auth profile"]?.source).toBe("default")
    expect(byKey["Auth profile"]?.value).toBe("openai-api")
  })

  it("synthesizes a native OpenAI route for Codex when the catalog is sparse", () => {
    const data = rawData({
      adapters: [
        adapter({
          slug: "codex",
          name: "Codex",
          models: ["gpt-5-codex"],
          modelDetails: [{ id: "gpt-5-codex", provider: "openai" }],
        }),
      ],
      capabilities: [
        capabilities({
          adapter: "codex",
          models: { defaultModel: "gpt-5-codex", supported: ["gpt-5-codex"] },
          providers: [{ id: "openai", ready: true }],
        }),
      ],
      catalog: { vendors: [] },
      profiles: [profile({ id: "openai-api", endpoint: "openai", label: "OpenAI API Key" })],
    })
    const snapshot = buildConfigurationLabSnapshot(data, { adapter: "codex" })
    const route = snapshot.axes.routes.find((r) => r.value === "openai")
    expect(route).toBeDefined()
    expect(route?.fixed).toBe(true)
    expect(route?.runnable).toBe(true)
    expect(route?.eligibleProfiles).toContain("openai-api")
    expect(route?.ref).toBe("openai/gpt-5-codex")
    expect(snapshot.selection.route).toBe("openai")
    expect(snapshot.selection.profile).toBe("openai-api")
  })

  it("filters out third-party routes for Codex that are not explicitly contributed", () => {
    const data = rawData({
      adapters: [
        adapter({
          slug: "codex",
          name: "Codex",
          models: ["gpt-5-codex"],
          modelDetails: [{ id: "gpt-5-codex", provider: "openai" }],
        }),
      ],
      capabilities: [
        capabilities({
          adapter: "codex",
          models: { defaultModel: "gpt-5-codex", supported: ["gpt-5-codex"] },
          providers: [{ id: "openai", ready: true }],
        }),
      ],
      catalog: {
        vendors: [
          {
            vendor: "openai",
            products: [
              {
                product: "gpt-5-codex",
                routes: [
                  {
                    route: "openai",
                    ref: "openai/gpt-5-codex",
                    baseUrl: null,
                    pricing: null,
                    runnable: true,
                    eligibleProfiles: ["openai-api"],
                    adapterModes: ["default"],
                    adapters: ["codex"],
                    curated: true,
                  },
                ],
              },
            ],
          },
          {
            vendor: "openrouter",
            products: [
              {
                product: "gpt-5-codex",
                routes: [
                  {
                    route: "openrouter",
                    ref: "openrouter/gpt-5-codex",
                    baseUrl: null,
                    pricing: null,
                    runnable: true,
                    eligibleProfiles: ["openrouter-api"],
                    adapterModes: ["default"],
                    adapters: ["claude-code"],
                    curated: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      profiles: [
        profile({ id: "openai-api", endpoint: "openai", label: "OpenAI API Key" }),
        profile({ id: "openrouter-api", endpoint: "openrouter", label: "OpenRouter API Key" }),
      ],
    })
    const snapshot = buildConfigurationLabSnapshot(data, { adapter: "codex" })
    const routes = snapshot.axes.routes.map((r) => r.value)
    expect(routes).toContain("openai")
    expect(routes).not.toContain("openrouter")
    expect(snapshot.selection.route).toBe("openai")
  })

  it("maps Codex + native OpenAI route selections to spawn args without a baseUrl", () => {
    const data = rawData({
      adapters: [
        adapter({
          slug: "codex",
          name: "Codex",
          models: ["gpt-5-codex"],
          modelDetails: [{ id: "gpt-5-codex", provider: "openai" }],
        }),
      ],
      capabilities: [
        capabilities({
          adapter: "codex",
          models: { defaultModel: "gpt-5-codex", supported: ["gpt-5-codex"] },
          providers: [{ id: "openai", ready: true }],
        }),
      ],
      catalog: {
        vendors: [
          {
            vendor: "openai",
            products: [
              {
                product: "gpt-5-codex",
                routes: [
                  {
                    route: "openai",
                    ref: "openai/gpt-5-codex",
                    baseUrl: null,
                    pricing: null,
                    runnable: true,
                    eligibleProfiles: ["openai-api"],
                    adapterModes: ["default"],
                    adapters: ["codex"],
                    curated: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      profiles: [profile({ id: "openai-api", endpoint: "openai", label: "OpenAI API Key" })],
    })
    const snapshot = buildConfigurationLabSnapshot(data, { adapter: "codex" })
    const args = labSelectionToSpawnArgs(snapshot)
    expect(args).toEqual({
      adapter: "codex",
      model: "openai/gpt-5-codex",
      route: { gateway: "openai" },
      access: { profileRef: "openai-api" },
    })
    expect(args.route).not.toHaveProperty("baseUrl")
  })

  it("does not show misleading unset axes for MastraCode derived-from-model", () => {
    const data = rawData({
      adapters: [
        adapter({
          slug: "mastracode",
          name: "Mastra Code",
          models: ["claude-sonnet-4-5", "gpt-5.1"],
          modelDetails: [
            { id: "claude-sonnet-4-5", provider: "anthropic" },
            { id: "gpt-5.1", provider: "openai" },
          ],
          routeSelection: "derived-from-model",
        }),
      ],
      capabilities: [
        capabilities({
          adapter: "mastracode",
          models: { defaultModel: "claude-sonnet-4-5", supported: ["claude-sonnet-4-5", "gpt-5.1"] },
          providers: [
            { id: "anthropic", ready: true },
            { id: "openai", ready: true },
          ],
        }),
      ],
      catalog: {
        vendors: [
          {
            vendor: "anthropic",
            products: [
              {
                product: "claude-sonnet-4-5",
                routes: [
                  {
                    route: "anthropic",
                    ref: "anthropic/claude-sonnet-4-5",
                    baseUrl: null,
                    pricing: null,
                    runnable: true,
                    eligibleProfiles: ["anthropic-api"],
                    adapterModes: ["default"],
                    adapters: ["mastracode"],
                    curated: true,
                  },
                ],
              },
            ],
          },
          {
            vendor: "openai",
            products: [
              {
                product: "gpt-5.1",
                routes: [
                  {
                    route: "openai",
                    ref: "openai/gpt-5.1",
                    baseUrl: null,
                    pricing: null,
                    runnable: true,
                    eligibleProfiles: ["openai-api"],
                    adapterModes: ["default"],
                    adapters: ["mastracode"],
                    curated: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      profiles: [
        profile({ id: "anthropic-api", endpoint: "anthropic", label: "Anthropic API Key" }),
        profile({ id: "openai-api", endpoint: "openai", label: "OpenAI API Key" }),
      ],
    })
    const snapshot = buildConfigurationLabSnapshot(data, { adapter: "mastracode" })
    expect(snapshot.selection.model).toBe("claude-sonnet-4-5")
    expect(snapshot.selection.route).toBe("anthropic")
    expect(snapshot.selection.profile).toBe("anthropic-api")
    const byKey = Object.fromEntries(snapshot.effective.map((f) => [f.key, f]))
    expect(byKey["Route / gateway"]?.source).toBe("default")
    expect(byKey["Auth profile"]?.source).toBe("default")
    expect(byKey["Route / gateway"]?.detail).not.toContain("unset")
    expect(byKey["Auth profile"]?.detail).not.toContain("unset")
  })
})

describe("fetchConfigurationLabData", () => {
  it("returns data from all fetchers", async () => {
    const data = await fetchConfigurationLabData(
      {
        listAdapters: async () => [adapter()],
        harnessCapabilities: async () => [capabilities()],
        catalogModels: async () => catalog(),
        listAuthProfiles: async () => [profile()],
        listProviderPresets: async () => [],
      },
      "claude-code",
    )
    expect(data.adapters).toHaveLength(1)
    expect(data.capabilities[0]?.adapter).toBe("claude-code")
    expect(data.catalog.vendors[0]?.vendor).toBe("anthropic")
    expect(data.profiles[0]?.id).toBe("anthropic-sub")
  })

  it("degrades gracefully when a fetcher throws", async () => {
    const data = await fetchConfigurationLabData(
      {
        listAdapters: async () => [adapter()],
        harnessCapabilities: async () => {
          throw new Error("boom")
        },
        catalogModels: async () => catalog(),
        listAuthProfiles: async () => [profile()],
        listProviderPresets: async () => [],
      },
      "claude-code",
    )
    expect(data.adapters).toHaveLength(1)
    expect(data.capabilities).toHaveLength(0)
    expect(data.catalog.vendors).toHaveLength(1)
  })
})

describe("labSelectionToSpawnArgs", () => {
  it("maps selections to spawn option shape", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), {
      adapter: "claude-code",
      model: "claude-opus-4-8",
      route: "anthropic",
      profile: "anthropic-sub",
      posture: "plan",
      effort: "high",
    })
    const args = labSelectionToSpawnArgs(snapshot)
    expect(args).toEqual({
      adapter: "claude-code",
      model: "anthropic/claude-opus-4-8",
      route: { gateway: "anthropic" },
      access: { profileRef: "anthropic-sub" },
      posture: "plan",
      effort: "high",
    })
  })

  it("omits undefined fields", () => {
    const snapshot = buildConfigurationLabSnapshot(rawData(), { adapter: "claude-code" })
    const args = labSelectionToSpawnArgs(snapshot)
    expect(args).toEqual({
      adapter: "claude-code",
      model: "anthropic/claude-sonnet-5",
      route: { gateway: "anthropic" },
      access: { profileRef: "anthropic-sub" },
    })
  })
})
