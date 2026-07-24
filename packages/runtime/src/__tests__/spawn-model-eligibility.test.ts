/**
 * Money-safety spawn-time eligibility guard (session-spawn.ts +
 * session-restart-core.ts). THE BUG: the auth-MODE spawn path validates only
 * provider→mode support — it never checks that the resolved wallet can BILL the
 * requested model. So a gateway/router model (`deepseek/deepseek-v4-pro`, which
 * bills `openrouter`) spawned with no `route.gateway` resolves to claude-code's
 * FIXED `anthropic` wallet and 404s upstream with a confusing "model may not
 * exist / no access". This guard rejects that spawn LOUD with an actionable
 * message, and NEVER auto-substitutes an eligible wallet the operator didn't
 * name. These tests cover the pure predicate, the spawn reject/OK cases, and the
 * restart mirror.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Deterministic providers.json api-key lookup (the resolver's store source) —
// never touch the real ~/.agentproto file, same style as session-spawn.test.ts.
const storeKeys = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }))
vi.mock("../providers-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers-store.js")>()
  return { ...actual, getProviderKey: vi.fn(async (p: string) => storeKeys.value[p]) }
})

import {
  serviceableModelRoutes,
  checkModelWalletEligibility,
  modelWalletIneligibleMessage,
  suggestModelSlugs,
} from "../catalog-models.js"
import { getModelProvider } from "@agentproto/model-catalog/llm"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { restartAgentSession, RestartOverrideError } from "../session-restart-core.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

let acpCounter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

// The claude-code auth descriptor the runtime projects from the manifest — a
// FIXED `anthropic` provider (independent of the requested model), the exact
// shape that makes the gateway-model-on-the-wrong-wallet bug possible.
const CLAUDE_CODE_DESC: AdapterAuthDescriptor = {
  provider: "anthropic",
  authEnforce: "always",
  authSubscription: {
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    unsetEnvAdd: ["ANTHROPIC_BASE_URL"],
  },
}

function makeResolver(
  descriptor: AdapterAuthDescriptor | undefined,
): { resolver: AgentAdapterResolver; startSession: ReturnType<typeof vi.fn> } {
  const startSession = vi.fn(async () => fakeAgentSession())
  const resolver: AgentAdapterResolver = async () => ({
    startSession,
    commandPreview: "mock-adapter",
    defaultModel: "claude-sonnet-5",
    ...(descriptor ? { authDescriptor: descriptor } : {}),
  })
  return { resolver, startSession }
}

function deps(resolver: AgentAdapterResolver): SpawnAgentSessionDeps {
  return {
    registry: createSessionsRegistry({ persist: false }),
    resolveAgentAdapter: resolver,
    // Keep every test off the real ~/.agentproto/config.json.
    loadDefaultsConfig: async () => undefined,
  }
}

beforeEach(() => {
  storeKeys.value = {}
})

describe("serviceableModelRoutes — reuses the catalog route-resolution", () => {
  it("a gateway/router model resolves to its router routes, never the native vendor sub", () => {
    const routes = serviceableModelRoutes("deepseek/deepseek-v4-pro")
    expect(routes).toContain("openrouter")
    expect(routes).not.toContain("anthropic")
  })

  it("a native model resolves to its own vendor route", () => {
    expect(serviceableModelRoutes("claude-opus-4-8")).toContain("anthropic")
  })

  it("a requesty-only model (no pricing-catalog provider) is still caught via the @route probe", () => {
    // `getModelProvider` returns undefined for these — the widening-route probe
    // is what keeps them from slipping past the guard.
    expect(serviceableModelRoutes("sference/glm-5.2")).toContain("requesty")
  })

  it("an unknown model resolves to NO routes (a mismatch cannot be proven ⇒ never reject)", () => {
    expect(serviceableModelRoutes("totally-made-up-xyz-model")).toEqual([])
  })

  it("a first-party model whose vendor/product form COLLIDES with a router key keeps its own vendor route (claude-sonnet-5 / claude-fable-5)", () => {
    // OpenRouter keys `anthropic/claude-sonnet-5` and `anthropic/claude-fable-5`
    // with the SAME dash spelling Anthropic uses (tagged provider:"openrouter"),
    // so `getModelProvider` alone would hide the direct anthropic route. The
    // first-party bare-product check restores it — WITHOUT dropping the router
    // routes the model genuinely also bills.
    for (const id of ["anthropic/claude-sonnet-5", "anthropic/claude-fable-5"]) {
      const routes = serviceableModelRoutes(id)
      expect(routes).toContain("anthropic")
      expect(routes).toContain("openrouter")
      expect(routes).toContain("requesty")
    }
  })

  it("does NOT grant a vendor route to an openrouter-only sibling variant that merely shares a name prefix (google/gemini-2.5-flash-image)", () => {
    // The exact-lookup guard's raison d'être: `gemini-2.5-flash-image` is NOT a
    // first-party pricing key — it's an OpenRouter-only route whose bare product
    // only SUBSTRING-matches the unrelated `gemini-2.5-flash` row (provider
    // google). The old `resolvePricing(...)` substring fallback tripped on that
    // and spuriously added a `google` direct route the model cannot be billed
    // on; `resolvePricingExact` requires a VERBATIM key/alias, so it doesn't.
    const routes = serviceableModelRoutes("google/gemini-2.5-flash-image")
    expect(routes).not.toContain("google")
    expect(routes).toContain("openrouter")
    // Same class, other vendors — never earn their vendor route either.
    expect(serviceableModelRoutes("google/gemini-3.1-pro-preview-customtools")).not.toContain(
      "google",
    )
    expect(serviceableModelRoutes("openai/gpt-5.4-image-2")).not.toContain("openai")
  })

  it("the fix is scoped to serviceability — pricing resolution (getModelProvider) is deliberately unchanged", () => {
    // The direct route is restored at the serviceability layer only; the
    // `<vendor>/<product>` pricing row still resolves to the router, so
    // `getModelProvider` (which every routing/billing DEFAULT reads) is
    // untouched for this and every other caller. A guard against a later,
    // riskier broadening of `resolvePricing` direct-match precedence.
    expect(getModelProvider("anthropic/claude-sonnet-5")).toBe("openrouter")
    expect(getModelProvider("anthropic/claude-fable-5")).toBe("openrouter")
    // The bare first-party ids resolve to anthropic, exactly as before.
    expect(getModelProvider("claude-sonnet-5")).toBe("anthropic")
    expect(getModelProvider("claude-fable-5")).toBe("anthropic")
  })
})

describe("suggestModelSlugs — the 'did you mean' matcher for unknown slugs", () => {
  it("suggests the fully-qualified id when the vendor prefix is missing", () => {
    // The exact typo class the advisory exists for — a valid product with the
    // vendor/route prefix dropped.
    expect(suggestModelSlugs("deepseek-chat")).toContain("deepseek/deepseek-chat")
    expect(suggestModelSlugs("glm-5.2")).toContain("z-ai/glm-5.2")
  })

  it("suggests the right vendor when the WRONG prefix was used", () => {
    // `moonshot/…` is not a catalog vendor; the openrouter vendor is `moonshotai`.
    expect(suggestModelSlugs("moonshot/kimi-k2")).toContain("moonshotai/kimi-k2")
  })

  it("returns nothing for a slug that shares no product with any known id", () => {
    // A genuinely-new / free-form slug must NOT earn a spurious suggestion —
    // parity with the guard's never-reject-an-unknown-model rule.
    expect(suggestModelSlugs("totally-made-up-xyz-model")).toEqual([])
  })

  it("does not suggest itself for an already-known id", () => {
    expect(suggestModelSlugs("z-ai/glm-5.2")).not.toContain("z-ai/glm-5.2")
  })
})

describe("checkModelWalletEligibility — the money-safety predicate", () => {
  it("REJECTS a gateway model on the native subscription wallet", () => {
    const v = checkModelWalletEligibility("deepseek/deepseek-v4-pro", "anthropic")
    expect(v.ok).toBe(false)
    expect(v.suggestedRoutes).toContain("openrouter")
    expect(v.suggestedRoutes).not.toContain("anthropic")
  })

  it("ACCEPTS a gateway model on the matching gateway wallet", () => {
    expect(checkModelWalletEligibility("deepseek/deepseek-v4-pro", "openrouter").ok).toBe(true)
  })

  it("ACCEPTS a native model on its own vendor wallet", () => {
    expect(checkModelWalletEligibility("claude-opus-4-8", "anthropic").ok).toBe(true)
  })

  it("ACCEPTS an unknown model on any wallet (never over-reject a not-yet-catalogued model)", () => {
    expect(checkModelWalletEligibility("totally-made-up-xyz-model", "anthropic").ok).toBe(true)
  })

  it("ACCEPTS a first-party model colliding with a router key on its own vendor wallet (claude-sonnet-5 / claude-fable-5)", () => {
    // The money-safety verdict behind the catalog `runnable` flag: these bill
    // the direct anthropic wallet just like claude-opus-4-8, despite the
    // OpenRouter dash-spelling collision that used to reject them.
    expect(checkModelWalletEligibility("anthropic/claude-sonnet-5", "anthropic").ok).toBe(true)
    expect(checkModelWalletEligibility("anthropic/claude-fable-5", "anthropic").ok).toBe(true)
    // ...and still accepted on the router wallet they genuinely also bill.
    expect(checkModelWalletEligibility("anthropic/claude-sonnet-5", "openrouter").ok).toBe(true)
  })

  it("REJECTS an openrouter-only sibling variant on the substring-collided vendor wallet (google/gemini-2.5-flash-image)", () => {
    // The negative that the substring bug hid: `gemini-2.5-flash-image` is
    // openrouter-only, so a `google` (direct Gemini) wallet CANNOT bill it. The
    // pre-fix substring hit on `gemini-2.5-flash` spuriously flipped this ok
    // false→true; the exact guard keeps it false and points at the real route.
    const v = checkModelWalletEligibility("google/gemini-2.5-flash-image", "google")
    expect(v.ok).toBe(false)
    expect(v.suggestedRoutes).toContain("openrouter")
    expect(v.suggestedRoutes).not.toContain("google")
    // ...and it IS billable on the router wallet it actually routes through.
    expect(checkModelWalletEligibility("google/gemini-2.5-flash-image", "openrouter").ok).toBe(true)
  })
})

describe("modelWalletIneligibleMessage — actionable, names the route + api-key profile", () => {
  it("names the wallet that failed and the required gateway route + api-key profile", () => {
    const msg = modelWalletIneligibleMessage({
      prefix: "agent_start",
      adapter: "claude-code",
      model: "deepseek/deepseek-v4-pro",
      walletRoute: "anthropic",
      walletMode: "subscription",
      suggestedRoutes: ["openrouter", "requesty"],
    })
    expect(msg).toContain("deepseek/deepseek-v4-pro")
    expect(msg).toContain("anthropic")
    expect(msg).toContain("subscription")
    expect(msg).toContain('route.gateway="openrouter"')
    expect(msg).toContain("api-key profile")
    expect(msg).toContain("access.profileRef")
    // Never promises to pick a wallet for the operator.
    expect(msg).toMatch(/never switches wallets/i)
  })
})

describe("spawnAgentSession — money-safety guard at the spawn boundary", () => {
  it("REJECTS a gateway model on the fixed anthropic subscription wallet (the diagnosed bug)", async () => {
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "deepseek/deepseek-v4-pro",
      auth: { mode: "subscription", token: "sk-ant-oat01-testtoken00000" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected rejection")
    expect(result.code).toBe("model_wallet_ineligible")
    expect(result.message).toContain('route.gateway="openrouter"')
    expect(result.details).toMatchObject({
      model: "deepseek/deepseek-v4-pro",
      walletRoute: "anthropic",
    })
    // Fail-fast BEFORE any process is spawned — the whole point of the guard.
    expect(startSession).not.toHaveBeenCalled()
  })

  it("ACCEPTS a native model on the subscription wallet", async () => {
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      auth: { mode: "subscription", token: "sk-ant-oat01-testtoken00000" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it("ACCEPTS a gateway model on a matching route.gateway wallet + eligible api-key store key", async () => {
    storeKeys.value = { openrouter: "sk-or-v1-testkey000000" }
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "deepseek/deepseek-v4-pro",
      route: { gateway: "openrouter" },
      auth: { mode: "api-key" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it("does NOT guard an adapter with no billing-auth descriptor (ambient — nothing to bill)", async () => {
    const { resolver, startSession } = makeResolver(undefined)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "hermes",
      cwd: "/tmp",
      model: "deepseek/deepseek-v4-pro",
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
  })
})

describe("spawnAgentSession — model-slug 'did you mean' advisory", () => {
  it("warns (but still spawns) on a typo'd slug that drops the vendor prefix", async () => {
    const { resolver, startSession } = makeResolver(undefined)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "hermes",
      cwd: "/tmp",
      model: "deepseek-chat", // meant "deepseek/deepseek-chat"
    })
    // Advisory, never a reject — the free-form / new-model latitude is preserved.
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.warnings?.some(w => w.includes("deepseek/deepseek-chat"))).toBe(true)
    expect(result.warnings?.some(w => w.includes("did you mean"))).toBe(true)
  })

  it("does NOT warn on a valid catalog slug", async () => {
    const { resolver, startSession } = makeResolver(undefined)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "hermes",
      cwd: "/tmp",
      model: "z-ai/glm-5.2",
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.warnings?.some(w => w.includes("did you mean"))).toBeFalsy()
  })

  it("does NOT warn on a genuinely-unknown slug with no near match (a real new model)", async () => {
    const { resolver, startSession } = makeResolver(undefined)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "hermes",
      cwd: "/tmp",
      model: "acme/brand-new-model-v1",
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.warnings?.some(w => w.includes("did you mean"))).toBeFalsy()
  })
})

describe("restartAgentSession — the guard is mirrored on the restart path", () => {
  it("REJECTS a restart that overrides onto a gateway model the fixed wallet can't service", async () => {
    const { resolver } = makeResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "claude-code",
      auth: {
        mode: "subscription",
        fingerprint: "subscription · sk-ant-oat…OLD1",
        provider: "anthropic",
        credentialSource: "explicit-config",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      },
    })
    const countBefore = registry.list().length

    await expect(
      restartAgentSession(registry, resolver, prev, {
        forceAgentResume: true,
        loadDefaultsConfig: async () => ({
          adapters: { "claude-code": { auth: { token: "sk-ant-oat01-freshtoken99999" } } },
        }),
        overrides: { model: "deepseek/deepseek-v4-pro" },
      }),
    ).rejects.toThrow(RestartOverrideError)

    // No new session registered — the guard fired before the respawn.
    expect(registry.list()).toHaveLength(countBefore)
  })

  it("ACCEPTS a restart onto a native model on the same subscription wallet", async () => {
    const { resolver } = makeResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "claude-code",
      auth: {
        mode: "subscription",
        fingerprint: "subscription · sk-ant-oat…OLD1",
        provider: "anthropic",
        credentialSource: "explicit-config",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      },
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: async () => ({
        adapters: { "claude-code": { auth: { token: "sk-ant-oat01-freshtoken99999" } } },
      }),
      overrides: { model: "claude-opus-4-8" },
    })
    expect(restarted.desc.model).toBe("claude-opus-4-8")
  })
})
