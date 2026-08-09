import { describe, expect, it } from "vitest"

import type {
  AdapterInfo,
  AuthProfileSummary,
  HarnessCapabilities,
  LlmEndpointStatusResult,
} from "../client/types.js"
import {
  accessKind,
  buildAuthModel,
  buildProviders,
  DEFAULT_PROVIDER_COUNT,
  reach,
} from "./authModelMindmap.logic.js"

// ── fixtures ────────────────────────────────────────────────────────────────

function profile(over: Partial<AuthProfileSummary>): AuthProfileSummary {
  return { id: "p", endpoint: "anthropic", method: "api-key", ...over }
}

const claudeCodeAdapter: AdapterInfo = {
  slug: "claude-code",
  routeSelection: "free",
  modelDetails: [
    { id: "claude-opus-4-8", provider: "anthropic" },
    { id: "kimi-k3", provider: "moonshot" },
  ],
}
const claudeCodeCap: HarnessCapabilities = {
  adapter: "claude-code",
  endpointCompat: { anthropic: { via: "env", key: "ANTHROPIC_BASE_URL" } },
  providers: [
    { id: "anthropic", billingEndpoint: "anthropic", apiMode: "anthropic" },
    { id: "moonshot", billingEndpoint: "moonshot", apiMode: "anthropic" },
  ],
}

const hermesAdapter: AdapterInfo = {
  slug: "hermes",
  routeSelection: "derived-from-model",
  modelDetails: [{ id: "z-ai/glm", provider: "openrouter" }],
}
const hermesCap: HarnessCapabilities = {
  adapter: "hermes",
  providers: [{ id: "openrouter", billingEndpoint: "openrouter", apiMode: "chat_completions" }],
}

// codex has NO routeSelection → a fixed single-provider adapter.
const codexAdapter: AdapterInfo = {
  slug: "codex",
  modelDetails: [{ id: "gpt-5.2-codex", provider: "openai" }],
}
const codexCap: HarnessCapabilities = {
  adapter: "codex",
  providers: [{ id: "openai", billingEndpoint: "openai", apiMode: "chat_completions" }],
}

// ── accessKind ──────────────────────────────────────────────────────────────

describe("accessKind — (method × source) is first-class", () => {
  it("api-key → api-key regardless of source", () => {
    expect(accessKind(profile({ method: "api-key" }))).toBe("api-key")
  })
  it("oauth-bearer + source → self-refreshing subscription", () => {
    expect(accessKind(profile({ method: "oauth-bearer", source: "claude-code-oauth" }))).toBe(
      "subscription-refreshing",
    )
  })
  it("oauth-bearer + credentialRef (no source) → stored subscription", () => {
    expect(accessKind(profile({ method: "oauth-bearer", credentialRef: "ref.sub" }))).toBe(
      "subscription-stored",
    )
  })
})

// ── reach ───────────────────────────────────────────────────────────────────

describe("reach — grounded in routeSelection + provider set, never hand-set", () => {
  it("free/Anthropic harness → native to anthropic, via-router to every other upstream", () => {
    expect(reach(claudeCodeAdapter, claudeCodeCap, "anthropic")).toBe("native")
    // moonshot even though it emulates Anthropic: the local router is the bridge.
    expect(reach(claudeCodeAdapter, claudeCodeCap, "moonshot")).toBe("via-router")
  })
  it("returns null for a provider the harness cannot reach", () => {
    expect(reach(claudeCodeAdapter, claudeCodeCap, "google")).toBeNull()
  })
  it("derived-from-model harness → native to each provider in its set", () => {
    expect(reach(hermesAdapter, hermesCap, "openrouter")).toBe("native")
  })
  it("fixed single-provider harness (no routeSelection) → native to its provider", () => {
    expect(reach(codexAdapter, codexCap, "openai")).toBe("native")
  })
  it("uses the adapter modelDetails provider set when capabilities are absent", () => {
    expect(reach(claudeCodeAdapter, undefined, "moonshot")).toBe("via-router")
  })
})

// ── buildProviders ────────────────────────────────────────────────────────────

describe("buildProviders — wallet grouping, access-kind tallies, fold", () => {
  it("groups wallets by endpoint and counts subscription vs api-key", () => {
    const providers = buildProviders(
      [
        profile({ id: "cc", endpoint: "anthropic", method: "oauth-bearer", source: "claude-code-oauth" }),
        profile({ id: "sub", endpoint: "anthropic", method: "oauth-bearer", credentialRef: "ref" }),
        profile({ id: "or", endpoint: "openrouter", method: "api-key" }),
      ],
      new Map(),
    )
    const anthropic = providers.find(p => p.endpoint === "anthropic")!
    expect(anthropic.wallets).toHaveLength(2)
    expect(anthropic.subscriptionCount).toBe(2)
    expect(anthropic.apiKeyCount).toBe(0)
    const openrouter = providers.find(p => p.endpoint === "openrouter")!
    expect(openrouter.apiKeyCount).toBe(1)
  })

  it(`marks the busiest ${DEFAULT_PROVIDER_COUNT} providers primary and folds the rest`, () => {
    const many = Array.from({ length: DEFAULT_PROVIDER_COUNT + 3 }, (_, i) =>
      profile({ id: "w" + i, endpoint: "vendor" + i, method: "api-key" }),
    )
    const providers = buildProviders(many, new Map())
    expect(providers.filter(p => p.primary)).toHaveLength(DEFAULT_PROVIDER_COUNT)
    expect(providers.filter(p => !p.primary)).toHaveLength(3)
  })
})

// ── buildAuthModel (end-to-end) ───────────────────────────────────────────────

describe("buildAuthModel — the whole view-model from live introspection", () => {
  const router: LlmEndpointStatusResult = {
    running: true,
    pid: 42,
    port: 18090,
    baseUrl: "http://localhost:18090",
    healthy: true,
    startedAt: null,
    status: "running",
  }

  const view = buildAuthModel({
    adapters: [claudeCodeAdapter, hermesAdapter, codexAdapter],
    capabilities: [claudeCodeCap, hermesCap, codexCap],
    profiles: [
      profile({ id: "claude-code-local", endpoint: "anthropic", method: "oauth-bearer", source: "claude-code-oauth", label: "My Claude Code login", keyStatus: "self-refreshing" }),
      profile({ id: "claude-subs", endpoint: "anthropic", method: "oauth-bearer", credentialRef: "ref.sub", label: "Claude Subs Agentik", keyStatus: "stored" }),
      profile({ id: "moonshot-api", endpoint: "moonshot", method: "api-key", keyStatus: "stored" }),
      profile({ id: "openrouter-env", endpoint: "openrouter", method: "api-key", keyStatus: "stored" }),
      profile({ id: "openai-direct", endpoint: "openai", method: "api-key", keyStatus: "stored" }),
    ],
    router,
  })

  it("represents multiple Anthropic access kinds side by side", () => {
    const anthropic = view.providers.find(p => p.endpoint === "anthropic")!
    expect(anthropic.wallets.map(w => w.accessKind).sort()).toEqual([
      "subscription-refreshing",
      "subscription-stored",
    ])
  })

  it("computes the featured route-through-the-router edge", () => {
    const cc = view.harnesses.find(h => h.slug === "claude-code")!
    expect(cc.reach.anthropic).toBe("native")
    expect(cc.reach.moonshot).toBe("via-router")
    expect(cc.route).toBe("free")
    expect(cc.acceptsBaseUrl).toBe(true)
  })

  it("codex is a fixed-route harness reaching openai natively", () => {
    const codex = view.harnesses.find(h => h.slug === "codex")!
    expect(codex.route).toBe("fixed")
    expect(codex.reach.openai).toBe("native")
    expect(codex.reach.anthropic).toBeUndefined()
  })

  it("carries live router status and the honest data seams", () => {
    expect(view.router.running).toBe(true)
    expect(view.router.port).toBe(18090)
    expect(view.seams.length).toBeGreaterThanOrEqual(3)
    expect(view.seams.join(" ")).toMatch(/deny|blocked/i)
  })
})
