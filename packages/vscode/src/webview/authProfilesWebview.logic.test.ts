import { describe, expect, it } from "vitest"

import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  LlmEndpointStatusResult,
  ProviderPresetEntry,
} from "../client/types.js"
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

function catalog(): CatalogModelsResponse {
  return {
    vendors: [
      {
        vendor: "anthropic",
        products: [
          {
            product: "claude-fable-5",
            routes: [
              {
                route: "anthropic",
                ref: "anthropic/claude-fable-5",
                baseUrl: null,
                pricing: null,
                runnable: true,
                eligibleProfiles: ["anthropic-local"],
                adapterModes: [],
                adapters: [],
                curated: true,
              },
            ],
          },
        ],
      },
    ],
  }
}

const ALL_EXPANDED: AuthProfilesExpandedState = { presets: true, profiles: true, router: true }

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
  it("renders preset rows with connection state and logos", () => {
    const model = buildAuthProfilesWebviewModel(
      [preset({ slug: "anthropic" }), preset({ slug: "openai" })],
      [profile({ id: "anthropic-local", endpoint: "anthropic" })],
      { vendors: [] },
      STOPPED_ROUTER,
      "",
      ALL_EXPANDED,
      new Set(),
    )
    const anthropic = model.presets.rows.find(r => r.slug === "anthropic")!
    expect(anthropic.connected).toBe(true)
    expect(anthropic.logo).toEqual({ kind: "icon", file: "anthropic.svg" })
    const openai = model.presets.rows.find(r => r.slug === "openai")!
    expect(openai.connected).toBe(false)
    expect(openai.logo).toEqual({ kind: "icon", file: "openai.svg" })
  })

  it("renders profile rows with route counts and logos", () => {
    const model = buildAuthProfilesWebviewModel(
      [],
      [profile({ id: "anthropic-local" }), profile({ id: "unused", endpoint: "openai" })],
      catalog(),
      STOPPED_ROUTER,
      "",
      ALL_EXPANDED,
      new Set(),
    )
    expect(model.profiles.rows.map(r => r.profileId)).toEqual(["anthropic-local", "unused"])
    expect(model.profiles.rows[0]?.description).toContain("1 route")
    expect(model.profiles.rows[0]?.logo).toEqual({ kind: "icon", file: "anthropic.svg" })
    expect(model.profiles.rows[1]?.description).toContain("0 routes")
  })

  it("includes serviced model children when a profile is expanded", () => {
    const model = buildAuthProfilesWebviewModel(
      [],
      [profile({ id: "anthropic-local" })],
      catalog(),
      STOPPED_ROUTER,
      "",
      ALL_EXPANDED,
      new Set(["anthropic-local"]),
    )
    const profileRow = model.profiles.rows[0]!
    expect(profileRow.expanded).toBe(true)
    expect(profileRow.children).toHaveLength(1)
    expect(profileRow.children[0]?.product).toBe("claude-fable-5")
    expect(profileRow.children[0]?.runnable).toBe(true)
  })

  it("excludes children when a profile is collapsed", () => {
    const model = buildAuthProfilesWebviewModel(
      [],
      [profile({ id: "anthropic-local" })],
      catalog(),
      STOPPED_ROUTER,
      "",
      ALL_EXPANDED,
      new Set(),
    )
    expect(model.profiles.rows[0]?.children).toHaveLength(0)
  })

  it("marks disabled profiles dim", () => {
    const model = buildAuthProfilesWebviewModel(
      [],
      [profile({ id: "disabled", disabled: true })],
      { vendors: [] },
      STOPPED_ROUTER,
      "",
      ALL_EXPANDED,
      new Set(),
    )
    expect(model.profiles.rows[0]?.enabled).toBe(false)
  })

  it("renders router status in its own section", () => {
    const model = buildAuthProfilesWebviewModel(
      [],
      [],
      { vendors: [] },
      RUNNING_ROUTER,
      "",
      ALL_EXPANDED,
      new Set(),
    )
    expect(model.router.rows[0]?.status).toBe("ready")
    expect(model.router.rows[0]?.name).toContain("running")
    expect(String(model.router.count)).toBe("healthy")
  })

  it("filters rows by search", () => {
    const model = buildAuthProfilesWebviewModel(
      [preset({ slug: "openai", info: { schemaFlavor: "openai", baseUrl: "https://api.openai.com", keyEnv: "OPENAI_API_KEY" } })],
      [profile({ id: "anthropic-local" })],
      catalog(),
      STOPPED_ROUTER,
      "anthropic",
      ALL_EXPANDED,
      new Set(),
    )
    expect(model.presets.rows).toHaveLength(0)
    expect(model.profiles.rows).toHaveLength(1)
  })

  it("honors expanded state per section", () => {
    const collapsed: AuthProfilesExpandedState = { presets: false, profiles: true, router: false }
    const model = buildAuthProfilesWebviewModel(
      [preset()],
      [],
      { vendors: [] },
      STOPPED_ROUTER,
      "",
      collapsed,
      new Set(),
    )
    expect(model.presets.expanded).toBe(false)
    expect(model.profiles.expanded).toBe(true)
    expect(model.router.expanded).toBe(false)
  })
})
