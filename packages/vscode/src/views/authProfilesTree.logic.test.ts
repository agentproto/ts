import { describe, expect, it } from "vitest"

import {
  buildPresetNodes,
  buildProfileNodes,
  buildProfileNodesWithProfiles,
  isAuthProfileGroup,
  isAuthProfileNode,
  presetConnected,
  presetConnectionIcon,
  presetDescription,
  presetIcon,
  presetRowDescription,
  presetTooltip,
  profileContextValue,
  profileCuratedIds,
  profileDescription,
  profileEnabled,
  profileKeyLabel,
  profileRowDescription,
  profileRowTooltip,
  profileTooltip,
  servicedModelDescription,
  servicedModelIcon,
  servicedModelsByProfile,
  type AuthProfileNode,
  type AuthProfileTreeNode,
} from "./authProfilesTree.logic.js"
import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  ProviderPresetEntry,
} from "../client/types.js"

function authProfile(over: Partial<AuthProfileSummary> = {}): AuthProfileSummary {
  return { id: "openrouter-api", endpoint: "openrouter", method: "api-key", ...over }
}

function preset(over: Partial<ProviderPresetEntry> = {}): ProviderPresetEntry {
  return {
    slug: "anthropic",
    name: "Anthropic",
    status: "ready",
    info: {
      schemaFlavor: "openai",
      baseUrl: "https://api.anthropic.com",
      keyEnv: "ANTHROPIC_API_KEY",
    },
    ...over,
  }
}

function makeCatalog(catalog: CatalogModelsResponse): CatalogModelsResponse {
  return catalog
}

function isPresetNode(node: AuthProfileNode): node is Extract<AuthProfileNode, { kind: "preset" }> {
  return node.kind === "preset"
}

describe("isAuthProfileGroup / isAuthProfileNode", () => {
  it("classifies groups", () => {
    const group: AuthProfileTreeNode = { kind: "presets", label: "Provider Presets" }
    expect(isAuthProfileGroup(group)).toBe(true)
    expect(isAuthProfileNode(group)).toBe(false)
  })

  it("classifies preset nodes", () => {
    const node: AuthProfileTreeNode = { kind: "preset", preset: preset(), connected: false }
    expect(isAuthProfileGroup(node)).toBe(false)
    expect(isAuthProfileNode(node)).toBe(true)
  })

  it("classifies profile-model leaves as nodes", () => {
    const node: AuthProfileTreeNode = {
      kind: "profile-model",
      profileId: "openrouter-api",
      model: { vendor: "anthropic", product: "claude-fable-5", ref: "anthropic/claude-fable-5", route: "openrouter", runnable: true },
    }
    expect(isAuthProfileGroup(node)).toBe(false)
    expect(isAuthProfileNode(node)).toBe(true)
  })

  it("classifies profile nodes", () => {
    const node: AuthProfileTreeNode = { kind: "profile", profileId: "pro", routesCount: 2 }
    expect(isAuthProfileGroup(node)).toBe(false)
    expect(isAuthProfileNode(node)).toBe(true)
  })
})

describe("buildPresetNodes", () => {
  it("returns empty for empty input", () => {
    expect(buildPresetNodes([])).toEqual([])
  })

  it("sorts ready presets before available ones", () => {
    const a = preset({ slug: "aaa", name: "Aaa", status: "available" })
    const b = preset({ slug: "bbb", name: "Bbb", status: "ready" })
    const nodes = buildPresetNodes([a, b])
    expect(nodes.filter(isPresetNode).map(n => n.preset.slug)).toEqual(["bbb", "aaa"])
  })

  it("falls back to slug for name ordering", () => {
    const a = preset({ slug: "zebra", name: undefined, status: "ready" })
    const b = preset({ slug: "alpha", name: undefined, status: "ready" })
    const nodes = buildPresetNodes([a, b])
    expect(nodes.filter(isPresetNode).map(n => n.preset.slug)).toEqual(["alpha", "zebra"])
  })

  it("sorts by name case-insensitively within the same status", () => {
    const a = preset({ slug: "a", name: "Charlie", status: "ready" })
    const b = preset({ slug: "b", name: "alpha", status: "ready" })
    const c = preset({ slug: "c", name: "Bravo", status: "ready" })
    const nodes = buildPresetNodes([a, b, c])
    expect(nodes.filter(isPresetNode).map(n => n.preset.name)).toEqual(["alpha", "Bravo", "Charlie"])
  })
})

describe("buildProfileNodes", () => {
  it("returns empty for empty catalog", () => {
    expect(buildProfileNodes(makeCatalog({ vendors: [] }))).toEqual([])
  })

  it("counts profile occurrences across all routes", () => {
    const catalog = makeCatalog({
      vendors: [
        {
          vendor: "v1",
          products: [
            {
              product: "p1",
              routes: [
                { route: "r1", ref: "x", baseUrl: null, pricing: null, runnable: true, eligibleProfiles: ["pro-a", "pro-b"], adapterModes: [], adapters: [], curated: true },
                { route: "r2", ref: "y", baseUrl: null, pricing: null, runnable: true, eligibleProfiles: ["pro-a"], adapterModes: [], adapters: [], curated: true },
              ],
            },
          ],
        },
      ],
    })
    expect(buildProfileNodes(catalog)).toEqual([
      { profileId: "pro-a", routesCount: 2 },
      { profileId: "pro-b", routesCount: 1 },
    ])
  })

  it("sorts by routesCount desc then profileId asc", () => {
    const catalog = makeCatalog({
      vendors: [
        {
          vendor: "v1",
          products: [
            {
              product: "p1",
              routes: [
                { route: "r1", ref: "x", baseUrl: null, pricing: null, runnable: true, eligibleProfiles: ["z", "y"], adapterModes: [], adapters: [], curated: true },
                { route: "r2", ref: "y", baseUrl: null, pricing: null, runnable: true, eligibleProfiles: ["y", "x"], adapterModes: [], adapters: [], curated: true },
              ],
            },
          ],
        },
      ],
    })
    expect(buildProfileNodes(catalog)).toEqual([
      { profileId: "y", routesCount: 2 },
      { profileId: "x", routesCount: 1 },
      { profileId: "z", routesCount: 1 },
    ])
  })
})

describe("presetIcon", () => {
  it("returns key for ready preset", () => {
    expect(presetIcon(preset({ status: "ready" }))).toBe("key")
  })

  it("returns key for available preset", () => {
    expect(presetIcon(preset({ status: "available" }))).toBe("key")
  })
})

describe("presetDescription", () => {
  it("includes keyEnv when present", () => {
    expect(presetDescription(preset({ slug: "anthropic", info: { schemaFlavor: "x", baseUrl: "y", keyEnv: "ANTHROPIC_API_KEY" } }))).toBe("anthropic · ANTHROPIC_API_KEY")
  })

  it("returns slug when keyEnv absent", () => {
    expect(
      presetDescription(
        preset({
          slug: "anthropic",
          info: { schemaFlavor: "x", baseUrl: "y" } as import("../client/types.js").ProviderPresetInfo,
        }),
      ),
    ).toBe("anthropic")
  })

  it("returns slug when info absent", () => {
    expect(presetDescription(preset({ slug: "anthropic", info: undefined }))).toBe("anthropic")
  })
})

describe("presetTooltip", () => {
  it("renders the preset details", () => {
    const md = presetTooltip(
      preset({
        slug: "anthropic",
        name: "Anthropic",
        status: "ready",
        info: {
          schemaFlavor: "openai",
          baseUrl: "https://api.anthropic.com",
          keyEnv: "ANTHROPIC_API_KEY",
          defaultModel: "claude-sonnet-4",
        },
        description: "Official Anthropic API",
      }),
    )
    expect(md).toContain("**Anthropic**")
    expect(md).toContain("- Slug: `anthropic`")
    expect(md).toContain("- Status: ready")
    expect(md).toContain("- Schema flavor: openai")
    expect(md).toContain("- Base URL: https://api.anthropic.com")
    expect(md).toContain("- Key env: `ANTHROPIC_API_KEY`")
    expect(md).toContain("- Default model: claude-sonnet-4")
    expect(md).toContain("Official Anthropic API")
  })

  it("falls back to slug when name is absent", () => {
    const md = presetTooltip(preset({ name: undefined }))
    expect(md).toContain("**anthropic**")
  })
})

describe("profileDescription", () => {
  it("uses singular for one route", () => {
    expect(profileDescription(1)).toBe("1 route")
  })

  it("uses plural for zero routes", () => {
    expect(profileDescription(0)).toBe("0 routes")
  })

  it("uses plural for many routes", () => {
    expect(profileDescription(5)).toBe("5 routes")
  })
})

describe("profileTooltip", () => {
  it("renders profile id and route count", () => {
    const md = profileTooltip("pro-a", 3)
    expect(md).toContain("**pro-a**")
    expect(md).toContain("- Eligible routes: 3")
  })
})

describe("profileEnabled / profileContextValue (WS2)", () => {
  it("is enabled by default and when disabled is false", () => {
    expect(profileEnabled(undefined)).toBe(true)
    expect(profileEnabled(authProfile())).toBe(true)
    expect(profileEnabled(authProfile({ disabled: false }))).toBe(true)
    expect(profileContextValue(authProfile())).toBe("auth-profile-enabled")
  })

  it("is disabled when disabled:true, driving the disabled context value", () => {
    expect(profileEnabled(authProfile({ disabled: true }))).toBe(false)
    expect(profileContextValue(authProfile({ disabled: true }))).toBe("auth-profile-disabled")
  })
})

describe("profileKeyLabel (WS5)", () => {
  it("shows the last4 tail + fingerprint for a stored secret, never the secret", () => {
    const label = profileKeyLabel(
      authProfile({ keyStatus: "stored", fingerprint: "abc123def456", last4: "wxyz" }),
    )
    expect(label).toBe("••••wxyz · abc123def456")
  })

  it("reports self-refreshing for a source-backed profile", () => {
    expect(profileKeyLabel(authProfile({ keyStatus: "self-refreshing" }))).toBe(
      "self-refreshing — no stored secret",
    )
    // Also inferred from a bare `source` when an older daemon omits keyStatus.
    expect(profileKeyLabel(authProfile({ source: "claude-code-oauth" }))).toBe(
      "self-refreshing — no stored secret",
    )
  })

  it("surfaces an unreadable key explicitly rather than hiding it", () => {
    expect(profileKeyLabel(authProfile({ keyStatus: "unavailable" }))).toBe("key unavailable")
  })

  it("omits the line entirely when the daemon reported no status", () => {
    expect(profileKeyLabel(authProfile())).toBeUndefined()
  })
})

describe("profileCuratedIds (WS3)", () => {
  it("lists ids only in allow mode", () => {
    expect(profileCuratedIds(authProfile({ models: { mode: "allow", ids: ["a/b", "c/d"] } }))).toEqual([
      "a/b",
      "c/d",
    ])
    expect(profileCuratedIds(authProfile({ models: { mode: "all", ids: [] } }))).toEqual([])
    expect(profileCuratedIds(authProfile())).toEqual([])
  })
})

describe("profileRowDescription / profileRowTooltip", () => {
  it("appends disabled + key tail to the route count", () => {
    const desc = profileRowDescription(
      2,
      authProfile({ disabled: true, keyStatus: "stored", fingerprint: "fp0000000000", last4: "9999" }),
    )
    expect(desc).toBe("2 routes · disabled · ••••9999 · fp0000000000")
  })

  it("is just the route count for a plain enabled profile with no key status", () => {
    expect(profileRowDescription(1, authProfile())).toBe("1 route")
  })

  it("tooltip renders state, key, and curated allowlist", () => {
    const md = profileRowTooltip(
      "pro",
      3,
      authProfile({ keyStatus: "stored", fingerprint: "fp", last4: "1234", models: { mode: "allow", ids: ["a/b"] } }),
    )
    expect(md).toContain("- State: enabled")
    expect(md).toContain("- Key: ••••1234 · fp")
    expect(md).toContain("- Curated to 1 model:")
    expect(md).toContain("`a/b`")
  })
})

describe("presetConnected", () => {
  it("is connected when a profile targets the preset endpoint", () => {
    expect(presetConnected(preset({ slug: "openrouter" }), [authProfile()])).toBe(true)
  })

  it("is not connected when no profile matches the slug", () => {
    expect(presetConnected(preset({ slug: "moonshot" }), [authProfile({ endpoint: "openrouter" })])).toBe(false)
    expect(presetConnected(preset({ slug: "openrouter" }), [])).toBe(false)
  })
})

describe("buildPresetNodes connection flag", () => {
  it("marks each preset connected per the profile list", () => {
    const nodes = buildPresetNodes(
      [preset({ slug: "openrouter", status: "ready" }), preset({ slug: "moonshot", status: "ready" })],
      [authProfile({ endpoint: "openrouter" })],
    )
    const byslug = Object.fromEntries(
      nodes.filter(n => n.kind === "preset").map(n => [(n as Extract<AuthProfileNode, { kind: "preset" }>).preset.slug, (n as Extract<AuthProfileNode, { kind: "preset" }>).connected]),
    )
    expect(byslug).toEqual({ openrouter: true, moonshot: false })
  })

  it("defaults every preset to unconnected when no profiles are given", () => {
    const nodes = buildPresetNodes([preset({ slug: "openrouter" })])
    expect((nodes[0] as Extract<AuthProfileNode, { kind: "preset" }>).connected).toBe(false)
  })
})

describe("presetRowDescription", () => {
  it("prefixes 'not connected' for an unconnected preset", () => {
    expect(presetRowDescription(preset({ slug: "openrouter", info: undefined }), false)).toBe(
      "not connected · openrouter",
    )
  })

  it("shows the plain description when connected", () => {
    expect(presetRowDescription(preset({ slug: "openrouter", info: undefined }), true)).toBe("openrouter")
  })
})

describe("presetConnectionIcon", () => {
  it("uses plug when connected, key when not", () => {
    expect(presetConnectionIcon(true)).toBe("plug")
    expect(presetConnectionIcon(false)).toBe("key")
  })
})

describe("servicedModelsByProfile", () => {
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

  it("inverts eligibleProfiles into per-profile serviced models", () => {
    const byProfile = servicedModelsByProfile(catalog)
    expect(byProfile.get("openrouter-api")).toEqual([
      { vendor: "anthropic", product: "claude-fable-5", ref: "anthropic/claude-fable-5", route: "openrouter", runnable: true },
    ])
    expect(byProfile.get("anthropic-sub")?.[0]?.runnable).toBe(false)
  })
})

describe("buildProfileNodesWithProfiles", () => {
  const catalog: CatalogModelsResponse = {
    vendors: [
      {
        vendor: "v1",
        products: [
          {
            product: "p1",
            routes: [
              { route: "r1", ref: "x", baseUrl: null, pricing: null, runnable: true, eligibleProfiles: ["openrouter-api"], adapterModes: [], adapters: [], curated: true },
            ],
          },
        ],
      },
    ],
  }

  it("unions catalog-active profiles with unused created ones (0 routes)", () => {
    const nodes = buildProfileNodesWithProfiles(catalog, [
      authProfile({ id: "openrouter-api", endpoint: "openrouter" }),
      authProfile({ id: "unused-api", endpoint: "moonshot" }),
    ])
    expect(nodes).toEqual([
      { profileId: "openrouter-api", routesCount: 1 },
      { profileId: "unused-api", routesCount: 0 },
    ])
  })
})

describe("servicedModel rendering", () => {
  it("labels a runnable model active with a pass icon", () => {
    const model = { vendor: "anthropic", product: "claude-fable-5", ref: "r", route: "openrouter", runnable: true }
    expect(servicedModelDescription(model)).toBe("openrouter · active")
    expect(servicedModelIcon(model)).toBe("pass")
  })

  it("labels a non-runnable model inactive with a slashed icon", () => {
    const model = { vendor: "anthropic", product: "claude-fable-5", ref: "r", route: "anthropic", runnable: false }
    expect(servicedModelDescription(model)).toBe("anthropic · inactive")
    expect(servicedModelIcon(model)).toBe("circle-slash")
  })
})
