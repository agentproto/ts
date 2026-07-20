import { describe, expect, it } from "vitest"

import {
  buildPresetNodes,
  buildProfileNodes,
  isAuthProfileGroup,
  isAuthProfileNode,
  presetDescription,
  presetIcon,
  presetTooltip,
  profileDescription,
  profileTooltip,
  type AuthProfileNode,
  type AuthProfileTreeNode,
} from "./authProfilesTree.logic.js"
import type { CatalogModelsResponse, ProviderPresetEntry } from "../client/types.js"

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
    const node: AuthProfileTreeNode = { kind: "preset", preset: preset() }
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
