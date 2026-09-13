/**
 * Adapter-capability spawn guard (session-spawn.ts + session-restart-core.ts).
 * THE BUG, observed in production: a supervisor spawned
 * `agent_start({adapter:"claude-code", model:"openrouter/deepseek/deepseek-v4-flash-0731"})`
 * with no `route.gateway`. The child died at spawn — 0 tool calls — on an
 * upstream 404: "Internal error: There's an issue with the selected model...
 * It may not exist or you may not have access to it." The model DOES exist
 * (`catalog_models` reports it `runnable:true`) and the money-safety wallet
 * guard (`checkModelWalletEligibility`) passes it: `openrouter` genuinely
 * bills that model. The real problem is one dimension over — `claude-code`'s
 * own manifest never curates that specific model on that route (its ACP
 * wrapper validates every model id against its own live selector and rejects
 * anything it doesn't recognize), while other installed adapters
 * (opencode/mastracode/hermes/jcode) do. This guard catches exactly that
 * mismatch, reusing the SAME `buildCatalogModels` join `catalog_models`
 * reports from — never a parallel per-model table.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const storeKeys = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }))
vi.mock("../providers-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers-store.js")>()
  return { ...actual, getProviderKey: vi.fn(async (p: string) => storeKeys.value[p]) }
})

import {
  buildCatalogModels,
  checkModelAdapterEligibility,
  modelAdapterIncompatibleMessage,
  type CatalogAdapterInput,
  type CatalogModelsResponse,
} from "../catalog-models.js"
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

const CLAUDE_CODE_DESC: AdapterAuthDescriptor = {
  provider: "anthropic",
  authEnforce: "always",
  authSubscription: {
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    unsetEnvAdd: ["ANTHROPIC_BASE_URL"],
  },
}

// A trimmed mirror of claude-code's REAL `models.allowed` (adapters/claude-code/
// src/index.ts): a small hand-curated gateway list. `deepseek/deepseek-v4-pro`
// IS on it; `deepseek/deepseek-v4-flash-0731` is NOT — exactly the production
// bug's shape.
const CLAUDE_CODE_ADAPTER: CatalogAdapterInput = {
  slug: "claude-code",
  routeSelection: "free",
  authDescriptor: CLAUDE_CODE_DESC,
  models: [
    { id: "claude-sonnet-5", provider: "anthropic" },
    { id: "deepseek/deepseek-v4-pro@openrouter", provider: "openrouter" },
    { id: "sference/glm-5.2@requesty", provider: "requesty" },
  ],
}

// Mirrors opencode's REAL auto-generated menu (buildOpencodeModelMenu in
// adapters/opencode/src/index.ts): every openrouter model the pricing catalog
// knows, including the flash model claude-code never curated.
const OPENCODE_ADAPTER: CatalogAdapterInput = {
  slug: "opencode",
  routeSelection: "derived-from-model",
  models: [
    { id: "openrouter/deepseek/deepseek-v4-flash-0731", provider: "openrouter" },
    { id: "openrouter/deepseek/deepseek-v4-pro", provider: "openrouter" },
  ],
}

const FIXTURE_ADAPTERS: CatalogAdapterInput[] = [CLAUDE_CODE_ADAPTER, OPENCODE_ADAPTER]

function fixtureCatalog(): Promise<CatalogModelsResponse> {
  return Promise.resolve(buildCatalogModels({ adapters: FIXTURE_ADAPTERS, profiles: [] }))
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
    loadDefaultsConfig: async () => undefined,
    listCatalogModels: fixtureCatalog,
  }
}

beforeEach(() => {
  storeKeys.value = {}
})

describe("checkModelAdapterEligibility — the pure predicate", () => {
  it("REJECTS an adapter for a model+route curated by OTHER installed adapters but not this one", async () => {
    const catalog = await fixtureCatalog()
    const v = checkModelAdapterEligibility(
      catalog,
      "claude-code",
      "deepseek/deepseek-v4-flash-0731",
      "openrouter",
    )
    expect(v.ok).toBe(false)
    expect(v.compatibleAdapters).toContain("opencode")
    expect(v.compatibleAdapters).not.toContain("claude-code")
  })

  it("ACCEPTS an adapter that curates the model+route itself (deepseek-v4-pro@openrouter)", async () => {
    const catalog = await fixtureCatalog()
    const v = checkModelAdapterEligibility(
      catalog,
      "claude-code",
      "deepseek/deepseek-v4-pro",
      "openrouter",
    )
    expect(v.ok).toBe(true)
    expect(v.compatibleAdapters).toEqual([])
  })

  it("ACCEPTS an adapter that curates a @requesty slug itself", async () => {
    const catalog = await fixtureCatalog()
    const v = checkModelAdapterEligibility(
      catalog,
      "claude-code",
      "sference/glm-5.2",
      "requesty",
    )
    expect(v.ok).toBe(true)
  })

  it("ACCEPTS when no installed adapter's catalog row covers the model+route (never over-reject an unproven combination)", async () => {
    const catalog = await fixtureCatalog()
    const v = checkModelAdapterEligibility(
      catalog,
      "claude-code",
      "totally-made-up-xyz-model",
      "openrouter",
    )
    expect(v.ok).toBe(true)
    expect(v.compatibleAdapters).toEqual([])
  })

  it("ACCEPTS a native (direct-vendor) model any curating adapter declares", async () => {
    const catalog = await fixtureCatalog()
    const v = checkModelAdapterEligibility(catalog, "claude-code", "claude-sonnet-5", "anthropic")
    expect(v.ok).toBe(true)
  })
})

describe("modelAdapterIncompatibleMessage — actionable, names the compatible adapters", () => {
  it("names the adapters that already curate the model on the route", () => {
    const msg = modelAdapterIncompatibleMessage({
      prefix: "agent_start",
      adapter: "claude-code",
      model: "deepseek/deepseek-v4-flash-0731",
      route: "openrouter",
      compatibleAdapters: ["opencode", "mastracode"],
    })
    expect(msg).toContain("claude-code")
    expect(msg).toContain("deepseek/deepseek-v4-flash-0731")
    expect(msg).toContain('"opencode"')
    expect(msg).toContain('"mastracode"')
    expect(msg).toMatch(/never switches adapters/i)
  })

  it("falls back to a 'no adapter' note when the compatible list is empty", () => {
    const msg = modelAdapterIncompatibleMessage({
      prefix: "agent_start",
      adapter: "claude-code",
      model: "x-ai/some-model",
      route: "openrouter",
      compatibleAdapters: [],
    })
    expect(msg).toMatch(/no installed adapter/i)
  })
})

describe("spawnAgentSession — adapter-capability guard at the spawn boundary", () => {
  // NOTE on model spelling in this block: a model string carrying an
  // explicit `@route` suffix (`deepseek/deepseek-v4-pro@openrouter`) gets
  // its `@route` auto-synthesized into `route.gateway` by `reconcileModelRoute`
  // BEFORE either guard runs — which would make both guards skip via the
  // SAME "operator explicitly named the wallet" exemption tested below. To
  // actually exercise the guard (route.gateway left undefined), these tests
  // use a BARE model id and pin the billing route via `auth.provider` — the
  // "per-spawn provider PIN" documented on `DefaultsAdapterAuthConfig.provider`
  // as "the sharp edge for by-model routers whose config routes a catalog-
  // 'anthropic' model elsewhere", which is how a fixed-provider adapter like
  // claude-code ends up billing a gateway with no `route.gateway` named — the
  // exact shape of the production incident.
  it("REJECTS the diagnosed bug: claude-code pinned onto openrouter (no route.gateway named) for a model only other adapters curate", async () => {
    storeKeys.value = { openrouter: "sk-or-v1-testkey000000" }
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "deepseek/deepseek-v4-flash-0731",
      auth: { mode: "api-key", provider: "openrouter" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected rejection")
    expect(result.code).toBe("model_adapter_incompatible")
    expect(result.message).toContain("claude-code")
    expect(result.message).toContain("opencode")
    expect(result.details).toMatchObject({
      adapter: "claude-code",
      model: "deepseek/deepseek-v4-flash-0731",
      route: "openrouter",
    })
    expect(startSession).not.toHaveBeenCalled()
  })

  it("ACCEPTS the model claude-code DOES curate on the same gateway (deepseek-v4-pro) — no over-broad 'claude-code = Anthropic only' regression", async () => {
    storeKeys.value = { openrouter: "sk-or-v1-testkey000000" }
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "deepseek/deepseek-v4-pro",
      auth: { mode: "api-key", provider: "openrouter" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it("ACCEPTS a curated @requesty slug claude-code declares", async () => {
    storeKeys.value = { requesty: "sk-req-testkey000000" }
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "sference/glm-5.2",
      auth: { mode: "api-key", provider: "requesty" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it("ACCEPTS a native model on the subscription wallet (direct route, untouched by this guard)", async () => {
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "claude-sonnet-5",
      auth: { mode: "subscription", token: "sk-ant-oat01-testtoken00000" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it("does NOT reject when route.gateway is EXPLICIT — the operator named the wallet deliberately (e.g. an arbitrary model via moonshot's base_url)", async () => {
    storeKeys.value = { moonshot: "sk-moonshot-testkey000000" }
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const result = await spawnAgentSession(deps(resolver), {
      adapter: "claude-code",
      cwd: "/tmp",
      // claude-sonnet-5 is only curated on the "anthropic" route in the
      // fixture — an explicit route.gateway must still bypass this guard,
      // exactly like the wallet guard immediately above it.
      model: "claude-sonnet-5",
      route: { gateway: "moonshot" },
      auth: { mode: "api-key" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it("does NOT guard when `listCatalogModels` isn't wired (host opted out / catalog_models disabled)", async () => {
    storeKeys.value = { openrouter: "sk-or-v1-testkey000000" }
    const { resolver, startSession } = makeResolver(CLAUDE_CODE_DESC)
    const unwiredDeps: SpawnAgentSessionDeps = {
      registry: createSessionsRegistry({ persist: false }),
      resolveAgentAdapter: resolver,
      loadDefaultsConfig: async () => undefined,
    }
    const result = await spawnAgentSession(unwiredDeps, {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "deepseek/deepseek-v4-flash-0731",
      auth: { mode: "api-key", provider: "openrouter" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
  })
})

describe("restartAgentSession — the adapter-capability guard is mirrored on the restart path", () => {
  it("REJECTS a restart override onto a gateway model claude-code doesn't curate", async () => {
    const { resolver } = makeResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "claude-code",
      auth: {
        mode: "api-key",
        fingerprint: "api-key · sk-or…OLD1",
        provider: "openrouter",
        credentialSource: "explicit-config",
        setEnv: "ANTHROPIC_AUTH_TOKEN",
      },
    })
    const countBefore = registry.list().length

    await expect(
      // Bare model id (no `@route` suffix) + a config-pinned `auth.provider`
      // — same reasoning as the spawn-side tests above: a `@route` suffix on
      // the model gets auto-synthesized into `route.gateway` by
      // `reconcileModelRoute`, which would make this guard's "operator
      // explicitly named the wallet" exemption swallow the very case under
      // test. Pinning the provider via config (not the model string, not
      // `route.gateway`) is how a fixed-provider adapter like claude-code
      // ends up billing a gateway with no `route.gateway` named.
      restartAgentSession(registry, resolver, prev, {
        forceAgentResume: true,
        loadDefaultsConfig: async () => ({
          adapters: {
            "claude-code": {
              auth: { apiKey: "sk-or-v1-freshkey99999", provider: "openrouter" },
            },
          },
        }),
        listCatalogModels: fixtureCatalog,
        overrides: { model: "deepseek/deepseek-v4-flash-0731" },
      }),
    ).rejects.toThrow(RestartOverrideError)

    expect(registry.list()).toHaveLength(countBefore)
  })

  it("ACCEPTS a restart override onto a model claude-code DOES curate", async () => {
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
      listCatalogModels: fixtureCatalog,
      overrides: { model: "claude-sonnet-5" },
    })
    expect(restarted.desc.model).toBe("claude-sonnet-5")
  })
})
