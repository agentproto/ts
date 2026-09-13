import { describe, expect, it } from "vitest"

import {
  buildCatalogPricingIndex,
  buildRouterModelChildren,
  formatPricing,
  isLocalRouterNode,
  lookupModelPricing,
  modelRowDescription,
  normalizeOwnedByVendor,
  parseDiscoveredModels,
  parseRouterPacks,
  buildRouterPackChildren,
  parseRouterUpstreams,
  buildRouterUpstreamChildren,
  annotatePendingLink,
  pendingRestartTail,
  presentWord,
  resolveRouterModelChildren,
  resolveRouterPackChildren,
  resolveRouterUpstreamChildren,
  routerPackDescription,
  routerUpstreamDescription,
  routerUpstreamIcon,
  routerUpstreamTooltip,
  routerBaseUrl,
  routerContextValue,
  routerDescription,
  routerIcon,
  routerLabel,
  routerRunning,
  routerServing,
  routerTooltip,
  type DiscoveredModel,
  type LlmEndpointStatusResult,
} from "./localRouterTree.logic.js"
import type { CatalogModelsResponse, CatalogPricing, CatalogRoute } from "../client/types.js"

/** A fully-shaped catalog route carrying just the fields these tests vary. */
function mkRoute(route: string, ref: string, pricing: CatalogPricing | null): CatalogRoute {
  return {
    route,
    ref,
    baseUrl: null,
    pricing,
    runnable: true,
    eligibleProfiles: [],
    adapterModes: [],
    adapters: [],
    curated: true,
  }
}

function status(over: Partial<LlmEndpointStatusResult> = {}): LlmEndpointStatusResult {
  return {
    running: true,
    pid: 4242,
    port: 18090,
    baseUrl: "http://localhost:18090",
    healthy: true,
    startedAt: "2026-07-24T10:00:00.000Z",
    status: "running",
    ...over,
  }
}

const STOPPED: LlmEndpointStatusResult = {
  running: false,
  pid: null,
  port: null,
  baseUrl: null,
  healthy: false,
  startedAt: null,
  status: "never-started",
}

describe("isLocalRouterNode", () => {
  it("classifies the three router kinds and rejects others", () => {
    expect(isLocalRouterNode({ kind: "router" })).toBe(true)
    expect(isLocalRouterNode({ kind: "router-model" })).toBe(true)
    expect(isLocalRouterNode({ kind: "router-message" })).toBe(true)
    expect(isLocalRouterNode({ kind: "profile" })).toBe(false)
    expect(isLocalRouterNode({ kind: "presets" })).toBe(false)
  })
})

describe("routerRunning / routerServing", () => {
  it("is running while up or starting, not when stopped", () => {
    expect(routerRunning(status({ status: "running" }))).toBe(true)
    expect(routerRunning(status({ status: "starting" }))).toBe(true)
    expect(routerRunning(status({ status: "stopped" }))).toBe(false)
    expect(routerRunning(STOPPED)).toBe(false)
    expect(routerRunning(null)).toBe(false)
  })

  it("serves only when running AND healthy", () => {
    expect(routerServing(status({ status: "running", healthy: true }))).toBe(true)
    expect(routerServing(status({ status: "running", healthy: false }))).toBe(false)
    expect(routerServing(status({ status: "starting", healthy: false }))).toBe(false)
    expect(routerServing(STOPPED)).toBe(false)
    expect(routerServing(null)).toBe(false)
  })
})

describe("routerLabel", () => {
  it("shows the port while running", () => {
    expect(routerLabel(status({ status: "running", port: 18090 }))).toBe(
      "Local Router — running :18090",
    )
  })

  it("shows the port while starting", () => {
    expect(routerLabel(status({ status: "starting", port: 9000 }))).toBe(
      "Local Router — starting :9000",
    )
  })

  it("reads never-started as stopped, without a port", () => {
    expect(routerLabel(STOPPED)).toBe("Local Router — stopped")
    expect(routerLabel(null)).toBe("Local Router — stopped")
  })

  it("shows a bare stopped label for an explicitly stopped endpoint", () => {
    expect(routerLabel(status({ status: "stopped", running: false, port: 18090 }))).toBe(
      "Local Router — stopped",
    )
  })
})

describe("routerIcon", () => {
  it("is a green check when running and healthy", () => {
    expect(routerIcon(status({ status: "running", healthy: true }))).toBe("pass")
  })

  it("spins while starting or running-but-unhealthy", () => {
    expect(routerIcon(status({ status: "starting", healthy: false }))).toBe("sync")
    expect(routerIcon(status({ status: "running", healthy: false }))).toBe("sync")
  })

  it("is a slashed circle when stopped / never-started", () => {
    expect(routerIcon(status({ status: "stopped", running: false }))).toBe("circle-slash")
    expect(routerIcon(STOPPED)).toBe("circle-slash")
    expect(routerIcon(null)).toBe("circle-slash")
  })

  it("is an error glyph on a hard error", () => {
    expect(routerIcon(status({ status: "error", healthy: false }))).toBe("error")
  })
})

describe("routerDescription", () => {
  it("leads with health while running, empty when stopped", () => {
    expect(routerDescription(status({ status: "running", healthy: true }))).toBe("healthy")
    expect(routerDescription(status({ status: "running", healthy: false }))).toBe("unhealthy")
    expect(routerDescription(STOPPED)).toBe("")
    expect(routerDescription(null)).toBe("")
  })
})

describe("routerContextValue", () => {
  it("splits start vs stop by run state", () => {
    expect(routerContextValue(status({ status: "running" }))).toBe("local-router-running")
    expect(routerContextValue(status({ status: "starting" }))).toBe("local-router-running")
    expect(routerContextValue(STOPPED)).toBe("local-router-stopped")
    expect(routerContextValue(null)).toBe("local-router-stopped")
  })
})

describe("routerTooltip", () => {
  it("renders pid, base URL, start time, providers and last error", () => {
    const md = routerTooltip(
      status({
        pid: 999,
        port: 18090,
        baseUrl: "http://localhost:18090",
        startedAt: "2026-07-24T10:00:00.000Z",
        injectedProviders: ["anthropic", "openai"],
        lastError: "boom",
      }),
    )
    expect(md).toContain("**Local Router**")
    expect(md).toContain("- Status: running")
    expect(md).toContain("- PID: 999")
    expect(md).toContain("- Port: 18090")
    expect(md).toContain("- Base URL: http://localhost:18090")
    expect(md).toContain("- Started: 2026-07-24T10:00:00.000Z")
    expect(md).toContain("- Providers: anthropic, openai")
    expect(md).toContain("- Last error: boom")
  })

  it("degrades to a stopped tooltip when there's no status", () => {
    expect(routerTooltip(null)).toContain("- Status: stopped")
  })
})

describe("routerBaseUrl", () => {
  it("prefers the reported base URL, trailing slash stripped", () => {
    expect(routerBaseUrl(status({ baseUrl: "http://localhost:18090/" }))).toBe(
      "http://localhost:18090",
    )
  })

  it("synthesizes from the port on loopback when no base URL is reported", () => {
    expect(routerBaseUrl(status({ baseUrl: null, port: 9000 }))).toBe("http://localhost:9000")
  })

  it("is undefined when neither is known", () => {
    expect(routerBaseUrl(STOPPED)).toBeUndefined()
    expect(routerBaseUrl(null)).toBeUndefined()
  })
})

describe("parseDiscoveredModels", () => {
  it("parses the OpenAI shape (owned_by)", () => {
    expect(
      parseDiscoveredModels({
        data: [
          { id: "gpt-4o", owned_by: "openai" },
          { id: "claude-fable-5", owned_by: "anthropic" },
        ],
      }),
    ).toEqual([
      { id: "gpt-4o", ownedBy: "openai" },
      { id: "claude-fable-5", ownedBy: "anthropic" },
    ])
  })

  it("tolerates the anthropic shape (display_name → ownedBy)", () => {
    expect(
      parseDiscoveredModels({ data: [{ id: "claude-fable-5", display_name: "Claude Fable 5" }] }),
    ).toEqual([{ id: "claude-fable-5", ownedBy: "Claude Fable 5" }])
  })

  it("keeps a bare id with no owner", () => {
    expect(parseDiscoveredModels({ data: [{ id: "x" }] })).toEqual([{ id: "x" }])
  })

  it("drops rows without a string id and non-array bodies", () => {
    expect(parseDiscoveredModels({ data: [{ owned_by: "openai" }, { id: 5 }, null] })).toEqual([])
    expect(parseDiscoveredModels({})).toEqual([])
    expect(parseDiscoveredModels(null)).toEqual([])
    expect(parseDiscoveredModels({ data: "nope" })).toEqual([])
  })
})

describe("buildCatalogPricingIndex / lookupModelPricing", () => {
  const catalog: CatalogModelsResponse = {
    vendors: [
      {
        vendor: "anthropic",
        products: [
          {
            product: "claude-fable-5",
            routes: [
              {
                route: "openrouter",
                ref: "anthropic/claude-fable-5",
                baseUrl: null,
                pricing: { inPer1M: 3, outPer1M: 15 },
                runnable: true,
                eligibleProfiles: [],
                adapterModes: [],
                adapters: [],
                curated: true,
              },
              {
                route: "anthropic",
                ref: "claude-fable-5",
                baseUrl: null,
                pricing: null,
                runnable: false,
                eligibleProfiles: [],
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

  it("indexes pricing by route ref, vendor/product, and product name", () => {
    const index = buildCatalogPricingIndex(catalog)
    expect(lookupModelPricing(index, "anthropic/claude-fable-5")).toEqual({ inPer1M: 3, outPer1M: 15 })
    expect(lookupModelPricing(index, "claude-fable-5")).toEqual({ inPer1M: 3, outPer1M: 15 })
  })

  it("returns null for an unknown id", () => {
    const index = buildCatalogPricingIndex(catalog)
    expect(lookupModelPricing(index, "gpt-4o")).toBeNull()
  })

  it("skips routes with no pricing without throwing", () => {
    const index = buildCatalogPricingIndex({ vendors: [] })
    expect(lookupModelPricing(index, "anything")).toBeNull()
  })
})

describe("formatPricing / modelRowDescription", () => {
  it("formats a known price and the no-pricing sentinel", () => {
    expect(formatPricing({ inPer1M: 3, outPer1M: 15 })).toBe("$3/$15 per 1M")
    expect(formatPricing(null)).toBe("no catalog pricing")
  })

  it("joins owner and price for a fully-known model", () => {
    const model: DiscoveredModel = { id: "claude-fable-5", ownedBy: "anthropic" }
    expect(modelRowDescription(model, { inPer1M: 3, outPer1M: 15 })).toBe(
      "anthropic · $3/$15 per 1M",
    )
  })

  it("shows the no-pricing sentinel next to the owner when the catalog lacks a price", () => {
    expect(modelRowDescription({ id: "x", ownedBy: "acme" }, null)).toBe("acme · no catalog pricing")
  })

  it("shows pricing alone when the proxy reported no owner", () => {
    expect(modelRowDescription({ id: "x" }, { inPer1M: 1, outPer1M: 2 })).toBe("$1/$2 per 1M")
    expect(modelRowDescription({ id: "x" }, null)).toBe("no catalog pricing")
  })
})

describe("buildRouterModelChildren", () => {
  it("maps each discovered model to a router-model node", () => {
    const children = buildRouterModelChildren([
      { id: "a", ownedBy: "openai" },
      { id: "b" },
    ])
    expect(children).toEqual([
      { kind: "router-model", model: { id: "a", ownedBy: "openai" } },
      { kind: "router-model", model: { id: "b" } },
    ])
  })

  it("renders a single 'no models' message when the proxy serves nothing", () => {
    expect(buildRouterModelChildren([])).toEqual([
      { kind: "router-message", message: "No models served" },
    ])
  })
})

describe("normalizeOwnedByVendor", () => {
  it("maps known proxy provider names onto catalog vendor ids", () => {
    expect(normalizeOwnedByVendor("zai")).toBe("z-ai")
    expect(normalizeOwnedByVendor("xai")).toBe("x-ai")
    expect(normalizeOwnedByVendor("moonshot")).toBe("moonshot")
    expect(normalizeOwnedByVendor("openrouter")).toBe("openrouter")
  })

  it("is case-insensitive and falls back to identity for an unknown owner", () => {
    expect(normalizeOwnedByVendor("ZAI")).toBe("z-ai")
    expect(normalizeOwnedByVendor("acme")).toBe("acme")
  })
})

describe("lookupModelPricing — owned_by-aware disambiguation", () => {
  // `glm-4.6` served natively by z-ai AND re-exposed via an openrouter snapshot,
  // at DIFFERENT prices — the exact collision the owned_by cross-ref must resolve.
  const collision: CatalogModelsResponse = {
    vendors: [
      {
        vendor: "z-ai",
        products: [
          { product: "glm-4.6", routes: [mkRoute("z-ai", "z-ai/glm-4.6", { inPer1M: 0.6, outPer1M: 2.2 })] },
        ],
      },
      {
        vendor: "openrouter",
        products: [
          { product: "glm-4.6", routes: [mkRoute("openrouter", "openrouter/glm-4.6", { inPer1M: 5, outPer1M: 15 })] },
        ],
      },
    ],
  }

  it("prefers the ownedBy-scoped price over the bare 'first price wins' key", () => {
    const index = buildCatalogPricingIndex(collision)
    // Bare key resolves to z-ai (walked first) — but the owner decides the price.
    expect(lookupModelPricing(index, "glm-4.6", "zai")).toEqual({ inPer1M: 0.6, outPer1M: 2.2 })
    expect(lookupModelPricing(index, "glm-4.6", "openrouter")).toEqual({ inPer1M: 5, outPer1M: 15 })
  })

  it("refuses a bare-only match whose vendor differs from ownedBy (no misleading price)", () => {
    const index = buildCatalogPricingIndex(collision)
    // moonshot has no `moonshot/glm-4.6` route and the bare product is ambiguous
    // (z-ai vs openrouter) — so "no catalog pricing" beats a wrong attribution.
    expect(lookupModelPricing(index, "glm-4.6", "moonshot")).toBeNull()
  })

  it("still returns a single-vendor bare price when the product is unambiguous", () => {
    const single: CatalogModelsResponse = {
      vendors: [
        {
          vendor: "z-ai",
          products: [
            { product: "glm-4.6", routes: [mkRoute("z-ai", "z-ai/glm-4.6", { inPer1M: 0.6, outPer1M: 2.2 })] },
          ],
        },
      ],
    }
    const index = buildCatalogPricingIndex(single)
    // Even an owner with no vendor-scoped key gets the price — it's attributable.
    expect(lookupModelPricing(index, "glm-4.6", "moonshot")).toEqual({ inPer1M: 0.6, outPer1M: 2.2 })
    expect(lookupModelPricing(index, "glm-4.6")).toEqual({ inPer1M: 0.6, outPer1M: 2.2 })
  })
})

describe("resolveRouterModelChildren", () => {
  const serving = (): LlmEndpointStatusResult => status({ status: "running", healthy: true })

  it("(a) maps a successful fetch to model children (pricing resolves via the index)", async () => {
    const children = await resolveRouterModelChildren(serving(), async () => [
      { id: "glm-4.6", ownedBy: "zai" },
    ])
    expect(children).toEqual([
      { kind: "router-model", model: { id: "glm-4.6", ownedBy: "zai" } },
    ])
    // The view renders pricing off the shared index at getTreeItem time.
    const index = buildCatalogPricingIndex({
      vendors: [
        {
          vendor: "z-ai",
          products: [
            { product: "glm-4.6", routes: [mkRoute("z-ai", "z-ai/glm-4.6", { inPer1M: 0.6, outPer1M: 2.2 })] },
          ],
        },
      ],
    })
    expect(lookupModelPricing(index, "glm-4.6", "zai")).toEqual({ inPer1M: 0.6, outPer1M: 2.2 })
  })

  it("(b) surfaces a single 'Models unavailable' message when the fetch throws", async () => {
    const children = await resolveRouterModelChildren(serving(), async () => {
      throw new Error("connection refused")
    })
    expect(children).toEqual([{ kind: "router-message", message: "Models unavailable" }])
  })

  it("(c) returns 'Router address unavailable' when healthy but no base URL / port", async () => {
    let fetched = false
    const children = await resolveRouterModelChildren(
      status({ status: "running", healthy: true, baseUrl: null, port: null }),
      async () => {
        fetched = true
        return []
      },
    )
    expect(children).toEqual([{ kind: "router-message", message: "Router address unavailable" }])
    expect(fetched).toBe(false)
  })

  it("returns no children (never fetches) when the router isn't serving", async () => {
    let fetched = false
    const children = await resolveRouterModelChildren(STOPPED, async () => {
      fetched = true
      return []
    })
    expect(children).toEqual([])
    expect(fetched).toBe(false)
  })
})

// ── Packs subtree ───────────────────────────────────────────────────────────

describe("parseRouterPacks", () => {
  it("parses the /v1/packs shape with model_count", () => {
    const packs = parseRouterPacks({
      object: "list",
      data: [
        { id: "default", label: "Default", model_count: 8, models: [] },
        { id: "xai", label: "xAI (Grok)", model_count: 4 },
      ],
    })
    expect(packs).toEqual([
      { id: "default", label: "Default", modelCount: 8 },
      { id: "xai", label: "xAI (Grok)", modelCount: 4 },
    ])
  })

  it("falls back to models.length when model_count is absent", () => {
    const packs = parseRouterPacks({ data: [{ id: "p", models: [{ code: "a" }, { code: "b" }] }] })
    expect(packs).toEqual([{ id: "p", modelCount: 2 }])
  })

  it("ignores rows without a string id and non-array data", () => {
    expect(parseRouterPacks({ data: [{ label: "no id" }, { id: 7 }, { id: "ok", model_count: 0 }] })).toEqual([
      { id: "ok", modelCount: 0 },
    ])
    expect(parseRouterPacks({ data: "nope" })).toEqual([])
    expect(parseRouterPacks(null)).toEqual([])
  })
})

describe("routerPackDescription", () => {
  it("renders label · N models, singularising a lone model", () => {
    expect(routerPackDescription({ id: "p", label: "P", modelCount: 3 })).toBe("P · 3 models")
    expect(routerPackDescription({ id: "p", label: "P", modelCount: 1 })).toBe("P · 1 model")
  })

  it("omits the label when the proxy reported none", () => {
    expect(routerPackDescription({ id: "p", modelCount: 0 })).toBe("0 models")
  })
})

describe("buildRouterPackChildren", () => {
  it("maps each pack to a router-pack node", () => {
    expect(buildRouterPackChildren([{ id: "default", modelCount: 8 }])).toEqual([
      { kind: "router-pack", pack: { id: "default", modelCount: 8 } },
    ])
  })

  it("renders a 'No packs' message for an empty list", () => {
    expect(buildRouterPackChildren([])).toEqual([{ kind: "router-message", message: "No packs" }])
  })
})

describe("resolveRouterPackChildren", () => {
  const serving = (): LlmEndpointStatusResult => status({ status: "running", healthy: true })

  it("fetches and builds pack rows when serving", async () => {
    const children = await resolveRouterPackChildren(serving(), async () => [
      { id: "default", label: "Default", modelCount: 8 },
    ])
    expect(children).toEqual([{ kind: "router-pack", pack: { id: "default", label: "Default", modelCount: 8 } }])
  })

  it("renders 'Packs unavailable' when the fetch throws", async () => {
    const children = await resolveRouterPackChildren(serving(), async () => {
      throw new Error("boom")
    })
    expect(children).toEqual([{ kind: "router-message", message: "Packs unavailable" }])
  })

  it("renders 'Router address unavailable' when serving with no base URL", async () => {
    let fetched = false
    const children = await resolveRouterPackChildren(
      status({ status: "running", healthy: true, baseUrl: null, port: null }),
      async () => {
        fetched = true
        return []
      },
    )
    expect(children).toEqual([{ kind: "router-message", message: "Router address unavailable" }])
    expect(fetched).toBe(false)
  })

  it("returns no children (never fetches) when the router isn't serving", async () => {
    let fetched = false
    const children = await resolveRouterPackChildren(STOPPED, async () => {
      fetched = true
      return []
    })
    expect(children).toEqual([])
    expect(fetched).toBe(false)
  })
})

// ── Upstreams subtree ─────────────────────────────────────────────────────────

describe("parseRouterUpstreams", () => {
  it("parses the /v1/upstreams shape (profile / env / none, present nullable)", () => {
    const upstreams = parseRouterUpstreams({
      object: "list",
      probe: false,
      data: [
        { provider: "anthropic", linkedProfile: "claude-subs", source: "profile", method: "oauth-bearer", present: null },
        { provider: "groq", linkedProfile: null, source: "env", method: "api-key", present: true },
        { provider: "requesty", linkedProfile: null, source: "none", method: null, present: false },
      ],
    })
    expect(upstreams).toEqual([
      { provider: "anthropic", linkedProfile: "claude-subs", source: "profile", method: "oauth-bearer", present: null },
      { provider: "groq", linkedProfile: null, source: "env", method: "api-key", present: true },
      { provider: "requesty", linkedProfile: null, source: "none", method: null, present: false },
    ])
  })

  it("coerces unknown source/method/present and ignores rows without a provider", () => {
    expect(
      parseRouterUpstreams({
        data: [
          { linkedProfile: "x" }, // no provider → dropped
          { provider: 7 }, // non-string → dropped
          { provider: "openai", source: "weird", method: "bogus", present: "yes" },
        ],
      }),
    ).toEqual([{ provider: "openai", linkedProfile: null, source: "none", method: null, present: null }])
    expect(parseRouterUpstreams({ data: "nope" })).toEqual([])
    expect(parseRouterUpstreams(null)).toEqual([])
  })
})

describe("presentWord", () => {
  it("maps the tri-state presence to a word", () => {
    expect(presentWord(true)).toBe("present")
    expect(presentWord(false)).toBe("absent")
    expect(presentWord(null)).toBe("unprobed")
  })
})

describe("routerUpstreamDescription", () => {
  it("renders a linked profile with its method and presence", () => {
    expect(
      routerUpstreamDescription({ provider: "anthropic", linkedProfile: "claude-subs", source: "profile", method: "oauth-bearer", present: null }),
    ).toBe("→ claude-subs · oauth-bearer · unprobed")
  })

  it("renders an env source", () => {
    expect(
      routerUpstreamDescription({ provider: "groq", linkedProfile: null, source: "env", method: "api-key", present: true }),
    ).toBe("env · api-key · present")
  })

  it("renders an unlinked (none) source, omitting a null method", () => {
    expect(
      routerUpstreamDescription({ provider: "requesty", linkedProfile: null, source: "none", method: null, present: false }),
    ).toBe("unlinked · absent")
  })
})

describe("routerUpstreamIcon", () => {
  it("maps presence to a codicon", () => {
    expect(routerUpstreamIcon({ provider: "a", linkedProfile: null, source: "env", method: "api-key", present: true })).toBe("pass")
    expect(routerUpstreamIcon({ provider: "a", linkedProfile: "p", source: "profile", method: "api-key", present: null })).toBe("question")
    expect(routerUpstreamIcon({ provider: "a", linkedProfile: null, source: "none", method: null, present: false })).toBe("circle-slash")
  })
})

describe("routerUpstreamTooltip", () => {
  it("lists the provider, source, linked profile, method and presence (no secret)", () => {
    const tip = routerUpstreamTooltip({ provider: "anthropic", linkedProfile: "claude-subs", source: "profile", method: "oauth-bearer", present: true })
    expect(tip).toContain("**anthropic**")
    expect(tip).toContain("- Source: profile")
    expect(tip).toContain("- Linked profile: claude-subs")
    expect(tip).toContain("- Method: oauth-bearer")
    expect(tip).toContain("- Credential: present")
  })
})

describe("buildRouterUpstreamChildren", () => {
  it("maps each upstream to a router-upstream node", () => {
    const u = { provider: "groq", linkedProfile: null, source: "env", method: "api-key", present: true } as const
    expect(buildRouterUpstreamChildren([u])).toEqual([{ kind: "router-upstream", upstream: u }])
  })

  it("renders a 'No upstreams' message for an empty list", () => {
    expect(buildRouterUpstreamChildren([])).toEqual([{ kind: "router-message", message: "No upstreams" }])
  })

  it("annotates a pending link change when desired ≠ running", () => {
    const u = { provider: "anthropic", linkedProfile: "old", source: "profile", method: "oauth-bearer", present: null } as const
    const [node] = buildRouterUpstreamChildren([u], { anthropic: "new" })
    expect(node).toMatchObject({
      kind: "router-upstream",
      upstream: { provider: "anthropic", pendingProfile: "new" },
    })
  })

  it("leaves no pending annotation when desired matches running", () => {
    const u = { provider: "anthropic", linkedProfile: "same", source: "profile", method: "oauth-bearer", present: null } as const
    const [node] = buildRouterUpstreamChildren([u], { anthropic: "same" })
    expect(node).toEqual({ kind: "router-upstream", upstream: u })
  })
})

describe("annotatePendingLink / pendingRestartTail", () => {
  const base = { provider: "anthropic", source: "profile", method: "api-key", present: null } as const

  it("flags a pending link (desired string ≠ running)", () => {
    const annotated = annotatePendingLink({ ...base, linkedProfile: null }, { anthropic: "p1" })
    expect(annotated.pendingProfile).toBe("p1")
    expect(pendingRestartTail(annotated)).toBe("pending restart → p1")
  })

  it("flags a pending UNLINK (desired absent, running set) as null", () => {
    const annotated = annotatePendingLink({ ...base, linkedProfile: "p1" }, {})
    expect(annotated.pendingProfile).toBeNull()
    expect(pendingRestartTail(annotated)).toBe("pending restart (unlink)")
  })

  it("no annotation when desired === running (both null)", () => {
    const annotated = annotatePendingLink({ ...base, linkedProfile: null }, {})
    expect("pendingProfile" in annotated).toBe(false)
    expect(pendingRestartTail(annotated)).toBe("")
  })

  it("routerUpstreamDescription appends the pending-restart tail", () => {
    const annotated = annotatePendingLink({ ...base, linkedProfile: null }, { anthropic: "p1" })
    expect(routerUpstreamDescription(annotated)).toContain("pending restart → p1")
  })

  it("routerUpstreamIcon is a spinner while pending", () => {
    const annotated = annotatePendingLink({ ...base, linkedProfile: null, present: true }, { anthropic: "p1" })
    expect(routerUpstreamIcon(annotated)).toBe("sync")
  })
})

describe("resolveRouterUpstreamChildren", () => {
  const serving = (): LlmEndpointStatusResult => status({ status: "running", healthy: true })

  it("fetches and builds upstream rows when serving", async () => {
    const children = await resolveRouterUpstreamChildren(serving(), async () => [
      { provider: "groq", linkedProfile: null, source: "env", method: "api-key", present: true },
    ])
    expect(children).toEqual([
      { kind: "router-upstream", upstream: { provider: "groq", linkedProfile: null, source: "env", method: "api-key", present: true } },
    ])
  })

  it("renders 'Upstreams unavailable' when the fetch throws", async () => {
    const children = await resolveRouterUpstreamChildren(serving(), async () => {
      throw new Error("boom")
    })
    expect(children).toEqual([{ kind: "router-message", message: "Upstreams unavailable" }])
  })

  it("renders 'Router address unavailable' when serving with no base URL", async () => {
    let fetched = false
    const children = await resolveRouterUpstreamChildren(
      status({ status: "running", healthy: true, baseUrl: null, port: null }),
      async () => {
        fetched = true
        return []
      },
    )
    expect(children).toEqual([{ kind: "router-message", message: "Router address unavailable" }])
    expect(fetched).toBe(false)
  })

  it("returns no children (never fetches) when the router isn't serving", async () => {
    let fetched = false
    const children = await resolveRouterUpstreamChildren(STOPPED, async () => {
      fetched = true
      return []
    })
    expect(children).toEqual([])
    expect(fetched).toBe(false)
  })
})
