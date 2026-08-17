/**
 * Unit coverage for `spawnAgentSession` (session-spawn.ts) — the shared
 * spawn logic extracted from agent-tools.ts's `agent_start` handler.
 * Calls the function directly (no MCP transport) so these are cheap,
 * synchronous-ish checks of the orchestrator guardrails + the hermes
 * default-mcpServers safety net. The MCP-level behaviour is covered
 * separately (agent-start-mode.test.ts, orchestrator-guardrails.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { AcpMcpServer } from "@agentproto/acp"

// Control the providers.json api-key lookup deterministically (the resolver's
// api-key store source), so these tests never read the real ~/.agentproto file.
const storeKeys = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }))
vi.mock("../providers-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers-store.js")>()
  return { ...actual, getProviderKey: vi.fn(async (p: string) => storeKeys.value[p]) }
})

// Control `~/.agentproto/workspaces.json` deterministically — the worktree
// explicit-repo guard tests below need to simulate an active workspace that
// resolves to SOME path (possibly an unrelated repo) without ever touching
// the real file on the machine running the suite. `findWorkspace` /
// `findWorkspaceByPath` / `getActiveWorkspace` stay real (pure lookups over
// whatever `wsConfigState.value` holds).
const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

// Control the `claude-code-oauth` recipe resolver deterministically — the Mode-3
// self-refreshing source path — so these tests never touch the real Keychain.
const oauthState = vi.hoisted(() => ({
  impl: (async (_id: string) => "sk-ant-oat01-fresh-from-keychain") as (id: string) => Promise<string>,
  // File-based (external) login presence check — default: login present (void).
  // A test sets `verifyImpl` to throw a SubscriptionSourceError to exercise the
  // fail-loud "not logged in" path.
  verifyImpl: (async (_recipeId: string, _slug: string) => {}) as (
    recipeId: string,
    slug: string,
  ) => Promise<void>,
}))
vi.mock("../claude-code-oauth-source.js", () => ({
  resolveClaudeCodeOauthToken: (id: string) => oauthState.impl(id),
  verifyLocalLoginPresent: (recipeId: string, slug: string) =>
    oauthState.verifyImpl(recipeId, slug),
}))

// Control named auth-profile resolution (`access.profileRef`) deterministically
// — the profile-path branch's `getAuthProfile` + `KeychainStore` reads — so
// these tests never touch the real `~/.agentproto/auth-profiles.json` or
// keychain. `eligibleProfiles` stays real (pure, endpoint/method only).
const authProfileState = vi.hoisted(() => ({
  profiles: {} as Record<string, import("@agentproto/auth").AuthProfile>,
  keychain: {} as Record<string, string | undefined>,
}))
vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  return {
    ...actual,
    getAuthProfile: vi.fn(async (id: string) => authProfileState.profiles[id]),
    KeychainStore: vi.fn().mockImplementation(() => ({
      read: vi.fn(async ({ path }: { path: string }) => {
        const value = authProfileState.keychain[path]
        return value !== undefined ? { value, kind: "oat" as const } : undefined
      }),
    })),
  }
})

import {
  spawnAgentSession,
  cleanAgentLines,
  gcSpawnClaims,
  shouldInjectDaemonSelfMount,
  type SpawnAgentSessionDeps,
  type SpawnAgentSessionResult,
  type SpawnClaim,
} from "../session-spawn.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"
import { SubscriptionSourceError } from "../spawn-defaults.js"
import { getMcpCredentialDeps, setMcpCredentialDeps } from "../mcp-credential-deps.js"
import {
  createSessionsRegistry,
  SESSION_ID_ENV,
  WORKSPACE_SLUG_ENV,
  PARENT_SESSION_ID_ENV,
  type SessionsRegistry,
} from "../sessions.js"
import { cdContractLine } from "../agents-md.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { OrchestratorScope } from "../orchestrator-gateway.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type {
  WorktreeIsolationMode,
  WorktreeProvisioner,
  WorktreeProvisionOutcome,
} from "../worktree-isolation.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function makeResolver(startSession: ReturnType<typeof vi.fn>): AgentAdapterResolver {
  return async () => ({
    startSession,
    commandPreview: "mock-adapter",
  })
}

function baseDeps(overrides: Partial<SpawnAgentSessionDeps> = {}): {
  registry: SessionsRegistry
  deps: SpawnAgentSessionDeps
} {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = vi.fn(async () => fakeAgentSession())
  const deps: SpawnAgentSessionDeps = {
    registry,
    resolveAgentAdapter: makeResolver(startSession),
    // Fast, deterministic AGENTS.md resolution by default so the existing
    // spawn tests never touch the real filesystem / git / config. Individual
    // tests override `resolveAgentsMd` (or pass `undefined` to fall through
    // to the REAL resolver) to exercise the actual injection path — see the
    // AGENTS.md describe blocks below. `contractLine` mirrors the real
    // resolver's shape (non-empty, present in every mode incl. "absent") so
    // the many tests using this default aren't exercising an unrealistic
    // empty-contract-line shape the production resolver never actually returns.
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    ...overrides,
  }
  return { registry, deps }
}

describe("spawnAgentSession", () => {
  it("injects AGENTPROTO_SESSION_ID/AGENTPROTO_WORKSPACE_SLUG into startSession's env, matching the minted descriptor id — each spawn gets its OWN id, never a shared/prior one", async () => {
    const startSession = vi.fn(async (_opts: { env?: Record<string, string> }) =>
      fakeAgentSession(),
    )
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })

    const first = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      workspaceSlug: "real-workspace",
    })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error("expected spawn")

    const firstEnv = startSession.mock.calls[0]?.[0]?.env
    expect(firstEnv).toEqual({
      [SESSION_ID_ENV]: first.descriptor.id,
      [WORKSPACE_SLUG_ENV]: "real-workspace",
    })

    const second = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      workspaceSlug: "real-workspace",
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("expected spawn")

    const secondEnv = startSession.mock.calls[1]?.[0]?.env
    // Own id, not the first spawn's — no accidental sharing/inheritance
    // across two spawns from the same deps/resolver.
    expect(secondEnv?.[SESSION_ID_ENV]).toBe(second.descriptor.id)
    expect(secondEnv?.[SESSION_ID_ENV]).not.toBe(firstEnv?.[SESSION_ID_ENV])
  })

  it("expands a user preset at the shared spawn boundary and records every axis", async () => {
    const { deps } = baseDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      preset: {
        id: "fast-route",
        label: "Fast route",
        model: "deepseek/deepseek-v4-pro",
        effort: "high",
        route: { gateway: "openrouter" },
        posture: "bypass",
        contextProfile: "lean",
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor).toMatchObject({
      model: "deepseek/deepseek-v4-pro",
      effort: "high",
      route: { gateway: "openrouter" },
      posture: "bypass",
      contextProfile: "lean",
    })
  })

  it("expands a location-pinned favorite: the preset's own cwd + skills drive a zero-input spawn", async () => {
    const captured: {
      cwd?: string
      options?: Record<string, boolean | number | string>
    }[] = []
    const startSession = vi.fn(
      async (opts: { cwd?: string; options?: Record<string, boolean | number | string> }) => {
        captured.push({ cwd: opts.cwd, options: opts.options })
        return fakeAgentSession()
      },
    )
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      declaredOptions: [{ id: "skills", type: "string" }],
    })
    const { deps } = baseDeps({ resolveAgentAdapter })

    // No explicit cwd and no explicit skills on the call — a true zero-input
    // favorite spawn. The favorite pins both, so the spawn lands in the
    // preset's repo with the preset's skills preloaded.
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      preset: {
        id: "pinned-repo",
        label: "Pinned repo",
        cwd: "/tmp",
        skills: ["agentproto"],
      },
    })
    expect(result.ok).toBe(true)
    expect(captured[0]?.cwd).toBe("/tmp")
    expect(captured[0]?.options?.skills).toBe("agentproto")
  })

  it("an explicit cwd/skills call still wins over the favorite's pinned values", async () => {
    const captured: {
      cwd?: string
      options?: Record<string, boolean | number | string>
    }[] = []
    const startSession = vi.fn(
      async (opts: { cwd?: string; options?: Record<string, boolean | number | string> }) => {
        captured.push({ cwd: opts.cwd, options: opts.options })
        return fakeAgentSession()
      },
    )
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      declaredOptions: [{ id: "skills", type: "string" }],
    })
    const { deps } = baseDeps({ resolveAgentAdapter })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      skills: ["explicit-only"],
      preset: {
        id: "pinned-repo",
        label: "Pinned repo",
        cwd: "/some/other/repo",
        skills: ["agentproto"],
      },
    })
    expect(result.ok).toBe(true)
    expect(captured[0]?.cwd).toBe("/tmp")
    expect(captured[0]?.options?.skills).toBe("explicit-only")
  })

  it("forwards decomposed posture/contextProfile and applies a native posture before the opening prompt", async () => {
    const switched: string[] = []
    const startSession = vi.fn(async () => ({
      ...fakeAgentSession(),
      availableModes: [{ id: "plan", name: "Plan" }],
      async setSessionMode(modeId: string) {
        switched.push(modeId)
        return { applied: true, modeId }
      },
    }))
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      prompt: "Inspect this repository",
      posture: "plan",
      contextProfile: "lean",
    })

    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      posture: "plan",
      contextProfile: "lean",
    }))
    expect(switched).toEqual(["plan"])
  })

  it("forwards commandSandbox verbatim to the resolved adapter's startSession — distinct from (and independent of) the AIP-36 `sandbox` field", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      commandSandbox: "workspace",
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ commandSandbox: "workspace" }),
    )
  })

  it("omits commandSandbox from startSession's opts when the caller never set it", async () => {
    const startSession = vi.fn(async (_opts: Record<string, unknown>) => fakeAgentSession())
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    const call = startSession.mock.calls.at(-1)?.[0]
    expect(call).not.toHaveProperty("commandSandbox")
  })

  it("strips the catalog `@route` suffix from the model delivered to the wire, but keeps it on the record", async () => {
    // A gateway catalog id carries an `@<route>` suffix (#683) so the picker
    // can pin the route. The upstream (ANTHROPIC_MODEL / wire `model`) does NOT
    // understand the suffix — OpenRouter rejects `z-ai/glm-5.2@openrouter` and
    // silently falls back to a default model. The suffix must be stripped for
    // the adapter's wire, while the session record keeps the catalog id.
    const startSession = vi.fn(async () => fakeAgentSession())
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      model: "z-ai/glm-5.2@openrouter",
      route: { gateway: "openrouter" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    // Wire: bare id, no `@openrouter`. Gateway carried separately, untouched.
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "z-ai/glm-5.2" }),
    )
    // Record: the catalog id (suffix intact) for the UI/echo.
    expect(result.descriptor).toMatchObject({
      model: "z-ai/glm-5.2@openrouter",
      route: { gateway: "openrouter" },
    })
  })

  it("passes a direct (routeless) model to the wire unchanged", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      model: "claude-opus-4-8",
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-8" }),
    )
  })

  it("bares the vendor prefix off a direct-anthropic id for an anthropic-native adapter, keeping the catalog id on the record", async () => {
    // The `claude` ACP wrapper / claude-sdk's ANTHROPIC_MODEL resolve only the
    // BARE Anthropic id — a leaked `anthropic/` prefix mis-resolves the model.
    // Gated on the adapter's manifest `provider: "anthropic"`.
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: { provider: "anthropic" },
    })
    const { deps } = baseDeps({ resolveAgentAdapter })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-4-5",
      // A caller-supplied base_url skips billing-auth resolution (the wire-model
      // logic under test is independent of it) — keeps this a focused unit test.
      route: { gateway: "anthropic", baseUrl: "http://127.0.0.1:65535" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    // Wire: bare product, prefix gone.
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-5" }),
    )
    // Record keeps the catalog id.
    expect(result.descriptor).toMatchObject({ model: "anthropic/claude-sonnet-4-5" })
  })

  it("keeps a gateway-routed (non-anthropic) vendor/product for an anthropic-native adapter", async () => {
    // claude-code/claude-sdk also route gateway models through base_url, where
    // the gateway needs the `vendor/product` id — only the `@route` is peeled.
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: { provider: "anthropic" },
    })
    const { deps } = baseDeps({ resolveAgentAdapter })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      model: "z-ai/glm-5.2@openrouter",
      route: { gateway: "openrouter", baseUrl: "http://127.0.0.1:65535" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "z-ai/glm-5.2" }),
    )
  })

  it("keeps the anthropic vendor prefix for a NON-anthropic (derived-from-model) adapter", async () => {
    // hermes & friends derive their route FROM the prefix — stripping it would
    // break routing. The gate on `provider === "anthropic"` excludes them.
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: { provider: "openrouter" },
      routeSelection: "derived-from-model",
    })
    const { deps } = baseDeps({ resolveAgentAdapter })
    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-4-5",
      route: { gateway: "anthropic", baseUrl: "http://127.0.0.1:65535" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/claude-sonnet-4-5" }),
    )
  })

  it("bares a direct Moonshot route for a free adapter, keeping the catalog ref on the record", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: { provider: "anthropic" },
      routeSelection: "free",
    })
    const { deps } = baseDeps({ resolveAgentAdapter })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-sdk",
      cwd: "/tmp",
      model: "moonshot/kimi-k2.7-code",
      route: { gateway: "moonshot", baseUrl: "http://127.0.0.1:65535" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "kimi-k2.7-code" }),
    )
    expect(result.descriptor).toMatchObject({
      model: "moonshot/kimi-k2.7-code",
      route: { gateway: "moonshot" },
      routeSelection: "free",
      adapterProvider: "anthropic",
    })
  })

  it("strips only the @openrouter suffix for a free adapter on an OpenRouter route", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: { provider: "anthropic" },
      routeSelection: "free",
    })
    const { deps } = baseDeps({ resolveAgentAdapter })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-sdk",
      cwd: "/tmp",
      model: "moonshotai/kimi-k2.7-code@openrouter",
      route: { gateway: "openrouter", baseUrl: "http://127.0.0.1:65535" },
    })
    expect(result.ok).toBe(true)
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "moonshotai/kimi-k2.7-code" }),
    )
  })

  it("strips only the @openrouter suffix for hermes, leaving the vendor prefix intact", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: { provider: "openrouter" },
      routeSelection: "derived-from-model",
    })
    const { deps } = baseDeps({ resolveAgentAdapter })
    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: "/tmp",
      model: "deepseek/deepseek-v4-pro@openrouter",
      route: { gateway: "openrouter", baseUrl: "http://127.0.0.1:65535" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek/deepseek-v4-pro" }),
    )
    expect(result.descriptor).toMatchObject({
      model: "deepseek/deepseek-v4-pro@openrouter",
      routeSelection: "derived-from-model",
      adapterProvider: "openrouter",
    })
  })

  it("stamps `boardId` onto the spawned descriptor's meta — and omits meta without it", async () => {
    const { deps } = baseDeps()
    const pinned = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      boardId: "cowork:main",
    })
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) throw new Error("expected spawn")
    expect(pinned.descriptor.meta).toEqual({ boardId: "cowork:main" })

    const plain = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp" })
    expect(plain.ok).toBe(true)
    if (!plain.ok) throw new Error("expected spawn")
    expect(plain.descriptor.meta).toBeUndefined()
  })

  it("(a) rejects a spawn that would exceed the caller scope's maxDepth", async () => {
    const { registry, deps } = baseDeps()
    const callerScope: OrchestratorScope = {
      token: "tok",
      tools: new Set(["agent_start"]),
      ownerSessionId: "deep-parent",
      depth: 3,
      maxDepth: 3,
      maxChildren: 8,
      role: "supervisor",
    }
    const result = await spawnAgentSession(
      { ...deps, callerScope },
      { adapter: "mock", cwd: "/tmp" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("orchestrator_max_depth_exceeded")
    expect(result.details).toMatchObject({ depth: 3, childDepth: 4, maxDepth: 3 })
    expect(registry.list()).toHaveLength(0)
  })

  it("(b) rejects a spawn past the caller scope's maxChildren quota", async () => {
    const { registry, deps } = baseDeps()
    const owner = "quota-parent"
    const callerScope: OrchestratorScope = {
      token: "tok",
      tools: new Set(["agent_start"]),
      ownerSessionId: owner,
      depth: 0,
      maxDepth: 3,
      maxChildren: 1,
      role: "supervisor",
    }
    const first = await spawnAgentSession(
      { ...deps, callerScope },
      { adapter: "mock", cwd: "/tmp" },
    )
    expect(first.ok).toBe(true)

    const second = await spawnAgentSession(
      { ...deps, callerScope },
      { adapter: "mock", cwd: "/tmp" },
    )
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error("expected failure")
    expect(second.code).toBe("orchestrator_child_quota_exceeded")
    expect(second.details).toMatchObject({ aliveChildren: 1, maxChildren: 1 })
    expect(
      registry.list().filter(s => s.parentSessionId === owner),
    ).toHaveLength(1)
  })

  it("(c) defaults mcpServers to the daemon gateway for a hermes spawn with none supplied", async () => {
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    const daemonMcpUrl = "http://127.0.0.1:18790/mcp"
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      daemonMcpUrl,
    })

    const result = await spawnAgentSession(deps, { adapter: "hermes", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    // PR 7 / Gap 7: the injected ref carries `callerSessionId=<this session's
    // OWN id>` — minted before the child starts (see session-spawn.ts) so a
    // command_execute call this child makes back through it can be
    // attributed to it. The id has to match the resulting descriptor's own
    // id, not some other value, or attribution would point at the wrong
    // session.
    const ownId = result.ok ? result.descriptor.id : "(spawn failed)"
    expect(captured[0]?.mcpServers).toEqual([
      { name: "agentproto", transport: "http", ref: `${daemonMcpUrl}?callerSessionId=${ownId}` },
    ])
  })

  it("(c) respects an explicit empty mcpServers opt-out for hermes — no default injected", async () => {
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    })

    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: "/tmp",
      mcpServers: [],
    })
    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toEqual([])
  })

  it("(c) does not default mcpServers for an adapter outside the self-mount set", async () => {
    // Mounting the daemon into adapters that never had it (codex, gemini, …)
    // would be a capability grant, not an identity fix — they stay opt-in.
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    })

    const result = await spawnAgentSession(deps, { adapter: "codex", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toBeUndefined()
  })

  it("(c) defaults mcpServers to the stamped daemon gateway for a claude-code spawn with none supplied", async () => {
    // The identity arm of the default self-mount: claude-code sessions used
    // to reach the daemon only through ambient project/global MCP config,
    // which can never carry a per-session `callerSessionId` — so every spawn
    // they made landed as an anonymous depth-0 orphan (spawn-attach.ts had
    // no auto-parent to derive). The injected same-named entry shadows the
    // ambient mount at the SDK layer and bakes the identity in.
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    const daemonMcpUrl = "http://127.0.0.1:18790/mcp"
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      daemonMcpUrl,
    })

    const result = await spawnAgentSession(deps, { adapter: "claude-code", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    const ownId = result.ok ? result.descriptor.id : "(spawn failed)"
    expect(captured[0]?.mcpServers).toEqual([
      { name: "agentproto", transport: "http", ref: `${daemonMcpUrl}?callerSessionId=${ownId}` },
    ])
  })

  it("(c) respects an explicit empty mcpServers opt-out for claude-code — no default injected", async () => {
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    })

    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      mcpServers: [],
    })
    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toEqual([])
  })

  it("(c) shouldInjectDaemonSelfMount: hermes always, claude-code on-host only, others never", () => {
    // hermes keeps its historical behaviour even for a sandbox spawn (the
    // box's own daemon re-resolves the spawn on its side); claude-code's
    // mount is identity-only and a box can't reach this daemon's loopback
    // gateway, so a sandbox spawn is excluded.
    expect(shouldInjectDaemonSelfMount("hermes", undefined)).toBe(true)
    expect(shouldInjectDaemonSelfMount("hermes", "e2b")).toBe(true)
    expect(shouldInjectDaemonSelfMount("claude-code", undefined)).toBe(true)
    expect(shouldInjectDaemonSelfMount("claude-code", "e2b")).toBe(false)
    expect(shouldInjectDaemonSelfMount("codex", undefined)).toBe(false)
    expect(shouldInjectDaemonSelfMount("gemini", undefined)).toBe(false)
  })

  it("(c) stamps callerSessionId onto a CALLER-provided mcpServers entry that targets the daemon (identity ≠ capability)", async () => {
    // A claude-code supervisor pointed at the daemon explicitly: the daemon
    // grants no new tools, but identity-stamps the entry so this session's
    // sub-agents auto-attach under it. Non-hermes, caller-supplied — the path
    // the hermes-only default never covered.
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    const daemonMcpUrl = "http://127.0.0.1:18790/mcp"
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      daemonMcpUrl,
    })

    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      mcpServers: [{ name: "agentproto", transport: "http", ref: daemonMcpUrl }],
    })
    expect(result.ok).toBe(true)
    const ownId = result.ok ? result.descriptor.id : "(spawn failed)"
    expect(captured[0]?.mcpServers).toEqual([
      { name: "agentproto", transport: "http", ref: `${daemonMcpUrl}?callerSessionId=${ownId}` },
    ])
  })

  it("(c) leaves a caller mcpServers entry that does NOT target this daemon untouched", async () => {
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    })

    const foreign = { name: "other", transport: "http" as const, ref: "https://example.com/mcp" }
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      mcpServers: [foreign],
    })
    expect(result.ok).toBe(true)
    // untouched: not the daemon's own endpoint → no callerSessionId appended
    expect(captured[0]?.mcpServers).toEqual([foreign])
  })

  it("(c) does not double-stamp a caller entry that already carries callerSessionId", async () => {
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    const daemonMcpUrl = "http://127.0.0.1:18790/mcp"
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      daemonMcpUrl,
    })

    const preset = {
      name: "agentproto",
      transport: "http" as const,
      ref: `${daemonMcpUrl}?callerSessionId=explicit-id`,
    }
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      mcpServers: [preset],
    })
    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toEqual([preset])
  })

  it("(d) folds config defaults.skills into options.skills per the adapter's declared shape", async () => {
    const captured: { options?: Record<string, boolean | number | string> }[] = []
    const startSession = vi.fn(
      async (opts: { options?: Record<string, boolean | number | string> }) => {
        captured.push({ options: opts.options })
        return fakeAgentSession()
      },
    )
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      declaredOptions: [{ id: "skills", type: "string" }],
    })
    const { deps } = baseDeps({
      resolveAgentAdapter,
      loadDefaultsConfig: async () => ({
        skills: ["agentproto"],
        adapters: { hermes: { skills: ["agentproto-package-scaffolding"] } },
      }),
    })

    const result = await spawnAgentSession(deps, { adapter: "hermes", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    expect(captured[0]?.options?.skills).toBe(
      "agentproto,agentproto-package-scaffolding",
    )
  })

  it("(d) an explicit `skills` call fully replaces config defaults (no union)", async () => {
    const captured: { options?: Record<string, boolean | number | string> }[] = []
    const startSession = vi.fn(
      async (opts: { options?: Record<string, boolean | number | string> }) => {
        captured.push({ options: opts.options })
        return fakeAgentSession()
      },
    )
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      declaredOptions: [{ id: "skills", type: "string" }],
    })
    const { deps } = baseDeps({
      resolveAgentAdapter,
      loadDefaultsConfig: async () => ({ skills: ["agentproto"] }),
    })

    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: "/tmp",
      skills: ["explicit-only"],
    })
    expect(result.ok).toBe(true)
    expect(captured[0]?.options?.skills).toBe("explicit-only")
  })

  it("(d) is a no-op when the adapter declares no skills option (e.g. claude-code)", async () => {
    const captured: { options?: Record<string, boolean | number | string> }[] = []
    const startSession = vi.fn(
      async (opts: { options?: Record<string, boolean | number | string> }) => {
        captured.push({ options: opts.options })
        return fakeAgentSession()
      },
    )
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      loadDefaultsConfig: async () => ({ skills: ["agentproto"] }),
    })

    const result = await spawnAgentSession(deps, { adapter: "claude-code", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    expect(captured[0]?.options).toBeUndefined()
  })
})

describe("spawnAgentSession — agent_start idempotency (idempotencyKey)", () => {
  // Reproduces the measured incident: one logical agent_start call arrives
  // twice (slow/lost response + caller retry) with identical adapter/cwd/
  // label/prompt. Without idempotencyKey this forks TWO processes into the
  // same cwd, and the caller only ever learns the SECOND session's id.

  it("a sequential retry with the same idempotencyKey spawns ONE process and returns the SAME descriptor", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const input = {
      adapter: "mock",
      cwd: "/tmp",
      label: "worker",
      prompt: "do the thing",
      idempotencyKey: "req-1",
    }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(1)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(first.deduped).toBeUndefined()
    expect(second.deduped).toBe(true)
  })

  it("two truly concurrent calls (Promise.all, no await between them) with the same idempotencyKey still spawn only ONE process", async () => {
    // The claim is staked synchronously (check-then-set, no `await` in
    // between) right before the process fork, so whichever call's JS
    // turn reaches that line first wins it — correct regardless of how
    // the two calls' earlier `await`s (cwd resolution, adapter lookup,
    // role resolution, …) happen to interleave. A naive "scan existing
    // registry sessions" check would miss this tighter race (neither
    // call has registered yet); staking a claim up front closes it.
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const input = { adapter: "mock", cwd: "/tmp", idempotencyKey: "req-race" }

    const [first, second] = await Promise.all([
      spawnAgentSession(deps, input),
      spawnAgentSession(deps, input),
    ])

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(1)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
  })

  it("omitting idempotencyKey under an 'on-request' dedupe policy is a no-op — repeated identical calls still spawn independently", async () => {
    // Under the DEFAULT `spawn.dedupe: 'always'` policy this exact input (a
    // label present, no idempotencyKey) now derives an implicit key and
    // dedupes — see the "implicit dedupe default" describe block below for
    // that behaviour. Pinning the policy to 'on-request' here isolates the
    // pre-WP-E baseline this test was written to document: no policy, no
    // opt-in ⇒ no dedup, exactly like an explicit idempotencyKey never
    // being passed.
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: async () => "on-request",
    })
    const input = { adapter: "mock", cwd: "/tmp", label: "worker" }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(2)
    expect(registry.list()).toHaveLength(2)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).not.toBe(first.descriptor.id)
  })

  it("a different idempotencyKey (or a different cwd) is treated as a distinct spawn", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })

    const a = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp", idempotencyKey: "one" })
    const b = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp", idempotencyKey: "two" })
    const c = await spawnAgentSession(deps, { adapter: "mock", cwd: "/elsewhere", idempotencyKey: "one" })

    expect(startSession).toHaveBeenCalledTimes(3)
    expect(registry.list()).toHaveLength(3)
    expect(a.ok && b.ok && c.ok).toBe(true)
  })

  it("a FAILED spawn is never cached — a retry with the same key tries again instead of replaying the error", async () => {
    const startSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("adapter boot failed"))
      .mockImplementationOnce(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const input = { adapter: "mock", cwd: "/tmp", idempotencyKey: "req-retry-after-error" }

    const first = await spawnAgentSession(deps, input)
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error("expected failure")
    expect(first.code).toBe("agent_spawn_failed")

    const second = await spawnAgentSession(deps, input)
    expect(startSession).toHaveBeenCalledTimes(2)
    expect(second.ok).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })

  it("a same-key retry outside the dedupe window spawns a fresh process", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const input = { adapter: "mock", cwd: "/tmp", idempotencyKey: "req-stale" }
    const nowSpy = vi.spyOn(Date, "now")

    nowSpy.mockReturnValue(1_000)
    const first = await spawnAgentSession(deps, input)
    expect(first.ok).toBe(true)

    // Past SPAWN_CLAIM_WINDOW_MS (10 minutes).
    nowSpy.mockReturnValue(1_000 + 600_001)
    const second = await spawnAgentSession(deps, input)
    expect(second.ok).toBe(true)

    expect(startSession).toHaveBeenCalledTimes(2)
    expect(registry.list()).toHaveLength(2)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).not.toBe(first.descriptor.id)
    expect(second.deduped).toBeUndefined()

    nowSpy.mockRestore()
  })

  it("a legitimate orchestrator fan-out — identical adapter/cwd, NO idempotencyKey — still spawns two distinct sessions, exactly like test (b) above but proving the fix doesn't regress it", async () => {
    const { registry, deps } = baseDeps()
    const callerScope: OrchestratorScope = {
      token: "tok",
      tools: new Set(["agent_start"]),
      ownerSessionId: "fanout-parent",
      depth: 0,
      maxDepth: 3,
      maxChildren: 8,
      role: "supervisor",
    }
    const first = await spawnAgentSession({ ...deps, callerScope }, { adapter: "mock", cwd: "/tmp" })
    const second = await spawnAgentSession({ ...deps, callerScope }, { adapter: "mock", cwd: "/tmp" })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).not.toBe(first.descriptor.id)
    expect(
      registry.list().filter(s => s.parentSessionId === "fanout-parent"),
    ).toHaveLength(2)
  })

  it("a same-key retry 42s later (the measured incident gap) is still deduped — the old 30s window would have missed it", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const input = { adapter: "mock", cwd: "/tmp", idempotencyKey: "req-incident-gap" }
    const nowSpy = vi.spyOn(Date, "now")

    nowSpy.mockReturnValue(1_000)
    const first = await spawnAgentSession(deps, input)
    expect(first.ok).toBe(true)

    nowSpy.mockReturnValue(1_000 + 42_000)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(1)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(second.deduped).toBe(true)

    nowSpy.mockRestore()
  })
})

describe("spawnAgentSession — implicit dedupe default (spawn.dedupe policy, WP-E)", () => {
  // Every test here pins `resolveSpawnDedupe` explicitly (rather than
  // relying on the real ~/.agentproto/config.json fallback, which the
  // hardcoded default also resolves to "always") for the same reason the
  // worktree-isolation suite pins `resolveWorktreeIsolation` everywhere:
  // deterministic tests shouldn't depend on whatever happens to be in a
  // config file on the machine running them.
  const alwaysDedupe = async () => "always" as const
  const onRequestDedupe = async () => "on-request" as const

  it("under the default ('always') policy, a repeated labeled+prompted call derives an implicit key and dedupes to ONE process", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: alwaysDedupe,
    })
    const input = { adapter: "mock", cwd: "/tmp", label: "worker", prompt: "do the thing" }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(1)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(first.deduped).toBeUndefined()
    expect(second.deduped).toBe(true)
    expect(second.dedupeSource).toBe("implicit")
  })

  it("fan-out safety net: no label, identical adapter/cwd/prompt — still spawns two distinct sessions under the default policy", async () => {
    // The false-dedup case the whole feature is built around: an
    // unlabelled parallel fan-out into one cwd must never collapse, even
    // under the default 'always' dedupe policy.
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: alwaysDedupe,
    })
    const input = { adapter: "mock", cwd: "/tmp", prompt: "do the thing" }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(2)
    expect(registry.list()).toHaveLength(2)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).not.toBe(first.descriptor.id)
    expect(second.deduped).toBeUndefined()
  })

  it("false-dedup guard: same label, a DIFFERENT prompt — spawns two distinct sessions (the reused-label-automation pattern)", async () => {
    // Mirrors the inbound-watcher spawn pattern (orchestration-tools.ts),
    // which reuses one label suffix across every relayed message but always
    // sends a different prompt.
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: alwaysDedupe,
    })

    const first = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      label: "watcher",
      prompt: "message one",
    })
    const second = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      label: "watcher",
      prompt: "message two",
    })

    expect(startSession).toHaveBeenCalledTimes(2)
    expect(registry.list()).toHaveLength(2)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).not.toBe(first.descriptor.id)
    expect(second.deduped).toBeUndefined()
  })

  it("an explicit idempotencyKey always wins over the derived implicit one, even when both would apply", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: alwaysDedupe,
    })
    const input = {
      adapter: "mock",
      cwd: "/tmp",
      label: "worker",
      prompt: "do the thing",
      idempotencyKey: "req-1",
    }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(1)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(second.deduped).toBe(true)
    expect(second.dedupeSource).toBe("explicit")
  })

  it("dedupe: false is the per-call escape hatch — spawns twice even under the default policy with a matching label+prompt", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: alwaysDedupe,
    })
    const input = {
      adapter: "mock",
      cwd: "/tmp",
      label: "worker",
      prompt: "do the thing",
      dedupe: false as const,
    }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(2)
    expect(registry.list()).toHaveLength(2)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).not.toBe(first.descriptor.id)
    expect(second.deduped).toBeUndefined()
  })

  it("dedupe: true is the per-call opt-in — derives and dedupes even under an 'on-request' policy", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: onRequestDedupe,
    })
    const input = {
      adapter: "mock",
      cwd: "/tmp",
      label: "worker",
      prompt: "do the thing",
      dedupe: true as const,
    }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(1)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(second.deduped).toBe(true)
    expect(second.dedupeSource).toBe("implicit")
  })

  it("an 'on-request' policy with no per-call opt-in derives nothing — repeated calls spawn independently (today's pre-WP-E behaviour, still available)", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: onRequestDedupe,
    })
    const input = { adapter: "mock", cwd: "/tmp", label: "worker", prompt: "do the thing" }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(2)
    expect(registry.list()).toHaveLength(2)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).not.toBe(first.descriptor.id)
  })

  it("the implicit window (IMPLICIT_SPAWN_CLAIM_WINDOW_MS, 2min) is shorter than the explicit one — a repeat just past it spawns fresh", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: alwaysDedupe,
    })
    const input = { adapter: "mock", cwd: "/tmp", label: "worker", prompt: "do the thing" }
    const nowSpy = vi.spyOn(Date, "now")

    nowSpy.mockReturnValue(1_000)
    const first = await spawnAgentSession(deps, input)
    expect(first.ok).toBe(true)

    // Just past the 120s implicit window, but nowhere near the explicit
    // key's 600s window — proving the SHORTER window applies here.
    nowSpy.mockReturnValue(1_000 + 120_001)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(2)
    expect(registry.list()).toHaveLength(2)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).not.toBe(first.descriptor.id)
    expect(second.deduped).toBeUndefined()

    nowSpy.mockRestore()
  })

  it("a repeat WITHIN the implicit window is still deduped", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: alwaysDedupe,
    })
    const input = { adapter: "mock", cwd: "/tmp", label: "worker", prompt: "do the thing" }
    const nowSpy = vi.spyOn(Date, "now")

    nowSpy.mockReturnValue(1_000)
    const first = await spawnAgentSession(deps, input)
    expect(first.ok).toBe(true)

    nowSpy.mockReturnValue(1_000 + 90_000)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(1)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(second.deduped).toBe(true)

    nowSpy.mockRestore()
  })

  it("integration: the default policy supersedes the label+cwd warning backstop for its own incident shape — the second call is DEDUPED, not just warned", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: alwaysDedupe,
    })
    const input = { adapter: "mock", cwd: "/tmp", label: "worker" }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(1)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(second.deduped).toBe(true)
    expect(second.dedupeSource).toBe("implicit")
    // No "another LIVE session" warning fires — the second call never
    // reached the registry.spawnAgent + warning check at all.
    expect(second.warnings ?? []).toHaveLength(0)
  })
})

describe("spawnAgentSession — resolved-claim eviction policy (gcSpawnClaims)", () => {
  // Pure-function coverage of the size/LRU backstop, without driving 1000+
  // real spawns through spawnAgentSession(). See the sizing docblock above
  // SPAWN_CLAIM_WINDOW_MS / MAX_RESOLVED_CLAIMS in session-spawn.ts.
  function resolvedClaim(resolvedAt: number): SpawnClaim {
    return { result: Promise.resolve({ ok: true } as SpawnAgentSessionResult), resolvedAt }
  }
  function inFlightClaim(): SpawnClaim {
    return { result: new Promise(() => {}) }
  }

  it("drops a resolved claim once it's older than SPAWN_CLAIM_WINDOW_MS", () => {
    const claims = new Map<string, SpawnClaim>([
      ["stale", resolvedClaim(0)],
      ["fresh", resolvedClaim(500_000)],
    ])
    gcSpawnClaims(claims, 700_000)
    expect(claims.has("stale")).toBe(false)
    expect(claims.has("fresh")).toBe(true)
  })

  it("never evicts an in-flight claim on time, however old its entry", () => {
    const claims = new Map<string, SpawnClaim>([["pending", inFlightClaim()]])
    gcSpawnClaims(claims, 10_000_000)
    expect(claims.has("pending")).toBe(true)
  })

  it("evicts the OLDEST-resolved entries first once resolved claims exceed MAX_RESOLVED_CLAIMS", () => {
    const claims = new Map<string, SpawnClaim>()
    // All well within the time window — only the size bound should fire.
    for (let i = 0; i < 1_005; i++) {
      claims.set(`key-${i}`, resolvedClaim(i))
    }
    gcSpawnClaims(claims, 1_005)
    expect(claims.size).toBe(1_000)
    // The 5 oldest-resolved (lowest resolvedAt) are gone…
    for (let i = 0; i < 5; i++) expect(claims.has(`key-${i}`)).toBe(false)
    // …the newest 1000 survive.
    for (let i = 5; i < 1_005; i++) expect(claims.has(`key-${i}`)).toBe(true)
  })

  it("an in-flight claim never counts against the resolved-claim size cap", () => {
    const claims = new Map<string, SpawnClaim>()
    for (let i = 0; i < 1_000; i++) claims.set(`resolved-${i}`, resolvedClaim(i))
    claims.set("pending", inFlightClaim())
    gcSpawnClaims(claims, 1_000)
    expect(claims.has("pending")).toBe(true)
    expect(claims.size).toBe(1_001)
  })

  it("a claim's own windowMs (an implicit key's shorter window) governs its eviction, independent of other claims in the same map", () => {
    // Explicit and implicit claims share one map (see the `claimsFor`
    // docblock) but carry different windows — an implicit claim (120s) must
    // expire on its own schedule even while a same-map explicit claim
    // (600s, the default when `windowMs` is omitted) is still fresh.
    const claims = new Map<string, SpawnClaim>([
      ["implicit", { result: Promise.resolve({ ok: true } as SpawnAgentSessionResult), resolvedAt: 0, windowMs: 120_000 }],
      ["explicit", resolvedClaim(0)],
    ])
    gcSpawnClaims(claims, 150_000)
    expect(claims.has("implicit")).toBe(false)
    expect(claims.has("explicit")).toBe(true)
  })
})

describe("spawnAgentSession — no-key duplicate-live-session warning (label+cwd backstop)", () => {
  // Distinct from the idempotencyKey guard above: this needs no caller
  // opt-in and never blocks a spawn, it only warns — see the docblock at
  // the `desc.label && desc.cwd` check in session-spawn.ts.
  //
  // The two tests below that repeat an identical labeled input pin
  // `resolveSpawnDedupe` to 'on-request' so they keep exercising this
  // backstop in isolation: under the DEFAULT 'always' policy, a repeated
  // label+cwd+prompt call like theirs is now caught earlier by the implicit
  // dedupe claim (see the "implicit dedupe default" describe block below)
  // and never reaches this warning check at all — that interaction is
  // covered separately there.

  it("warns when a second LIVE session shares label AND cwd with an existing one", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: async () => "on-request",
    })
    const input = { adapter: "mock", cwd: "/tmp", label: "worker" }

    const first = await spawnAgentSession(deps, input)
    const second = await spawnAgentSession(deps, input)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error("expected success")
    expect(first.warnings ?? []).toHaveLength(0)
    expect(second.warnings?.some(w => w.includes("worker") && w.includes(first.descriptor.id))).toBe(
      true,
    )
  })

  it("does NOT warn when cwd matches but label differs", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })

    await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp", label: "worker-a" })
    const second = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp", label: "worker-b" })

    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("expected success")
    expect(second.warnings ?? []).toHaveLength(0)
  })

  it("does NOT warn when neither spawn carries a label, even sharing cwd (cwd alone is too noisy)", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })

    await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp" })
    const second = await spawnAgentSession(deps, { adapter: "mock", cwd: "/tmp" })

    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("expected success")
    expect(second.warnings ?? []).toHaveLength(0)
  })

  it("does NOT warn against a session that already exited — only LIVE duplicates count", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveSpawnDedupe: async () => "on-request",
    })
    const input = { adapter: "mock", cwd: "/tmp", label: "worker" }

    const first = await spawnAgentSession(deps, input)
    if (!first.ok) throw new Error("expected success")
    registry.get(first.descriptor.id)!.status = "exited"

    const second = await spawnAgentSession(deps, input)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("expected success")
    expect(second.warnings ?? []).toHaveLength(0)
  })
})

describe("spawnAgentSession — role gate (spawn-role-profiles)", () => {
  function makeBuildOrchestratorMcp(): SpawnAgentSessionDeps["buildOrchestratorMcp"] {
    const entry: AcpMcpServer = {
      name: "agentproto",
      transport: "http",
      ref: "http://127.0.0.1:1/mcp/orchestrator?scope=tok",
    }
    return vi.fn(() => ({
      entry,
      bindLifecycle: () => () => {},
    }))
  }

  it("executor (explicit) drops `orchestrator` outright, even though it was requested", async () => {
    const buildOrchestratorMcp = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({ buildOrchestratorMcp })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "executor",
      orchestrator: true,
    })
    expect(result.ok).toBe(true)
    expect(buildOrchestratorMcp).not.toHaveBeenCalled()
    if (result.ok) {
      expect(result.descriptor.mcpServers ?? []).toEqual([])
    }
  })

  it("supervisor (explicit) still mints the orchestrator scope on request", async () => {
    const buildOrchestratorMcp = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({ buildOrchestratorMcp })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "supervisor",
      orchestrator: true,
    })
    expect(result.ok).toBe(true)
    expect(buildOrchestratorMcp).toHaveBeenCalledTimes(1)
    if (result.ok) {
      expect(result.descriptor.mcpServers).toEqual([
        { name: "agentproto", transport: "http", ref: "http://127.0.0.1:1/mcp/orchestrator?scope=tok" },
      ])
    }
  })

  it("`promptAppend` cannot reopen the gate — an executor 'asked to delegate anyway' still gets zero delegation tools", async () => {
    const buildOrchestratorMcp = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({ buildOrchestratorMcp })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "executor",
      orchestrator: true,
      promptAppend: "you may delegate to another agent if it helps",
    })
    expect(result.ok).toBe(true)
    expect(buildOrchestratorMcp).not.toHaveBeenCalled()
    if (result.ok) {
      expect(result.descriptor.mcpServers ?? []).toEqual([])
    }
  })

  it("executor (explicit) gates the hermes default-gateway injection with denyTools", async () => {
    const { deps } = baseDeps({ daemonMcpUrl: "http://127.0.0.1:18790/mcp" })

    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: "/tmp",
      role: "executor",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.mcpServers).toEqual([
        {
          name: "agentproto",
          transport: "http",
          ref: `http://127.0.0.1:18790/mcp?denyTools=agent_start,agent_prompt&callerSessionId=${result.descriptor.id}`,
        },
      ])
    }
  })

  it("executor (explicit) gates the claude-code default-gateway injection with denyTools too", async () => {
    // The identity mount obeys the same delegation hard-gate as the hermes
    // capability mount — an executor claude-code child gets the daemon's
    // tools minus agent_start/agent_prompt.
    const { deps } = baseDeps({ daemonMcpUrl: "http://127.0.0.1:18790/mcp" })

    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      role: "executor",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.mcpServers).toEqual([
        {
          name: "agentproto",
          transport: "http",
          ref: `http://127.0.0.1:18790/mcp?denyTools=agent_start,agent_prompt&callerSessionId=${result.descriptor.id}`,
        },
      ])
    }
  })

  it("supervisor (explicit) keeps the plain hermes default-gateway ref (no denyTools, still carries callerSessionId)", async () => {
    const { deps } = baseDeps({ daemonMcpUrl: "http://127.0.0.1:18790/mcp" })

    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: "/tmp",
      role: "supervisor",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.mcpServers).toEqual([
        {
          name: "agentproto",
          transport: "http",
          ref: `http://127.0.0.1:18790/mcp?callerSessionId=${result.descriptor.id}`,
        },
      ])
    }
  })

  it("an unknown role name is rejected with a clear error, no session created", async () => {
    const { registry, deps } = baseDeps()

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "reviewer",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("invalid_role")
    expect(result.message).toMatch(/unknown role "reviewer"/)
    expect(registry.list()).toHaveLength(0)
  })

  it("composes the role's disposition + promptAppend into the initial prompt, disposition first", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const sendPrompt = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "executor",
      promptAppend: "focus on the CLI package",
      prompt: "fix the bug",
      wait: true,
    })
    expect(result.ok).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const sentMessage = sendPrompt.mock.calls[0]?.[1]
    const prompt = typeof sentMessage === "string" ? sentMessage : ""
    const dispositionIdx = prompt.indexOf("You are the leaf")
    const appendIdx = prompt.indexOf("focus on the CLI package")
    const taskIdx = prompt.indexOf("fix the bug")
    expect(dispositionIdx).toBeGreaterThanOrEqual(0)
    expect(dispositionIdx).toBeLessThan(appendIdx)
    expect(appendIdx).toBeLessThan(taskIdx)
  })

  it("depth-derived default: root spawn (depth 0) with no role defaults to supervisor", async () => {
    const buildOrchestratorMcp = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({ buildOrchestratorMcp })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      orchestrator: true,
    })
    expect(result.ok).toBe(true)
    expect(buildOrchestratorMcp).toHaveBeenCalledTimes(1)
  })

  it("depth-derived default: a spawn made through an orchestrator (depth 1) with no role defaults to executor", async () => {
    const buildOrchestratorMcp = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({ buildOrchestratorMcp })
    const callerScope: OrchestratorScope = {
      token: "tok",
      tools: new Set(["agent_start"]),
      depth: 0,
      maxDepth: 3,
      maxChildren: 8,
      role: "supervisor",
    }

    const result = await spawnAgentSession(
      { ...deps, callerScope },
      { adapter: "mock", cwd: "/tmp", orchestrator: true },
    )
    expect(result.ok).toBe(true)
    expect(buildOrchestratorMcp).not.toHaveBeenCalled()
  })

  it("`defaultRoleDepthCutoff` override is respected — raising it restores supervisor at depth 1", async () => {
    // Raising the cutoff to 2 makes the depth-1 child ALSO resolve to
    // supervisor (level 100) by depth-derivation, same as its depth-0
    // caller. The privilege gate's non-escalation default (child.level
    // <= parent.level) permits a peer spawn — this is the pre-existing
    // recursive-orchestrator pattern (fan-out bounded by maxDepth/
    // maxChildren, not this lattice), so raising the cutoff must keep
    // this spawn succeeding exactly as it did before this capability
    // existed.
    const buildOrchestratorMcp = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({
      buildOrchestratorMcp,
      loadDefaultsConfig: async () => ({ defaultRoleDepthCutoff: 2 }),
    })
    const callerScope: OrchestratorScope = {
      token: "tok",
      tools: new Set(["agent_start"]),
      depth: 0,
      maxDepth: 3,
      maxChildren: 8,
      role: "supervisor",
    }

    const result = await spawnAgentSession(
      { ...deps, callerScope },
      { adapter: "mock", cwd: "/tmp", orchestrator: true },
    )
    expect(result.ok).toBe(true)
    expect(buildOrchestratorMcp).toHaveBeenCalledTimes(1)
  })
})

describe("spawnAgentSession — title derives from the caller's prompt, not the composed role preamble", () => {
  // Each of these must fail before the fix: pre-fix, the descriptor title
  // is derived from `effectivePrompt` (role disposition + promptAppend +
  // prompt, composed), so `deriveSessionTitle` stops at the disposition's
  // first sentence — e.g. every executor spawn titled "You are the leaf",
  // regardless of what the caller actually asked for.

  it("role: executor — titles from the caller's prompt, not the executor disposition", async () => {
    const { deps } = baseDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "executor",
      prompt: "Fix the markdown renderer.",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.title).toBe("Fix the markdown renderer")
  })

  it("role: supervisor — titles from the caller's prompt, not the supervisor disposition", async () => {
    const { deps } = baseDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "supervisor",
      prompt: "Triage these two gaps.",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.title).toBe("Triage these two gaps")
  })

  it("role: executor + promptAppend — the appended text doesn't become the title either", async () => {
    const { deps } = baseDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "executor",
      promptAppend: "be terse",
      prompt: "Add a test.",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.title).toBe("Add a test")
  })

  it("no role — still titles from the prompt (regression guard: both ternary branches must title identically)", async () => {
    const { deps } = baseDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      prompt: "Update the docs.",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.title).toBe("Update the docs")
  })

  it("no prompt at spawn — titles later from the session's first real prompt (#390 self-heal, regression guard)", async () => {
    const { registry, deps } = baseDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "executor",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.title).toBeUndefined()

    await registry.sendPrompt(result.descriptor.id, "Do the thing.")
    expect(registry.get(result.descriptor.id)?.title).toBe("Do the thing")
  })
})

describe("spawnAgentSession — title slot precedence: explicit title > label > derived", () => {
  it("an explicit --title wins over both the label and the prompt", async () => {
    const { deps } = baseDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      title: "Explicit wins",
      label: "the-label",
      prompt: "Fix the markdown renderer.",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.title).toBe("Explicit wins")
  })

  it("uses the label VERBATIM (no sentence-split/derivation) when no explicit title", async () => {
    const { deps } = baseDeps()
    // A label that WOULD be mangled if run through `deriveSessionTitle`: it has
    // a sentence terminator, so derivation would guillotine it to "Ship it".
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      label: "Ship it. Then celebrate.",
      prompt: "Fix the markdown renderer.",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.title).toBe("Ship it. Then celebrate.")
  })

  it("a boilerplate-prompt spawn with a label titles from the label, not the disposition", async () => {
    const { deps } = baseDeps()
    // role: executor composes a "You are the leaf…" disposition ahead of the
    // prompt — pre-fix the title derived from that boilerplate. The label
    // carries the real intent and must win.
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "executor",
      label: "session-title-precedence",
      prompt: "You are an executor. Do the work.",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.title).toBe("session-title-precedence")
  })

  it("a whitespace-only label falls through to the prompt derivation", async () => {
    const { deps } = baseDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      label: "   ",
      prompt: "Update the docs.",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.title).toBe("Update the docs")
  })

  it("with neither title nor label, still derives from the prompt and caps at 72", async () => {
    const { deps } = baseDeps()
    const long = "a".repeat(200) // one unbroken token: forces the MAX_LENGTH cap
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      prompt: long,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    const title = result.descriptor.title
    expect(title).toBeDefined()
    expect(title?.endsWith("…")).toBe(true)
    expect(Array.from(title ?? "").length).toBe(73) // 72 + ellipsis
  })
})

describe("spawnAgentSession — privilege-lattice spawn gate (role-registry-extensible)", () => {
  const PLANNER_ROLE = {
    name: "planner",
    disposition: "You plan work and delegate execution.",
    toolPolicy: { delegation: "allow" as const },
    level: 50,
  }
  const REVIEWER_ROLE = {
    name: "reviewer",
    disposition: "You review code changes.",
    toolPolicy: { delegation: "deny" as const },
    level: 10,
  }

  function scopeWithRole(role: string): OrchestratorScope {
    return {
      token: "tok",
      tools: new Set(["agent_start"]),
      ownerSessionId: "parent",
      depth: 0,
      maxDepth: 3,
      maxChildren: 8,
      role,
    }
  }

  it("supervisor may spawn executor (open mode, strict descent)", async () => {
    const { registry, deps } = baseDeps()
    const result = await spawnAgentSession(
      { ...deps, callerScope: scopeWithRole("supervisor") },
      { adapter: "mock", cwd: "/tmp", role: "executor" },
    )
    expect(result.ok).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })

  it("executor (as caller) may not spawn anything — second line of defense beyond the tool gate", async () => {
    const { registry, deps } = baseDeps()
    const result = await spawnAgentSession(
      { ...deps, callerScope: scopeWithRole("executor") },
      { adapter: "mock", cwd: "/tmp", role: "supervisor" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("role_spawn_denied")
    expect(registry.list()).toHaveLength(0)
  })

  it("a custom planner (level 50) may spawn executor but not supervisor (open mode)", async () => {
    const { deps } = baseDeps({
      loadRoleRegistry: async () => ({ planner: PLANNER_ROLE }),
    })

    const okResult = await spawnAgentSession(
      { ...deps, callerScope: scopeWithRole("planner") },
      { adapter: "mock", cwd: "/tmp", role: "executor" },
    )
    expect(okResult.ok).toBe(true)

    const rejected = await spawnAgentSession(
      { ...deps, callerScope: scopeWithRole("planner") },
      { adapter: "mock", cwd: "/tmp", role: "supervisor" },
    )
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error("expected failure")
    expect(rejected.code).toBe("role_spawn_denied")
  })

  it("a closed `spawnableRoles` allowlist overrides level comparison entirely", async () => {
    const closedPlanner = { ...PLANNER_ROLE, spawnableRoles: ["executor"] }
    const { deps } = baseDeps({
      loadRoleRegistry: async () => ({ planner: closedPlanner, reviewer: REVIEWER_ROLE }),
    })

    const allowed = await spawnAgentSession(
      { ...deps, callerScope: scopeWithRole("planner") },
      { adapter: "mock", cwd: "/tmp", role: "executor" },
    )
    expect(allowed.ok).toBe(true)

    // reviewer (level 10) is strictly below planner (level 50) — would
    // pass open-mode strict descent — but the closed allowlist only
    // names "executor", so it's rejected anyway.
    const rejected = await spawnAgentSession(
      { ...deps, callerScope: scopeWithRole("planner") },
      { adapter: "mock", cwd: "/tmp", role: "reviewer" },
    )
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error("expected failure")
    expect(rejected.code).toBe("role_spawn_denied")
    expect(rejected.message).toMatch(/Allowed: executor/)
  })

  it("a root spawn (no callerScope) is never gated — nothing to gate against", async () => {
    const { registry, deps } = baseDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "supervisor",
    })
    expect(result.ok).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })
})

describe("resolveMcpCredentialHeaders overlay", () => {
  let originalDeps = getMcpCredentialDeps()

  beforeEach(() => {
    originalDeps = getMcpCredentialDeps()
    setMcpCredentialDeps({})
  })

  afterEach(() => {
    setMcpCredentialDeps(originalDeps)
  })

  function captureStartSession() {
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    return { captured, startSession }
  }

  it("merges brokered headers over static headers for an entry with credentialRef", async () => {
    const { captured, startSession } = captureStartSession()
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    setMcpCredentialDeps({
      resolveMcpCredentialHeaders: async ({ credentialRef }) => ({
        Authorization: `Bearer ${credentialRef}`,
        "X-Brokered": "yes",
      }),
    })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      mcpServers: [
        {
          name: "push",
          transport: "http",
          ref: "http://push/mcp",
          headers: { Authorization: "Bearer old", "X-Static": "ok" },
          credentialRef: "agentpush",
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toEqual([
      {
        name: "push",
        transport: "http",
        ref: "http://push/mcp",
        headers: {
          Authorization: "Bearer agentpush",
          "X-Static": "ok",
          "X-Brokered": "yes",
        },
        credentialRef: "agentpush",
      },
    ])
  })

  it("leaves an entry without credentialRef untouched", async () => {
    const { captured, startSession } = captureStartSession()
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    setMcpCredentialDeps({
      resolveMcpCredentialHeaders: async () => ({ Authorization: "Bearer unexpected" }),
    })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      mcpServers: [{ name: "local", transport: "stdio", ref: "/usr/bin/mcp" }],
    })

    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toEqual([
      { name: "local", transport: "stdio", ref: "/usr/bin/mcp" },
    ])
  })

  it("is non-fatal when the hook throws — the entry is unchanged and a warning is logged", async () => {
    const { captured, startSession } = captureStartSession()
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    setMcpCredentialDeps({
      resolveMcpCredentialHeaders: async ({ credentialRef }) => {
        throw new Error(`no keychain for ${credentialRef}`)
      },
    })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      mcpServers: [
        {
          name: "push",
          transport: "http",
          ref: "http://push/mcp",
          headers: { Authorization: "Bearer fallback" },
          credentialRef: "agentpush",
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toEqual([
      {
        name: "push",
        transport: "http",
        ref: "http://push/mcp",
        headers: { Authorization: "Bearer fallback" },
        credentialRef: "agentpush",
      },
    ])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("credentialRef resolution failed for \"push\""),
    )
    warn.mockRestore()
  })

  it("passes mcpServers through unchanged when no hook is set", async () => {
    const { captured, startSession } = captureStartSession()
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      mcpServers: [
        {
          name: "push",
          transport: "http",
          ref: "http://push/mcp",
          headers: { Authorization: "Bearer static" },
          credentialRef: "agentpush",
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toEqual([
      {
        name: "push",
        transport: "http",
        ref: "http://push/mcp",
        headers: { Authorization: "Bearer static" },
        credentialRef: "agentpush",
      },
    ])
  })
})

describe("cleanAgentLines", () => {
  it("strips ANSI + decorative framing and non-error tool chatter", () => {
    const out = cleanAgentLines([
      "\x1b[36m[tool] file_write(a.ts)\x1b[0m",
      "\x1b[2m[tool-result] ok\x1b[0m",
      "── framing ──",
      "[thought] hmm",
      "\x1b[32mreal assistant text\x1b[0m",
    ])
    expect(out).toEqual(["real assistant text"])
  })

  it("NEVER drops a tool error — a failing turn must stay visible", () => {
    const out = cleanAgentLines([
      "\x1b[36m[tool] run_tests()\x1b[0m",
      "\x1b[31m[tool-error] exit 1: build failed\x1b[0m",
    ])
    expect(out).toEqual(["[tool-error] exit 1: build failed"])
  })
})

/** The default declared-option set for these fixtures. Annotated (not
 *  inferred) so the `type` field narrows to the manifest union rather than
 *  widening to `string`, which `tsc` rejects against
 *  `readonly DeclaredAdapterOption[]` even though vitest transpiles it fine. */
const DECLARES_BASE_URL: ReadonlyArray<{ id: string; type: "string" }> = [
  { id: "base_url", type: "string" },
]

// ── shared billing-auth test helper (module scope) ────────────────────
// Hoisted out of the `billing-auth resolution wiring` describe so the D1,
// D4 and D2/D3 blocks below can all reuse it. It previously lived INSIDE
// that describe, which made every reference from a sibling describe a
// runtime ReferenceError (`makeAuthResolver is not defined`) — invisible
// to a `-t` filtered run that never reached those blocks.
type CapturedAuth = {
  mode: "subscription" | "api-key"
  credential?: string
  setEnv: string
  unsetEnv: string[]
  explicit: boolean
  enforce: "always" | "when-configured"
}

type CapturedStartSession = {
  auth?: CapturedAuth
  options?: Record<string, boolean | number | string>
}

function makeAuthResolver(
  descriptor: AdapterAuthDescriptor | undefined,
  opts: {
    defaultModel?: string
    // Default: declares `base_url` — every pre-existing test in this
    // block exercises gateway-preset billing wiring on a hypothetical
    // adapter that DOES accept it. D1's declared-option gate (see
    // session-spawn.ts) is exercised by tests that explicitly override
    // this to `[]`/omit base_url.
    declaredOptions?: Array<{ id: string; type: "string" | "boolean" | "integer" | "enum" }>
    routeSelection?: "free" | "derived-from-model"
  } = {},
): { resolver: AgentAdapterResolver; captured: CapturedStartSession[] } {
  const captured: CapturedStartSession[] = []
  const resolver: AgentAdapterResolver = async () => ({
    startSession: vi.fn(async (o: { auth?: CapturedAuth; options?: Record<string, boolean | number | string> }) => {
      captured.push({ auth: o.auth, options: o.options })
      return fakeAgentSession()
    }),
    commandPreview: "mock-adapter",
    declaredOptions: opts.declaredOptions ?? [{ id: "base_url", type: "string" }],
    ...(descriptor ? { authDescriptor: descriptor } : {}),
    ...(opts.defaultModel ? { defaultModel: opts.defaultModel } : {}),
    ...(opts.routeSelection ? { routeSelection: opts.routeSelection } : {}),
  })
  return { resolver, captured }
}

describe("spawnAgentSession — billing-auth resolution wiring", () => {
  beforeEach(() => {
    storeKeys.value = {}
  })


  const CODEX_DESC = { provider: "openai" as const }
  const CLAUDE_CODE_DESC = {
    provider: "anthropic" as const,
    authEnforce: "always" as const,
    authSubscription: {
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
      unsetEnvAdd: ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BASE_URL"],
    },
  }

  it("subscription requested on codex (no authSubscription) ⇒ unsupported_auth_mode, no session", async () => {
    const { resolver } = makeAuthResolver(CODEX_DESC)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "codex", cwd: "/tmp", auth: { mode: "subscription" } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("unsupported_auth_mode")
    expect(registry.list()).toHaveLength(0)
  })

  it("unconfigured codex (when-configured) passes an INERT spec — explicit:false, enforce:when-configured (ambient)", async () => {
    const { resolver, captured } = makeAuthResolver(CODEX_DESC)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "codex", cwd: "/tmp" },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth?.explicit).toBe(false)
    expect(captured[0]?.auth?.enforce).toBe("when-configured")
    expect(captured[0]?.auth?.credential).toBeUndefined()
    // No credential ⇒ nothing recorded on the descriptor.
    expect(registry.list()[0]?.auth).toBeUndefined()
  })

  it("configured api-key (explicit key) ⇒ spec carries the credential + records the echo on the descriptor", async () => {
    const { resolver, captured } = makeAuthResolver(CODEX_DESC)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "codex", cwd: "/tmp", auth: { mode: "api-key", apiKey: "sk-proj-explicit1234" } },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth).toMatchObject({
      mode: "api-key",
      setEnv: "OPENAI_API_KEY",
      credential: "sk-proj-explicit1234",
      explicit: true,
    })
    expect(registry.list()[0]?.auth).toMatchObject({
      mode: "api-key",
      provider: "openai",
      credentialSource: "explicit-config",
      setEnv: "OPENAI_API_KEY",
      fingerprint: "api-key · sk-proj-…1234",
    })
  })

  it("api-key credential sourced from providers.json when no explicit key configured", async () => {
    storeKeys.value = { openai: "sk-proj-fromstore9999" }
    const { resolver, captured } = makeAuthResolver(CODEX_DESC)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "codex", cwd: "/tmp", auth: { mode: "api-key" } },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth?.credential).toBe("sk-proj-fromstore9999")
    expect(registry.list()[0]?.auth).toMatchObject({ credentialSource: "providers-store" })
  })

  it("model→provider: a by-model adapter with model=claude-sonnet-5 + api-key resolves ANTHROPIC_API_KEY from the store", async () => {
    storeKeys.value = { anthropic: "sk-ant-api03-store1234" }
    const { resolver, captured } = makeAuthResolver({}) // no fixed provider
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "opencode", cwd: "/tmp", model: "claude-sonnet-5", auth: { mode: "api-key" } },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth?.setEnv).toBe("ANTHROPIC_API_KEY")
    expect(captured[0]?.auth?.credential).toBe("sk-ant-api03-store1234")
    expect(registry.list()[0]?.auth?.provider).toBe("anthropic")
  })

  it("unconfigured claude-code (enforce:always) passes an ENGAGED-but-credentialless spec (⇒ driver fail-fast)", async () => {
    const { resolver, captured } = makeAuthResolver(CLAUDE_CODE_DESC)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "claude-code", cwd: "/tmp" },
    )
    expect(result.ok).toBe(true) // the stub doesn't run the real driver
    expect(captured[0]?.auth).toMatchObject({
      mode: "subscription",
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      enforce: "always",
      explicit: false,
    })
    expect(captured[0]?.auth?.credential).toBeUndefined()
  })

  it("MONEY REGRESSION: unconfigured claude-code (explicit=false) must NOT pull a providers.json anthropic key — it fail-fasts in subscription mode, never silently bills org api credits", async () => {
    // The operator previously ran `agentproto auth provider set anthropic …`
    // but configured NO adapter auth for this spawn. #312 fail-fasted here;
    // the store key must NOT be consulted (that would flip ordered-mode to
    // api-key and silently bill org credits — the leak this feature prevents).
    storeKeys.value = { anthropic: "sk-ant-api03-ORG-CREDIT-KEY" }
    const { resolver, captured } = makeAuthResolver(CLAUDE_CODE_DESC)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "claude-code", cwd: "/tmp" },
    )
    expect(result.ok).toBe(true) // the stub doesn't run the real driver
    // Fail-fast shape: subscription default, NO credential ⇒ the driver
    // (enforce="always") throws missing_auth_credential. Crucially NOT api-key.
    expect(captured[0]?.auth?.mode).toBe("subscription")
    expect(captured[0]?.auth?.setEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN")
    expect(captured[0]?.auth?.credential).toBeUndefined()
    // The org api key must never become the credential nor the set env.
    expect(captured[0]?.auth?.setEnv).not.toBe("ANTHROPIC_API_KEY")
    expect(captured[0]?.auth?.credential).not.toBe("sk-ant-api03-ORG-CREDIT-KEY")
  })

  it("an adapter with NO authDescriptor gets NO auth spec (backward compat)", async () => {
    const { resolver, captured } = makeAuthResolver(undefined)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "legacy", cwd: "/tmp", auth: { mode: "api-key", apiKey: "sk-x" } },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth).toBeUndefined()
  })

  it("route.gateway = moonshot resolves the gateway preset: MOONSHOT_API_KEY + base_url injected into options", async () => {
    storeKeys.value = { moonshot: "mk-fromstore-9999" }
    const { resolver, captured } = makeAuthResolver({ modelDerivedApiKey: true })
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "opencode",
        cwd: "/tmp",
        model: "claude-sonnet-5",
        route: { gateway: "moonshot" },
        auth: { mode: "api-key" },
      },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth).toMatchObject({
      mode: "api-key",
      setEnv: "MOONSHOT_API_KEY",
      credential: "mk-fromstore-9999",
    })
    expect(captured[0]?.auth?.unsetEnv).toContain("ANTHROPIC_API_KEY")
    expect(captured[0]?.options?.base_url).toBe("https://api.moonshot.ai/anthropic")
    expect(registry.list()[0]?.auth?.provider).toBe("moonshot")
    expect(registry.list()[0]?.auth?.credentialSource).toBe("providers-store")
  })

  it("route.gateway = moonshot with explicit apiKey uses the explicit credential", async () => {
    const { resolver, captured } = makeAuthResolver({ modelDerivedApiKey: true })
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "opencode",
        cwd: "/tmp",
        model: "claude-sonnet-5",
        route: { gateway: "moonshot" },
        auth: { mode: "api-key", apiKey: "mk-explicit-1234" },
      },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth).toMatchObject({
      mode: "api-key",
      setEnv: "MOONSHOT_API_KEY",
      credential: "mk-explicit-1234",
    })
    expect(captured[0]?.options?.base_url).toBe("https://api.moonshot.ai/anthropic")
    expect(registry.list()[0]?.auth?.credentialSource).toBe("explicit-config")
  })

  it("route.gateway rejects subscription mode (gateways are api-key only)", async () => {
    const { resolver } = makeAuthResolver(CLAUDE_CODE_DESC)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "claude-code",
        cwd: "/tmp",
        route: { gateway: "moonshot" },
        auth: { mode: "subscription" },
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("unsupported_auth_mode")
    expect(registry.list()).toHaveLength(0)
  })

  it("an explicit options.base_url still skips auth resolution (backward compat)", async () => {
    const { resolver, captured } = makeAuthResolver(CLAUDE_CODE_DESC)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "claude-code",
        cwd: "/tmp",
        route: { gateway: "moonshot" },
        options: { base_url: "https://custom.example.com/anthropic" },
      },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth).toBeUndefined()
    expect(captured[0]?.options?.base_url).toBe("https://custom.example.com/anthropic")
  })
})

// ── D1 — base_url must never be injected into an adapter that doesn't
// declare it. Root cause: session-spawn.ts used to spread a gateway
// preset's resolved base_url into `options` unconditionally, so an adapter
// with no `base_url` option (hermes) crashed manifest validation
// (`unknown_option`) on a spawn it would otherwise have served fine (hermes
// reads OPENROUTER_API_KEY itself and derives its route from the model
// prefix — the gateway baseUrl is unusable AND unnecessary for it). Fixed
// behavior has two branches, both required: (a) a `derived-from-model`
// adapter silently skips the injection (it carries its own gateway); (b) an
// adapter that can neither accept base_url nor derive its route fails loud
// instead of spawning mis-routed. ─────────────────────────────────────────
describe("spawnAgentSession — D1: base_url only injected when the adapter declares it", () => {
  beforeEach(() => {
    storeKeys.value = { openrouter: "sk-or-v1-test0000" }
  })

  it("(a) hermes-like (derived-from-model, no base_url option): spawns fine, base_url is NOT injected", async () => {
    const { resolver, captured } = makeAuthResolver(
      { modelDerivedApiKey: true },
      { declaredOptions: [{ id: "skills", type: "string" }], routeSelection: "derived-from-model" },
    )
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "hermes",
        cwd: "/tmp",
        model: "z-ai/glm-5.2",
        route: { gateway: "openrouter" },
        auth: { mode: "api-key" },
      },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.options?.base_url).toBeUndefined()
  })

  it("(b) a hypothetical adapter that can neither accept base_url nor derive its route: fails loud, never spawns", async () => {
    const { resolver, startSession } = (() => {
      const { resolver, captured } = makeAuthResolver(
        { modelDerivedApiKey: true },
        { declaredOptions: [{ id: "skills", type: "string" }] }, // no base_url, routeSelection left "free"
      )
      return { resolver, startSession: captured }
    })()
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "no-gateway-adapter",
        cwd: "/tmp",
        model: "z-ai/glm-5.2",
        route: { gateway: "openrouter" },
        auth: { mode: "api-key" },
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("gateway_base_url_unsupported")
    expect(result.message).toContain("no-gateway-adapter")
    expect(result.message).toContain("openrouter")
    expect(registry.list()).toHaveLength(0)
    expect(startSession).toHaveLength(0) // never called (captured stays empty)
  })

  it("codex + route.gateway = openai (native provider match) spawns without base_url injection", async () => {
    const { resolver, captured } = makeAuthResolver(
      { provider: "openai" },
      { declaredOptions: [{ id: "model", type: "enum" }] },
    )
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "codex",
        cwd: "/tmp",
        model: "gpt-5-codex",
        route: { gateway: "openai" },
        auth: { mode: "api-key", apiKey: "sk-proj-codex1234" },
      },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.options?.base_url).toBeUndefined()
    expect(captured[0]?.auth).toMatchObject({
      mode: "api-key",
      setEnv: "OPENAI_API_KEY",
      credential: "sk-proj-codex1234",
    })
    expect(registry.list()[0]?.auth).toMatchObject({ provider: "openai" })
  })

  it("codex + route.gateway = openai-direct (non-native preset) still rejects", async () => {
    const { resolver, captured } = makeAuthResolver(
      { provider: "openai" },
      { declaredOptions: [{ id: "model", type: "enum" }] },
    )
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "codex",
        cwd: "/tmp",
        model: "gpt-5-codex",
        route: { gateway: "openai-direct" },
        auth: { mode: "api-key", apiKey: "sk-proj-codex1234" },
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("gateway_base_url_unsupported")
    expect(result.message).toContain("codex")
    expect(result.message).toContain("openai-direct")
    expect(captured).toHaveLength(0)
  })

  it("codex + a custom route baseUrl still rejects", async () => {
    const { resolver, captured } = makeAuthResolver(
      { provider: "openai" },
      { declaredOptions: [{ id: "model", type: "enum" }] },
    )
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "codex",
        cwd: "/tmp",
        model: "gpt-5-codex",
        route: { gateway: "custom-openai", baseUrl: "https://api.openai.com/v1" },
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("gateway_base_url_unsupported")
    expect(result.message).toContain("codex")
    expect(captured).toHaveLength(0)
  })

  it("an adapter that DOES declare base_url still gets it injected (unchanged)", async () => {
    const { resolver, captured } = makeAuthResolver({ modelDerivedApiKey: true }) // default: declares base_url
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "opencode",
        cwd: "/tmp",
        model: "z-ai/glm-5.2",
        route: { gateway: "openrouter" },
        auth: { mode: "api-key" },
      },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.options?.base_url).toBe("https://openrouter.ai/api")
  })
})

// ── D4 — a gateway credential must land in the env var the ADAPTER actually
// reads a bearer from, not the preset's conventional `keyEnv` (that's the
// OPERATOR'S providers-store lookup key, a different fact). claude-sdk /
// claude-code declare `gatewayAuth.setEnv: "ANTHROPIC_AUTH_TOKEN"`
// (D4-declaration-mechanism); an adapter with no such declaration (hermes)
// keeps the preset's own keyEnv — proving the fix is adapter-driven, not a
// blanket rename. ───────────────────────────────────────────────────────
describe("spawnAgentSession — D4: gateway credential lands in the adapter-declared env var", () => {
  beforeEach(() => {
    storeKeys.value = { openrouter: "sk-or-v1-test0000" }
  })

  const CLAUDE_SDK_DESC: AdapterAuthDescriptor = {
    provider: "anthropic",
    authSubscription: {
      setEnv: "ANTHROPIC_AUTH_TOKEN",
      conflictEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
    },
    gatewayAuth: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
  }

  it("claude-sdk + openrouter gateway resolves setEnv: ANTHROPIC_AUTH_TOKEN (not OPENROUTER_API_KEY), base_url set, ANTHROPIC_API_KEY still scrubbed", async () => {
    const { resolver, captured } = makeAuthResolver(CLAUDE_SDK_DESC)
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "claude-sdk",
        cwd: "/tmp",
        model: "x-ai/grok-4.5",
        route: { gateway: "openrouter" },
        auth: { mode: "api-key" },
      },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth).toMatchObject({
      mode: "api-key",
      setEnv: "ANTHROPIC_AUTH_TOKEN",
      credential: "sk-or-v1-test0000",
    })
    expect(captured[0]?.auth?.setEnv).not.toBe("OPENROUTER_API_KEY")
    expect(captured[0]?.auth?.unsetEnv).toContain("ANTHROPIC_API_KEY")
    expect(captured[0]?.options?.base_url).toBe("https://openrouter.ai/api")
  })

  it("hermes + openrouter gateway KEEPS OPENROUTER_API_KEY (no gatewayAuth declared) — proves the fix is adapter-driven, not a blanket rename", async () => {
    const { resolver, captured } = makeAuthResolver(
      { provider: "openrouter" }, // hermes-like: fixed provider, NO gatewayAuth
      { declaredOptions: [{ id: "skills", type: "string" }], routeSelection: "derived-from-model" },
    )
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "hermes",
        cwd: "/tmp",
        model: "x-ai/grok-4.5",
        route: { gateway: "openrouter" },
        auth: { mode: "api-key" },
      },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth).toMatchObject({
      mode: "api-key",
      setEnv: "OPENROUTER_API_KEY",
      credential: "sk-or-v1-test0000",
    })
  })
})

// ── worktree isolation (agent_start.worktree + worktrees.isolation) ─────────
// Drives the side-effecting half through a STUB provisioner, so these stay
// git-free: they assert WHICH decision `spawnAgentSession` reached and WHERE
// the session ended up landing, not that git actually forked a tree. The pure
// decision matrix + config resolution is covered in worktree-isolation.test.ts.

/** A spy provisioner recording every request and returning `outcome` (or, for
 *  the failure case, throwing). */
function spyProvisioner(
  outcome: WorktreeProvisionOutcome | (() => Promise<never>),
): { provisionWorktree: WorktreeProvisioner; calls: Parameters<WorktreeProvisioner>[0][] } {
  const calls: Parameters<WorktreeProvisioner>[0][] = []
  const provisionWorktree: WorktreeProvisioner = vi.fn(async (req) => {
    calls.push(req)
    if (typeof outcome === "function") return outcome()
    return outcome
  })
  return { provisionWorktree, calls }
}

const pinMode =
  (mode: WorktreeIsolationMode): (() => Promise<WorktreeIsolationMode>) =>
  async () =>
    mode

describe("spawnAgentSession — worktree isolation", () => {
  const ORIGINAL = "/repo/checkout"
  const WORKTREE = "/root/repo/agent-abcd1234"
  const isolated: WorktreeProvisionOutcome = {
    isolated: true,
    cwd: WORKTREE,
    branch: "wt/agent-abcd1234",
  }

  it("on-request + worktree:true → provisions and lands the session in the worktree", async () => {
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: true, label: "fix login" },
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ cwd: ORIGINAL, labelHint: "fix login" })
    expect(registry.list()[0]?.cwd).toBe(WORKTREE)
  })

  it("on-request + no field → never touches the provisioner, spawns in place", async () => {
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL },
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(0)
    expect(registry.list()[0]?.cwd).toBe(ORIGINAL)
  })

  it("always → provisions even with no field", async () => {
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("always") },
      { adapter: "mock", cwd: ORIGINAL },
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(registry.list()[0]?.cwd).toBe(WORKTREE)
  })

  it("always + a cwd that is not in a git repo → spawns plain at the original cwd", async () => {
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner({
      isolated: false,
      reason: "not-a-git-repo",
    })
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("always") },
      { adapter: "mock", cwd: ORIGINAL },
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1) // the provisioner ran and reported "nothing to isolate"
    expect(registry.list()[0]?.cwd).toBe(ORIGINAL)
  })

  it("never + explicit worktree → rejects loud, spawns nothing", async () => {
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("never") },
      { adapter: "mock", cwd: ORIGINAL, worktree: true },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("worktree_disabled")
    expect(calls).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })

  it("nested spawn (depth > 0) inherits the parent's ground — no second worktree even under always", async () => {
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const activeCwd = "/repo/active-workspace"
    const parentCwd = ORIGINAL
    const previousConfig = wsConfigState.value
    wsConfigState.value = {
      version: 1,
      active: "active",
      workspaces: [
        {
          slug: "parent",
          path: parentCwd,
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          slug: "active",
          path: activeCwd,
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const callerScope: OrchestratorScope = {
      token: "tok",
      tools: new Set(["agent_start"]),
      ownerSessionId: "parent",
      depth: 0,
      maxDepth: 3,
      maxChildren: 8,
      role: "supervisor",
    }
    try {
      const parent = await spawnAgentSession(deps, { adapter: "mock", cwd: parentCwd })
      expect(parent.ok).toBe(true)
      if (!parent.ok) throw new Error("expected success")
      callerScope.ownerSessionId = parent.descriptor.id

      const result = await spawnAgentSession(
        { ...deps, callerScope, provisionWorktree, resolveWorktreeIsolation: pinMode("always") },
        { adapter: "mock" },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected success")
      expect(calls).toHaveLength(0)
      expect(result.descriptor.cwd).toBe(parentCwd)
      expect(result.descriptor.cwd).not.toBe(activeCwd)
      expect(registry.get(result.descriptor.id)?.cwd).toBe(parentCwd)
      expect(registry.list()[0]?.cwd).toBe(parentCwd)
    } finally {
      wsConfigState.value = previousConfig
    }
  })

  it("nested spawn with an EXPLICIT worktree request → rejects loud, spawns nothing", async () => {
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const callerScope: OrchestratorScope = {
      token: "tok",
      tools: new Set(["agent_start"]),
      ownerSessionId: "parent",
      depth: 0,
      maxDepth: 3,
      maxChildren: 8,
      role: "supervisor",
    }
    const parent = await spawnAgentSession(deps, { adapter: "mock", cwd: ORIGINAL })
    expect(parent.ok).toBe(true)
    if (!parent.ok) throw new Error("expected success")
    callerScope.ownerSessionId = parent.descriptor.id

    // childDepth = 1 here; an explicit `worktree: true` asked for isolation the
    // nested spawn can't provision, so it must fail loud rather than silently
    // running in the shared (parent's) checkout.
    const result = await spawnAgentSession(
      { ...deps, callerScope, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: true },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("worktree_disabled")
    expect(result.message).toContain("nested")
    expect(result.message).toContain("sandbox")
    expect(calls).toHaveLength(0)
    // Only the parent booted; the rejected child spawned nothing.
    expect(registry.list()).toHaveLength(1)
  })

  it("provision required but no provisioner wired → worktree_provisioner_not_enabled", async () => {
    const { registry, deps } = baseDeps()
    const result = await spawnAgentSession(
      { ...deps, resolveWorktreeIsolation: pinMode("always") },
      { adapter: "mock", cwd: ORIGINAL },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("worktree_provisioner_not_enabled")
    expect(registry.list()).toHaveLength(0)
  })

  it("a throwing provisioner → worktree_provision_failed, no session", async () => {
    const { registry, deps } = baseDeps()
    const { provisionWorktree } = spyProvisioner(async () => {
      throw new Error("git worktree add exploded")
    })
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: true },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("worktree_provision_failed")
    expect(result.message).toContain("git worktree add exploded")
    expect(registry.list()).toHaveLength(0)
  })

  it("forwards an explicit slug + base to the provisioner", async () => {
    const { deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      {
        adapter: "mock",
        cwd: ORIGINAL,
        worktree: { slug: "my-slug", base: "origin/dev" },
      },
    )
    expect(result.ok).toBe(true)
    expect(calls[0]).toMatchObject({ slug: "my-slug", base: "origin/dev" })
  })

  it("an idempotent retry provisions exactly once (dedup happens on the original cwd)", async () => {
    const { deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const shared = {
      ...deps,
      provisionWorktree,
      resolveWorktreeIsolation: pinMode("on-request"),
    }
    const input = {
      adapter: "mock",
      cwd: ORIGINAL,
      worktree: true as const,
      idempotencyKey: "same-spawn",
    }
    const first = await spawnAgentSession(shared, input)
    const second = await spawnAgentSession(shared, input)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.deduped).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it("is skipped entirely for a sandbox spawn (the box already isolates)", async () => {
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    // No `resolveSandboxProvider` wired ⇒ the sandbox branch fails — but the
    // point is the worktree provisioner was NEVER consulted despite `always`.
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("always") },
      { adapter: "mock", cwd: ORIGINAL, sandbox: "local" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("sandbox_provider_not_found")
    expect(calls).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })
})

// ── async worktree provisioning (WP-F) ──────────────────────────────────
// `worktree.async` returns a real, registered session before `git worktree
// add` + the setup hooks finish, provisioning in the background — the fix
// for the actual root cause #803/#805 mitigated from the retry side (no
// session id existed yet for a retry to dedupe against). These drive a
// CONTROLLABLE (deferred) provisioner so the test can observe the window
// between "session registered" and "provisioning settles".
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function deferredProvisioner(): {
  provisionWorktree: WorktreeProvisioner
  calls: Parameters<WorktreeProvisioner>[0][]
  resolve: (outcome: WorktreeProvisionOutcome) => void
  reject: (err: unknown) => void
} {
  const calls: Parameters<WorktreeProvisioner>[0][] = []
  const d = deferred<WorktreeProvisionOutcome>()
  const provisionWorktree: WorktreeProvisioner = vi.fn(async req => {
    calls.push(req)
    return d.promise
  })
  return { provisionWorktree, calls, resolve: d.resolve, reject: d.reject }
}

describe("spawnAgentSession — async worktree provisioning (WP-F)", () => {
  const ORIGINAL = "/repo/checkout"
  const WORKTREE = "/root/repo/agent-abcd1234"
  const isolated: WorktreeProvisionOutcome = {
    isolated: true,
    cwd: WORKTREE,
    branch: "wt/agent-abcd1234",
  }

  it("returns a registered, starting session BEFORE the provisioner settles, then flips to running once it does", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      routeSelection: "derived-from-model",
      authDescriptor: { provider: "openrouter" },
    })
    const { registry, deps } = baseDeps({ resolveAgentAdapter })
    const { provisionWorktree, calls, resolve } = deferredProvisioner()

    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: { async: true }, label: "fix login" },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    // The provisioner was invoked (the background task started)…
    expect(calls).toHaveLength(1)
    // …but `agent_start` did not wait for it.
    expect(startSession).not.toHaveBeenCalled()
    expect(result.descriptor.status).toBe("starting")
    expect(registry.get(result.descriptor.id)).toMatchObject({
      status: "starting",
      routeSelection: "derived-from-model",
      adapterProvider: "openrouter",
    })

    resolve(isolated)
    await vi.waitFor(() => {
      expect(registry.get(result.descriptor.id)?.status).toBe("running")
    })
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.get(result.descriptor.id)?.cwd).toBe(WORKTREE)
  })

  it("a provisioning failure ends the session in status \"error\" with a readable lastError — never stuck in \"starting\"", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const { provisionWorktree, reject } = deferredProvisioner()

    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: { async: true } },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(registry.get(result.descriptor.id)?.status).toBe("starting")

    reject(new Error("git worktree add: branch already exists"))
    await vi.waitFor(() => {
      expect(registry.get(result.descriptor.id)?.status).toBe("error")
    })
    expect(registry.get(result.descriptor.id)?.lastError).toContain(
      "branch already exists",
    )
    expect(startSession).not.toHaveBeenCalled()
  })

  it("a driver spawn failure AFTER provisioning succeeds also ends in status \"error\"", async () => {
    const startSession = vi.fn().mockRejectedValueOnce(new Error("adapter boot failed"))
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const { provisionWorktree } = spyProvisioner(isolated)

    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: { async: true } },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")

    await vi.waitFor(() => {
      expect(registry.get(result.descriptor.id)?.status).toBe("error")
    })
    expect(registry.get(result.descriptor.id)?.lastError).toContain("adapter boot failed")
  })

  it("`worktree.async` + `wait` is rejected outright — no session created", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const { provisionWorktree, calls } = spyProvisioner(isolated)

    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: { async: true }, wait: true, prompt: "hi" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("worktree_async_wait_conflict")
    expect(calls).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })

  it("the initial prompt is held until the tree + driver session exist, never dispatched into an unbuilt tree", async () => {
    let promptedAt: "before" | "after" | undefined
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const { provisionWorktree, resolve } = deferredProvisioner()

    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: { async: true }, prompt: "do the thing" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    // No turn dispatched yet — the descriptor carries no adapterSessionId
    // (only set once `startSession` has actually run) and is still busy-free.
    expect(registry.get(result.descriptor.id)?.adapterSessionId).toBeUndefined()
    promptedAt = "before"

    resolve(isolated)
    await vi.waitFor(() => {
      expect(registry.get(result.descriptor.id)?.status).toBe("running")
    })
    expect(startSession).toHaveBeenCalledTimes(1)
    promptedAt = "after"
    expect(promptedAt).toBe("after")
  })

  // ── the regression this PR exists to prevent ──────────────────────────
  // A retry arriving WHILE the background worktree provisioning is still in
  // flight must dedupe against the already-registered session, not fork a
  // second `git worktree add` (the exact incident #803/#805 mitigated from
  // the retry side — this treats the wait that provokes it instead).
  it("a retry arriving mid-provision dedupes against the SAME session instead of forking a second provision", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const { provisionWorktree, calls, resolve } = deferredProvisioner()
    const input = {
      adapter: "mock",
      cwd: ORIGINAL,
      worktree: { async: true },
      idempotencyKey: "req-async-retry",
    }
    const shared = { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") }

    const first = await spawnAgentSession(shared, input)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error("expected success")
    // Provisioning has started but not settled yet.
    expect(calls).toHaveLength(1)
    expect(registry.get(first.descriptor.id)?.status).toBe("starting")

    // The retry: same idempotencyKey, arriving while provisioning is still
    // in flight. Must dedupe immediately — NOT call the provisioner again,
    // NOT block on the in-flight provisioning.
    const second = await spawnAgentSession(shared, input)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error("expected success")
    expect(second.deduped).toBe(true)
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(calls).toHaveLength(1) // still exactly one provision attempt
    expect(registry.list()).toHaveLength(1) // still exactly one session

    // Let provisioning + the driver spawn actually finish.
    resolve(isolated)
    await vi.waitFor(() => {
      expect(registry.get(first.descriptor.id)?.status).toBe("running")
    })
    expect(startSession).toHaveBeenCalledTimes(1) // exactly one process, ever
    expect(registry.list()).toHaveLength(1)
  })

  it("a plain (synchronous) worktree spawn is completely unaffected by the async branch", async () => {
    // No `async: true` on the request ⇒ takes the pre-existing synchronous
    // path verbatim: `spawnAgentSession` still blocks on provisioning and
    // the descriptor is "running" (never "starting") by the time it returns.
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const { provisionWorktree, calls } = spyProvisioner(isolated)

    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: true },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.status).toBe("running")
    expect(calls).toHaveLength(1)
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(registry.get(result.descriptor.id)?.cwd).toBe(WORKTREE)
  })
})

// ── nested implicit-in-place into a shared, DIRTY cwd (loud, not silent) ───
// #622 closed the EXPLICIT-request-at-depth hole (reject). This closes the
// remaining one: an implicit (no `worktree`) nested spawn silently ran in
// place in its inherited cwd, even when that cwd is a live, dirty, shared
// checkout. It still spawns (in-place is legitimate), but now surfaces a
// `warnings` entry — unless the caller acknowledges via `allowSharedCwd`.
// These drive the REAL git dirty-check (`isSharedDirtyCwd`), so each stands
// up a throwaway git repo on disk.
describe("spawnAgentSession — nested spawn into a shared dirty cwd warns", () => {
  const dirs: string[] = []
  function gitRepo(dirty: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "agentproto-sharedcwd-"))
    dirs.push(dir)
    execFileSync("git", ["init", "-q"], { cwd: dir })
    if (dirty) writeFileSync(join(dir, "dirty.txt"), "uncommitted work\n")
    return dir
  }
  const nestedScope = (): OrchestratorScope => ({
    token: "tok",
    tools: new Set(["agent_start"]),
    ownerSessionId: "parent",
    depth: 0, // childDepth = 1 ⇒ nested
    maxDepth: 3,
    maxChildren: 8,
    role: "supervisor",
  })

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("nested + dirty shared cwd + no worktree/sandbox → still spawns, WITH a warning", async () => {
    const { registry, deps } = baseDeps()
    const cwd = gitRepo(true)
    const result = await spawnAgentSession(
      { ...deps, callerScope: nestedScope() },
      { adapter: "mock", cwd },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(registry.list()[0]?.cwd).toBe(cwd) // spawned in place
    expect(result.warnings).toBeDefined()
    expect(result.warnings?.join("\n")).toContain("UNCOMMITTED")
    expect(result.warnings?.join("\n")).toContain("allowSharedCwd")
  })

  it("nested + dirty shared cwd + allowSharedCwd → spawns with NO warning (ack silences it)", async () => {
    const { deps } = baseDeps()
    const cwd = gitRepo(true)
    const result = await spawnAgentSession(
      { ...deps, callerScope: nestedScope() },
      { adapter: "mock", cwd, allowSharedCwd: true },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.warnings).toBeUndefined()
  })

  it("nested + CLEAN git cwd → no warning", async () => {
    const { deps } = baseDeps()
    const cwd = gitRepo(false)
    const result = await spawnAgentSession(
      { ...deps, callerScope: nestedScope() },
      { adapter: "mock", cwd },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.warnings).toBeUndefined()
  })

  it("ROOT (depth 0) spawn into a dirty cwd → no warning (behaviour unchanged)", async () => {
    const { deps } = baseDeps()
    const cwd = gitRepo(true)
    const result = await spawnAgentSession(deps, { adapter: "mock", cwd })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.warnings).toBeUndefined()
  })
})

// ── worktree explicit-repo guard (regression: agent_start with no cwd/
// workspaceSlug must never silently worktree whatever the daemon's active
// workspace happens to be) ───────────────────────────────────────────────
//
// Reproduces the production incident: `agent_start` (and `POST
// /sessions/agent`) called with `worktree: {...}` but NEITHER `cwd` NOR
// `workspaceSlug` — the daemon resolved `cwd` from its active workspace,
// which at that moment was an unrelated client repo, and cut a real
// worktree + branch there. The fix requires the caller to name the repo
// (`cwd` or `workspaceSlug`) whenever a worktree is actually going to be
// provisioned; the active-workspace fallback still resolves `cwd` for a
// PLAIN (non-worktree) spawn exactly as before.
describe("spawnAgentSession — worktree explicit-repo guard", () => {
  const ORIGINAL = "/repo/checkout"
  const isolated: WorktreeProvisionOutcome = {
    isolated: true,
    cwd: "/root/repo/agent-abcd1234",
    branch: "wt/agent-abcd1234",
  }

  beforeEach(() => {
    wsConfigState.value = { version: 1, workspaces: [] }
  })

  it("no cwd + no workspaceSlug + no registered workspace at all (ambiguous) → worktree_requires_explicit_repo, provisioner never touched", async () => {
    wsConfigState.value = { version: 1, workspaces: [] }
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", worktree: true },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("worktree_requires_explicit_repo")
    expect(calls).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })

  it("the incident: active workspace resolves to an unrelated repo, caller passed neither cwd nor workspaceSlug → REFUSES rather than cutting a worktree there", async () => {
    wsConfigState.value = {
      version: 1,
      active: "unrelated-client-repo",
      workspaces: [
        {
          slug: "unrelated-client-repo",
          path: "/Users/op/clients/choisir-service-public-app",
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", worktree: { slug: "my-feature", base: "origin/main" } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("worktree_requires_explicit_repo")
    // The whole point: the wrong repo's path must never even reach the
    // provisioner — no `git worktree add` was attempted against it.
    expect(calls).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })

  it("explicit cwd inside the intended repo → provisions from that repo, even with an unrelated active workspace configured", async () => {
    wsConfigState.value = {
      version: 1,
      active: "unrelated-client-repo",
      workspaces: [
        {
          slug: "unrelated-client-repo",
          path: "/Users/op/clients/choisir-service-public-app",
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", cwd: ORIGINAL, worktree: true },
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ cwd: ORIGINAL })
    expect(registry.list()[0]?.cwd).toBe(isolated.cwd)
  })

  it("explicit workspaceSlug → provisions from the resolved repo, even with a different active workspace configured", async () => {
    wsConfigState.value = {
      version: 1,
      active: "unrelated-client-repo",
      workspaces: [
        {
          slug: "unrelated-client-repo",
          path: "/Users/op/clients/choisir-service-public-app",
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          slug: "intended-repo",
          path: ORIGINAL,
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock", workspaceSlug: "intended-repo", worktree: true },
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ cwd: ORIGINAL })
    expect(registry.list()[0]?.cwd).toBe(isolated.cwd)
    expect(registry.list()[0]?.workspaceSlug).toBe("intended-repo")
  })

  it("linked worktree cwd resolves to the workspace of its base repo, not default", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-spawn-worktree-"))
    try {
      const baseRepo = join(root, "repo")
      const tree = join(root, "trees", "linked")
      const admin = join(baseRepo, ".git", "worktrees", "linked")
      mkdirSync(admin, { recursive: true })
      mkdirSync(tree, { recursive: true })
      writeFileSync(join(admin, "gitdir"), `${join(tree, ".git")}\n`)
      writeFileSync(join(admin, "commondir"), "../..\n")
      writeFileSync(join(tree, ".git"), `gitdir: ${admin}\n`)
      const cwd = join(tree, "packages", "runtime", "src")
      mkdirSync(cwd, { recursive: true })

      wsConfigState.value = {
        version: 1,
        workspaces: [
          {
            slug: "base-repo",
            path: baseRepo,
            addedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }
      const { registry, deps } = baseDeps()
      const result = await spawnAgentSession({ ...deps }, { adapter: "mock", cwd })

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected success")
      expect(result.descriptor.workspaceSlug).toBe("base-repo")
      expect(registry.list()[0]?.workspaceSlug).toBe("base-repo")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a plain (non-worktree) spawn still uses the active-workspace fallback unchanged", async () => {
    wsConfigState.value = {
      version: 1,
      active: "unrelated-client-repo",
      workspaces: [
        {
          slug: "unrelated-client-repo",
          path: "/Users/op/clients/choisir-service-public-app",
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const { registry, deps } = baseDeps()
    const { provisionWorktree, calls } = spyProvisioner(isolated)
    const result = await spawnAgentSession(
      { ...deps, provisionWorktree, resolveWorktreeIsolation: pinMode("on-request") },
      { adapter: "mock" },
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(0)
    expect(registry.list()[0]?.cwd).toBe("/Users/op/clients/choisir-service-public-app")
  })
})

// ── worktree cwd → base repo's workspace (regression: a session spawned
// with `cwd` pointing AT a linked git worktree used to fall through to the
// literal "default" bucket, because `findWorkspaceByPath` only matches
// registered workspace ROOTS and a worktree lives outside all of them).
// `resolveWorktreeIdentity` reads real on-disk git layout (no DI seam), so
// these build an actual linked-worktree fixture on tmpdir rather than
// mocking — mirrors `worktree-identity.test.ts`'s fixture.
describe("spawnAgentSession — worktree cwd resolves to its base repo's workspace", () => {
  let base: string

  beforeEach(() => {
    wsConfigState.value = { version: 1, workspaces: [] }
    base = mkdtempSync(join(tmpdir(), "session-spawn-worktree-test-"))
    mkdirSync(join(base, "repo", ".git"), { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  /** Same on-disk layout as `worktree-identity.test.ts`'s fixture: an admin
   *  dir under the main checkout's `.git/worktrees/<name>` carrying git's
   *  `gitdir` back-pointer and a `commondir` file, plus the linked tree
   *  itself. */
  function makeWorktree(name: string): string {
    const admin = join(base, "repo", ".git", "worktrees", name)
    const tree = join(base, "trees", name)
    mkdirSync(admin, { recursive: true })
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(admin, "gitdir"), `${join(tree, ".git")}\n`)
    writeFileSync(join(tree, ".git"), `gitdir: ${admin}\n`)
    writeFileSync(join(admin, "commondir"), "../..\n")
    return tree
  }

  it("cwd is a linked worktree of a registered workspace → resolves to that workspace's slug, not default", async () => {
    const repoRoot = join(base, "repo")
    const tree = makeWorktree("feature-a")
    wsConfigState.value = {
      version: 1,
      workspaces: [
        {
          slug: "the-base-repo",
          path: repoRoot,
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const { registry, deps } = baseDeps()

    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: tree })

    expect(result.ok).toBe(true)
    expect(registry.list()[0]?.workspaceSlug).toBe("the-base-repo")
  })

  it("cwd is a worktree whose base repo is NOT registered → still falls back to default", async () => {
    const tree = makeWorktree("feature-b")
    wsConfigState.value = { version: 1, workspaces: [] }
    const { registry, deps } = baseDeps()

    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: tree })

    expect(result.ok).toBe(true)
    expect(registry.list()[0]?.workspaceSlug).toBe("default")
  })

  it("cwd is a plain (non-worktree) directory → unaffected, still resolves via direct path match", async () => {
    const repoRoot = join(base, "repo")
    wsConfigState.value = {
      version: 1,
      workspaces: [
        {
          slug: "the-base-repo",
          path: repoRoot,
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const { registry, deps } = baseDeps()

    const result = await spawnAgentSession(deps, { adapter: "mock", cwd: repoRoot })

    expect(result.ok).toBe(true)
    expect(registry.list()[0]?.workspaceSlug).toBe("the-base-repo")
  })
})

// ── Mode 3: self-refreshing OAuth `auth.source` end-to-end through spawn ──────
// The claude-code-oauth recipe resolver is mocked (see top of file); these prove
// the impure caller wires it in — reads it fresh, echoes claude-code-oauth on
// the descriptor, honors precedence, and fails LOUD when it can't resolve.
describe("spawnAgentSession — auth.source self-refreshing subscription (Mode 3)", () => {
  const CLAUDE_LIKE_DESCRIPTOR: AdapterAuthDescriptor = {
    provider: "anthropic",
    authEnforce: "always",
    authSubscription: {
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    },
  }

  function authDeps() {
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: CLAUDE_LIKE_DESCRIPTOR,
    })
    return baseDeps({ resolveAgentAdapter })
  }

  beforeEach(() => {
    oauthState.impl = async () => "sk-ant-oat01-fresh-from-keychain"
  })

  it("resolves the token FRESH and stamps credentialSource:claude-code-oauth on the descriptor", async () => {
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      auth: { source: "claude-code-oauth" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.mode).toBe("subscription")
    expect(result.descriptor.auth?.credentialSource).toBe("claude-code-oauth")
    expect(result.descriptor.auth?.setEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN")
    // The fresh token's fingerprint is echoed — never the raw secret.
    expect(result.descriptor.auth?.fingerprint).toContain("sk-ant-oat")
    expect(JSON.stringify(result.descriptor)).not.toContain("fresh-from-keychain")
  })

  it("an explicit per-spawn token WINS over source — origin stays explicit-config, recipe never called", async () => {
    const spy = vi.fn(async () => "sk-ant-oat01-should-not-be-used")
    oauthState.impl = spy
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      auth: { token: "sk-ant-oat01-explicit", source: "claude-code-oauth" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.credentialSource).toBe("explicit-config")
    expect(spy).not.toHaveBeenCalled()
  })

  it("source set but the recipe can't resolve (not logged in) ⇒ loud spawn failure, no session", async () => {
    oauthState.impl = async () => {
      throw new Error("keychain item 'Claude Code-credentials' not found")
    }
    const { registry, deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      auth: { source: "claude-code-oauth" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("auth_source_unresolved")
    expect(result.message).toContain("claude-code-oauth")
    expect(registry.list()).toHaveLength(0)
  })

  it("an unknown source value ⇒ unsupported_auth_source, recipe never consulted", async () => {
    const spy = vi.fn(async () => "unused")
    oauthState.impl = spy
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      auth: { source: "some-bogus-source" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("unsupported_auth_source")
    expect(spy).not.toHaveBeenCalled()
  })

  it("no source ⇒ unchanged static-token behavior (Mode 2), recipe never consulted", async () => {
    const spy = vi.fn(async () => "unused")
    oauthState.impl = spy
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      auth: { token: "sk-ant-oat01-static" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.credentialSource).toBe("explicit-config")
    expect(spy).not.toHaveBeenCalled()
  })

  // Regression: spawning a modelDerivedApiKey adapter with NO `authSubscription`
  // (e.g. `pi`) using `auth.source: "codex"` — a value that IS real elsewhere
  // (the codex/gemini adapters' own file-based `authSubscription.external`
  // login) but names a file this adapter's own CLI never reads. Still fails
  // loud (DECISION 5 — unchanged), but the message must explain the file-based/
  // bearer-fetch mismatch instead of implying claude-code-oauth is the only
  // auth concept that exists.
  it("a file-based source (codex/gemini) on an adapter with no authSubscription.external ⇒ unsupported_auth_source with an actionable message", async () => {
    const { resolver, captured } = makeAuthResolver({ modelDerivedApiKey: true })
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "pi",
        cwd: "/tmp",
        model: "claude-sonnet-5",
        auth: { source: "codex" },
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("unsupported_auth_source")
    expect(result.message).toContain("file-based")
    expect(result.message).toContain("authSubscription.external")
    expect(captured).toHaveLength(0)
  })
})

describe("spawnAgentSession — access.profileRef (named auth profile)", () => {
  const CLAUDE_LIKE_DESCRIPTOR: AdapterAuthDescriptor = {
    provider: "anthropic",
    authEnforce: "always",
    authSubscription: {
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    },
  }

  function authDeps() {
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: CLAUDE_LIKE_DESCRIPTOR,
    })
    return baseDeps({ resolveAgentAdapter })
  }

  beforeEach(() => {
    authProfileState.profiles = {}
    authProfileState.keychain = {}
    oauthState.impl = async () => "sk-ant-oat01-fresh-from-keychain"
  })

  it("a source-backed profile resolves the credential FRESH via Mode 3 (reuses the same recipe resolver)", async () => {
    authProfileState.profiles["anthropic-sub"] = {
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: "claude-code-oauth",
      label: "Anthropic (self-refreshing)",
    }
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      access: { profileRef: "anthropic-sub" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.mode).toBe("subscription")
    expect(result.descriptor.auth?.credentialSource).toBe("claude-code-oauth")
    expect(result.descriptor.auth?.fingerprint).toContain("sk-ant-oat")
    expect(JSON.stringify(result.descriptor)).not.toContain("fresh-from-keychain")
    expect(result.descriptor.accessProfile).toMatchObject({
      profileRef: "anthropic-sub",
      label: "Anthropic (self-refreshing)",
      endpoint: "anthropic",
      method: "oauth-bearer",
    })
  })

  it("a credential-backed profile still does the static keychain read (regression, unchanged)", async () => {
    authProfileState.profiles["anthropic-sub"] = {
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credentialRef: "agentproto.auth.anthropic.sub",
    }
    authProfileState.keychain["agentproto.auth.anthropic.sub"] = "sk-ant-oat01-static-profile"
    const spy = vi.fn(async () => "should-not-be-called")
    oauthState.impl = spy
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      access: { profileRef: "anthropic-sub" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    // A static keychain read origin, unlike the source-backed
    // "claude-code-oauth" echo above — distinguishes the two paths.
    expect(result.descriptor.auth?.credentialSource).toBe("explicit-config")
    expect(spy).not.toHaveBeenCalled()
  })

  it("source configured but the recipe can't resolve (not logged in) ⇒ loud spawn failure, no session", async () => {
    authProfileState.profiles["anthropic-sub"] = {
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: "claude-code-oauth",
    }
    oauthState.impl = async () => {
      throw new Error("keychain item 'Claude Code-credentials' not found")
    }
    const { registry, deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      access: { profileRef: "anthropic-sub" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("auth_source_unresolved")
    expect(registry.list()).toHaveLength(0)
  })

  it("a profile with neither credentialRef nor source is rejected, no session spawned", async () => {
    authProfileState.profiles["broken"] = {
      id: "broken",
      endpoint: "anthropic",
      method: "oauth-bearer",
    }
    const { registry, deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: "/tmp",
      access: { profileRef: "broken" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("access_profile_ineligible")
    expect(registry.list()).toHaveLength(0)
  })
})

// "Use my existing Codex login" — a FILE-BASED (external) subscription. The
// codex adapter declares `authSubscription: { external: true }`: the CLI reads
// its own ~/.codex/auth.json, so the daemon injects NOTHING — it verifies the
// login is present (fail-loud) and echoes `cli-local-login`. Money-safety: the
// resolved spec never carries a bearer, so nothing can land in an api-key var.
describe("spawnAgentSession — codex file-based (external) subscription login", () => {
  const CODEX_EXTERNAL_DESCRIPTOR: AdapterAuthDescriptor = {
    provider: "openai",
    authSubscription: {
      external: true,
      conflictEnv: ["CODEX_API_KEY"],
    },
  }

  function authDeps() {
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: CODEX_EXTERNAL_DESCRIPTOR,
    })
    return baseDeps({ resolveAgentAdapter })
  }

  beforeEach(() => {
    authProfileState.profiles = {}
    authProfileState.keychain = {}
    oauthState.verifyImpl = async () => {}
  })

  it("config-defaults `auth.source: codex` + login present ⇒ subscription, cli-local-login, no bearer injected", async () => {
    const verify = vi.fn(async () => {})
    oauthState.verifyImpl = verify
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "codex",
      cwd: "/tmp",
      auth: { source: "codex" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.mode).toBe("subscription")
    expect(result.descriptor.auth?.credentialSource).toBe("cli-local-login")
    // No env var is SET — the CLI reads its own login file.
    expect(result.descriptor.auth?.setEnv).toBe("")
    expect(result.descriptor.auth?.fingerprint).toBe("subscription · local-login")
    // The login was verified against the `codex` recipe.
    expect(verify).toHaveBeenCalledWith("codex", "codex")
  })

  it("`auth.mode: subscription` with no source verifies against the adapter slug", async () => {
    const verify = vi.fn(async () => {})
    oauthState.verifyImpl = verify
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "codex",
      cwd: "/tmp",
      auth: { mode: "subscription" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.credentialSource).toBe("cli-local-login")
    expect(verify).toHaveBeenCalledWith("codex", "codex")
  })

  it("login NOT present ⇒ loud spawn failure (auth_source_unresolved), no session, nothing injected", async () => {
    oauthState.verifyImpl = async () => {
      throw new SubscriptionSourceError(
        "auth_source_unresolved",
        "no codex login found — run `codex login` and sign in with your subscription first.",
      )
    }
    const { registry, deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "codex",
      cwd: "/tmp",
      auth: { source: "codex" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("auth_source_unresolved")
    expect(result.message).toMatch(/no codex login found/)
    expect(registry.list()).toHaveLength(0)
  })

  it("a source-backed codex PROFILE (endpoint openai / oauth-bearer) resolves the external login", async () => {
    const verify = vi.fn(async () => {})
    oauthState.verifyImpl = verify
    authProfileState.profiles["codex-local"] = {
      id: "codex-local",
      endpoint: "openai",
      method: "oauth-bearer",
      source: "codex",
      label: "My Codex login",
    }
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "codex",
      cwd: "/tmp",
      access: { profileRef: "codex-local" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.mode).toBe("subscription")
    expect(result.descriptor.auth?.credentialSource).toBe("cli-local-login")
    expect(verify).toHaveBeenCalledWith("codex", "codex")
    expect(result.descriptor.accessProfile).toMatchObject({
      profileRef: "codex-local",
      endpoint: "openai",
      method: "oauth-bearer",
    })
  })

  it("codex subscription profile + route.gateway openai (native match) spawns without base_url injection", async () => {
    const verify = vi.fn(async () => {})
    oauthState.verifyImpl = verify
    authProfileState.profiles["codex-local"] = {
      id: "codex-local",
      endpoint: "openai",
      method: "oauth-bearer",
      source: "codex",
      label: "My Codex login",
    }
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "codex",
      cwd: "/tmp",
      model: "gpt-5-codex",
      route: { gateway: "openai" },
      access: { profileRef: "codex-local" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    // Native fixed-provider route is direct: subscription stays eligible and no
    // gateway base_url is injected.
    expect(result.descriptor.auth?.mode).toBe("subscription")
    expect(result.descriptor.auth?.credentialSource).toBe("cli-local-login")
    expect(result.descriptor.auth?.provider).toBe("openai")
    expect(result.descriptor.auth?.setEnv).toBe("")
  })

  it("an unconfigured codex spawn stays ambient — no external login verified, no auth echo engaged", async () => {
    const verify = vi.fn(async () => {})
    oauthState.verifyImpl = verify
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "codex",
      cwd: "/tmp",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    // Not explicit ⇒ the login is never verified and nothing is stamped as a
    // used local login (codex uses its own auth.json precedence).
    expect(verify).not.toHaveBeenCalled()
    expect(result.descriptor.auth?.credentialSource).not.toBe("cli-local-login")
  })
})

// "Use my existing Gemini login" — the SAME file-based (external) subscription
// primitive as codex, on the native `@agentproto/adapter-gemini` adapter. The
// Gemini CLI reads its own ~/.gemini/oauth_creds.json, so the daemon injects
// NOTHING — it verifies the login is present (fail-loud, via the `gemini`
// provision recipe) and echoes `cli-local-login`. Money-safety: the resolved
// spec never carries a bearer, so nothing can land in an api-key var.
describe("spawnAgentSession — gemini file-based (external) subscription login", () => {
  const GEMINI_EXTERNAL_DESCRIPTOR: AdapterAuthDescriptor = {
    provider: "google",
    authSubscription: {
      external: true,
      conflictEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    },
  }

  function authDeps() {
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
      authDescriptor: GEMINI_EXTERNAL_DESCRIPTOR,
    })
    return baseDeps({ resolveAgentAdapter })
  }

  beforeEach(() => {
    authProfileState.profiles = {}
    authProfileState.keychain = {}
    oauthState.verifyImpl = async () => {}
  })

  it("config-defaults `auth.source: gemini` + login present ⇒ subscription, cli-local-login, no bearer injected", async () => {
    const verify = vi.fn(async () => {})
    oauthState.verifyImpl = verify
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "gemini",
      cwd: "/tmp",
      auth: { source: "gemini" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.mode).toBe("subscription")
    expect(result.descriptor.auth?.credentialSource).toBe("cli-local-login")
    // No env var is SET — the CLI reads its own login file.
    expect(result.descriptor.auth?.setEnv).toBe("")
    expect(result.descriptor.auth?.fingerprint).toBe("subscription · local-login")
    // The login was verified against the `gemini` recipe.
    expect(verify).toHaveBeenCalledWith("gemini", "gemini")
  })

  it("`auth.mode: subscription` with no source verifies against the adapter slug", async () => {
    const verify = vi.fn(async () => {})
    oauthState.verifyImpl = verify
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "gemini",
      cwd: "/tmp",
      auth: { mode: "subscription" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.credentialSource).toBe("cli-local-login")
    expect(verify).toHaveBeenCalledWith("gemini", "gemini")
  })

  it("login NOT present ⇒ loud spawn failure (auth_source_unresolved), no session, nothing injected", async () => {
    oauthState.verifyImpl = async () => {
      throw new SubscriptionSourceError(
        "auth_source_unresolved",
        "no gemini login found — run `gemini login` and sign in with your subscription first.",
      )
    }
    const { registry, deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "gemini",
      cwd: "/tmp",
      auth: { source: "gemini" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.code).toBe("auth_source_unresolved")
    expect(result.message).toMatch(/no gemini login found/)
    expect(registry.list()).toHaveLength(0)
  })

  it("a source-backed gemini PROFILE (endpoint google / oauth-bearer) resolves the external login", async () => {
    const verify = vi.fn(async () => {})
    oauthState.verifyImpl = verify
    authProfileState.profiles["gemini-local"] = {
      id: "gemini-local",
      endpoint: "google",
      method: "oauth-bearer",
      source: "gemini",
      label: "My Gemini login",
    }
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "gemini",
      cwd: "/tmp",
      access: { profileRef: "gemini-local" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.auth?.mode).toBe("subscription")
    expect(result.descriptor.auth?.credentialSource).toBe("cli-local-login")
    expect(verify).toHaveBeenCalledWith("gemini", "gemini")
    expect(result.descriptor.accessProfile).toMatchObject({
      profileRef: "gemini-local",
      endpoint: "google",
      method: "oauth-bearer",
    })
  })

  it("an unconfigured gemini spawn stays ambient — no external login verified, no auth echo engaged", async () => {
    const verify = vi.fn(async () => {})
    oauthState.verifyImpl = verify
    const { deps } = authDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "gemini",
      cwd: "/tmp",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    // Not explicit ⇒ the login is never verified and nothing is stamped as a
    // used local login (gemini uses its own oauth_creds.json precedence).
    expect(verify).not.toHaveBeenCalled()
    expect(result.descriptor.auth?.credentialSource).not.toBe("cli-local-login")
  })
})

// ── D2/D3 — two halves of the same class of bug: the model id handed to an
// adapter must match the form THAT adapter's manifest declares, and a
// model-derived-api-key adapter's OWN declared provider must win over the
// GLOBAL catalog's routing for the same id. ─────────────────────────────
describe("spawnAgentSession — D2/D3: wire model form + adapter-declared provider", () => {
  beforeEach(() => {
    storeKeys.value = {
      openai: "sk-openai-test0000",
      openrouter: "sk-or-v1-test0000",
      moonshot: "sk-moonshot-test0000",
    }
  })

  type CapturedSpawn = {
    model?: string
    auth?: { setEnv: string }
  }

  function makeResolver(
    descriptor: AdapterAuthDescriptor,
    opts: { routeSelection?: "free" | "derived-from-model" } = {},
  ): { resolver: AgentAdapterResolver; captured: CapturedSpawn[] } {
    const captured: CapturedSpawn[] = []
    const resolver: AgentAdapterResolver = async () => ({
      startSession: vi.fn(async (o: { model?: string; auth?: { setEnv: string } }) => {
        captured.push({ model: o.model, auth: o.auth })
        return fakeAgentSession()
      }),
      commandPreview: "mock-adapter",
      declaredOptions: DECLARES_BASE_URL,
      authDescriptor: descriptor,
      ...(opts.routeSelection ? { routeSelection: opts.routeSelection } : {}),
    })
    return { resolver, captured }
  }

  it("D2: a fixed-provider adapter (codex/openai) gets a BARE wire model — the catalog's vendor prefix is stripped", async () => {
    const { resolver, captured } = makeResolver({ provider: "openai" })
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "codex", cwd: "/tmp", model: "openai/gpt-5", auth: { mode: "api-key" } },
    )
    expect(result.ok).toBe(true)
    // Was 'openai/gpt-5' before D2 — codex's manifest declares bare ids, so the
    // canonical catalog form tripped option_enum_violation at the driver.
    expect(captured[0]?.model).toBe("gpt-5")
  })

  it("D2: codex + native openai route strips the vendor prefix and does NOT inject base_url", async () => {
    const { resolver, captured } = makeResolver({ provider: "openai" })
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "codex",
        cwd: "/tmp",
        model: "openai/gpt-5-codex",
        route: { gateway: "openai" },
        auth: { mode: "api-key", apiKey: "sk-proj-codex1234" },
      },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.model).toBe("gpt-5-codex")
    // The openai preset's base_url is intentionally dropped for this native-
    // provider adapter; codex has no base_url option.
    expect(captured[0]?.auth?.setEnv).toBe("OPENAI_API_KEY")
  })

  it("D2: a derived-from-model adapter KEEPS its vendor prefix (the prefix IS its route)", async () => {
    const { resolver, captured } = makeResolver(
      { modelDerivedApiKey: true },
      { routeSelection: "derived-from-model" },
    )
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "hermes", cwd: "/tmp", model: "z-ai/glm-5.2@openrouter", auth: { mode: "api-key" } },
    )
    expect(result.ok).toBe(true)
    // Only the @route suffix goes; the vendor prefix is load-bearing here.
    expect(captured[0]?.model).toBe("z-ai/glm-5.2")
  })

  it("D3: the adapter's OWN declared provider wins over the catalog (pi bills kimi via moonshot, not openrouter)", async () => {
    const { resolver, captured } = makeResolver(
      {
        modelDerivedApiKey: true,
        modelProviders: { "moonshotai/kimi-k2.7-code": "moonshot" },
      },
      { routeSelection: "derived-from-model" },
    )
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "pi", cwd: "/tmp", model: "moonshotai/kimi-k2.7-code", auth: { mode: "api-key" } },
    )
    expect(result.ok).toBe(true)
    // The GLOBAL catalog routes this id to openrouter; pi bills it via
    // moonshot. Before D3 the resolver took the catalog's answer and injected
    // OPENROUTER_API_KEY — the wrong wallet — while the access-profile
    // eligibility check (already modelProviders-aware) cleared moonshot.
    expect(captured[0]?.auth?.setEnv).toBe("MOONSHOT_API_KEY")
  })

  it("D3: a model the adapter declares NO provider for still falls back to the catalog", async () => {
    const { resolver, captured } = makeResolver(
      {
        modelDerivedApiKey: true,
        modelProviders: { "moonshotai/kimi-k2.7-code": "moonshot" },
      },
      { routeSelection: "derived-from-model" },
    )
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "pi", cwd: "/tmp", model: "z-ai/glm-5.2@openrouter", auth: { mode: "api-key" } },
    )
    expect(result.ok).toBe(true)
    expect(captured[0]?.auth?.setEnv).toBe("OPENROUTER_API_KEY")
  })
})

describe("spawnAgentSession — model/route reconciliation", () => {
  function localResolver(descriptor?: AdapterAuthDescriptor): {
    resolver: AgentAdapterResolver
  } {
    const resolver: AgentAdapterResolver = async () => ({
      startSession: async () => fakeAgentSession(),
      commandPreview: "mock-adapter",
      ...(descriptor ? { authDescriptor: descriptor } : {}),
    })
    return { resolver }
  }

  it("synthesizes route.gateway from a model-only override with explicit @route", async () => {
    const { resolver } = localResolver()
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "mock", cwd: "/tmp", model: "z-ai/glm-5.2@openrouter" },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.model).toBe("z-ai/glm-5.2@openrouter")
      expect(result.descriptor.route).toEqual({ gateway: "openrouter" })
    }
  })

  it("throws when model and route overrides contradict each other", async () => {
    const { resolver } = localResolver()
    const { registry } = baseDeps()
    await expect(
      spawnAgentSession(
        { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
        {
          adapter: "mock",
          cwd: "/tmp",
          model: "z-ai/glm-5.2@openrouter",
          route: { gateway: "requesty" },
        },
      ),
    ).rejects.toThrow(/pins route "openrouter" but route override is "requesty"/)
  })

  it("keeps a parseable model + route pair that agree", async () => {
    const { resolver } = localResolver()
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      {
        adapter: "mock",
        cwd: "/tmp",
        model: "z-ai/glm-5.2@openrouter",
        route: { gateway: "openrouter" },
      },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.model).toBe("z-ai/glm-5.2@openrouter")
      expect(result.descriptor.route).toEqual({ gateway: "openrouter" })
    }
  })

  it("leaves a bare model + route pair untouched", async () => {
    const { resolver } = localResolver()
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "mock", cwd: "/tmp", model: "claude-opus-4-8", route: { gateway: "anthropic" } },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.model).toBe("claude-opus-4-8")
      expect(result.descriptor.route).toEqual({ gateway: "anthropic" })
    }
  })

  // Hermes false-positive fix: a by-model-router adapter (no fixed
  // `authDescriptor.provider` — hermes, pi, opencode) that spawns a model
  // with NO explicit `@route` suffix and NO caller-supplied `route` still
  // bills a real gateway (derived via `getModelProvider`, mirroring what
  // `resolveAuthSpec` independently resolves for the credential). Before
  // this fix the descriptor's `route` stayed empty, so the VS Code
  // change-model picker's `resolveEffectiveRoute(session.model,
  // session.route?.gateway)` fell back to treating the session as running
  // the model's bare/direct route and flagged a false "restart required"
  // the moment the operator picked another row on the SAME gateway.
  it("stamps the resolved gateway onto the descriptor for a by-model-router adapter with no explicit route", async () => {
    const { resolver } = localResolver({})
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "hermes", cwd: "/tmp", model: "deepseek/deepseek-v3.2" },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.model).toBe("deepseek/deepseek-v3.2")
      expect(result.descriptor.route).toEqual({ gateway: "openrouter" })
    }
  })

  it("does NOT stamp a route for a fixed-provider adapter's direct spawn (no regression)", async () => {
    const { resolver } = localResolver({ provider: "anthropic" })
    const { registry } = baseDeps()
    const result = await spawnAgentSession(
      { registry, resolveAgentAdapter: resolver, loadDefaultsConfig: async () => undefined },
      { adapter: "claude-code", cwd: "/tmp", model: "claude-opus-4-8" },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.route).toBeUndefined()
    }
  })
})

describe("spawnAgentSession — child→parent report-back plumbing", () => {
  function scopeWithOwner(ownerSessionId: string): OrchestratorScope {
    return {
      token: "tok",
      tools: new Set(["agent_start", "message_parent"]),
      ownerSessionId,
      depth: 0,
      maxDepth: 3,
      maxChildren: 8,
      role: "supervisor",
    }
  }

  function makeBuildOrchestratorMcp(): {
    entry: AcpMcpServer
    build: NonNullable<SpawnAgentSessionDeps["buildOrchestratorMcp"]>
  } {
    const entry: AcpMcpServer = {
      name: "agentproto",
      transport: "http",
      ref: "http://127.0.0.1:1/mcp/orchestrator?scope=report-tok",
    }
    const build = vi.fn(() => ({
      entry,
      bindLifecycle: () => () => {},
    }))
    return { entry, build }
  }

  it("injects AGENTPROTO_PARENT_SESSION_ID for a scope-attributed child; a root spawn never carries it", async () => {
    const startSession = vi.fn(async (_opts: { env?: Record<string, string> }) =>
      fakeAgentSession(),
    )
    const { deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })

    const child = await spawnAgentSession(
      { ...deps, callerScope: scopeWithOwner("sess_parent01") },
      { adapter: "mock", cwd: "/tmp", workspaceSlug: "w" },
    )
    expect(child.ok).toBe(true)
    expect(startSession.mock.calls[0]?.[0]?.env?.[PARENT_SESSION_ID_ENV]).toBe("sess_parent01")

    const root = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      workspaceSlug: "w",
    })
    expect(root.ok).toBe(true)
    expect(startSession.mock.calls[1]?.[0]?.env).not.toHaveProperty(PARENT_SESSION_ID_ENV)
  })

  it("a gateway-less child with a parent gets a minimal message_parent-only scope (role-independent, no delegation)", async () => {
    const { entry, build } = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({ buildOrchestratorMcp: build })

    const result = await spawnAgentSession(
      { ...deps, callerScope: scopeWithOwner("sess_parent01") },
      // Depth 1 → executor default: proves the report-only scope is minted
      // even for the role whose delegation gate strips agent_start/agent_prompt.
      { adapter: "mock", cwd: "/tmp", workspaceSlug: "w" },
    )
    expect(result.ok).toBe(true)
    expect(build).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledWith({ tools: ["message_parent"], role: "executor" })
    if (result.ok) {
      expect(result.descriptor.mcpServers).toEqual([entry])
    }
  })

  it("explicit `mcpServers` (even []) is a deliberate opt-out — no report-only scope minted", async () => {
    const { build } = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({ buildOrchestratorMcp: build })

    const result = await spawnAgentSession(
      { ...deps, callerScope: scopeWithOwner("sess_parent01") },
      { adapter: "mock", cwd: "/tmp", workspaceSlug: "w", mcpServers: [] },
    )
    expect(result.ok).toBe(true)
    expect(build).not.toHaveBeenCalled()
  })

  it("`orchestrator: false` opts out of ANY injected scope, report-only included", async () => {
    const { build } = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({ buildOrchestratorMcp: build })

    const result = await spawnAgentSession(
      { ...deps, callerScope: scopeWithOwner("sess_parent01") },
      { adapter: "mock", cwd: "/tmp", workspaceSlug: "w", orchestrator: false },
    )
    expect(result.ok).toBe(true)
    expect(build).not.toHaveBeenCalled()
  })

  it("hermes default gateway already reaches message_parent on the root /mcp server — no extra scope minted on top", async () => {
    const { build } = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({
      buildOrchestratorMcp: build,
      daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    })

    const result = await spawnAgentSession(
      { ...deps, callerScope: scopeWithOwner("sess_parent01") },
      { adapter: "hermes", cwd: "/tmp", workspaceSlug: "w" },
    )
    expect(result.ok).toBe(true)
    expect(build).not.toHaveBeenCalled()
    if (result.ok) {
      // The executor-default denyTools strip keeps the delegation surface
      // out but never names message_parent — the child keeps its report-back.
      const ref = result.descriptor.mcpServers?.[0]?.ref ?? ""
      expect(ref).toContain("denyTools=agent_start,agent_prompt")
      expect(ref).not.toContain("message_parent")
    }
  })

  it("a parentless root spawn mints nothing — there is no one to report to", async () => {
    const { build } = makeBuildOrchestratorMcp()
    const { deps } = baseDeps({ buildOrchestratorMcp: build })

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      workspaceSlug: "w",
    })
    expect(result.ok).toBe(true)
    expect(build).not.toHaveBeenCalled()
    if (result.ok) {
      expect(result.descriptor.mcpServers ?? []).toEqual([])
    }
  })

  it("the composed prompt tells a parented child who spawned it and how to report back, between disposition and task", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
    const sendPrompt = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const result = await spawnAgentSession(
      { ...deps, callerScope: scopeWithOwner("sess_parent01") },
      {
        adapter: "mock",
        cwd: "/tmp",
        workspaceSlug: "w",
        prompt: "fix the bug",
        wait: true,
      },
    )
    expect(result.ok).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const sentMessage = sendPrompt.mock.calls[0]?.[1]
    const prompt = typeof sentMessage === "string" ? sentMessage : ""
    const dispositionIdx = prompt.indexOf("You are the leaf")
    const lineageIdx = prompt.indexOf("You were spawned by session sess_parent01")
    const taskIdx = prompt.indexOf("fix the bug")
    expect(dispositionIdx).toBeGreaterThanOrEqual(0)
    expect(lineageIdx).toBeGreaterThan(dispositionIdx)
    expect(taskIdx).toBeGreaterThan(lineageIdx)
    expect(prompt).toContain(PARENT_SESSION_ID_ENV)
    expect(prompt).toContain("message_parent")
  })
})

describe("spawnAgentSession — AGENTS.md injection (WP-R2)", () => {
  it("injects the AGENTS.md block after the role disposition and before the caller's prompt, plus the cd-contract line", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveAgentsMd: async () => ({
        mode: "inline",
        path: "/x/AGENTS.md",
        block: "--- AGENTS.md (/x/AGENTS.md) ---\ninline content\n--- end AGENTS.md ---",
        contractLine: "THE_CONTRACT_LINE",
      }),
    })
    const sendPrompt = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/tmp",
      role: "executor",
      prompt: "do the thing",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const prompt = sendPrompt.mock.calls[0]?.[1] as string
    const dispositionIdx = prompt.indexOf("You are the leaf")
    const agIdx = prompt.indexOf("--- AGENTS.md (/x/AGENTS.md) ---")
    const contractIdx = prompt.indexOf("THE_CONTRACT_LINE")
    const taskIdx = prompt.indexOf("do the thing")
    expect(dispositionIdx).toBeGreaterThanOrEqual(0)
    expect(agIdx).toBeGreaterThan(dispositionIdx)
    expect(contractIdx).toBeGreaterThan(agIdx)
    expect(taskIdx).toBeGreaterThan(contractIdx)

    // Stamped on the descriptor too.
    expect(result.descriptor.agentsMd).toBe("/x/AGENTS.md")
    expect(result.descriptor.agentsMdMode).toBe("inline")
  })

  it("absent mode: no AGENTS.md up the walk → descriptor carries 'absent' and no path, and no AGENTS.md content is injected", async () => {
    // A real (non-repo) temp dir with nothing in it — the real resolver's git
    // probe reports non-repo, so only the dir itself is checked.
    const tmp = mkdtempSync(join(tmpdir(), "agentproto-am-absent-"))
    try {
      const startSession = vi.fn(async () => fakeAgentSession())
      const { deps } = baseDeps({
        resolveAgentAdapter: makeResolver(startSession),
        resolveAgentsMd: undefined, // fall through to the REAL resolver.
      })
      const result = await spawnAgentSession(deps, {
        adapter: "mock",
        cwd: tmp,
        prompt: "hi",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected success")
      expect(result.descriptor.agentsMd).toBeUndefined()
      expect(result.descriptor.agentsMdMode).toBe("absent")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("a resolveAgentsMd failure falls back to 'absent' WITHOUT blocking the spawn, and still injects the real cd-contract line (never an empty one)", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveAgentsMd: async () => {
        throw new Error("git rev-parse blew up")
      },
    })
    const sendPrompt = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: "/x",
      prompt: "hi",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    // The spawn succeeds despite the resolution failure — advisory-on-top-
    // of-the-role, never a hard gate.
    expect(result.descriptor.agentsMd).toBeUndefined()
    expect(result.descriptor.agentsMdMode).toBe("absent")
    // The cd-contract sentence is a static fact independent of resolution
    // succeeding — a read/git failure must not silently drop it.
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const prompt = sendPrompt.mock.calls[0]?.[1] as string
    expect(prompt).toContain(cdContractLine)
  })

  it("resolves + injects THIS repo's own AGENTS.md (pointer mode, since it's ≥ the 8 KiB default) and stamps it on the descriptor", async () => {
    // The repo root is four levels above this test file.
    const repoRoot = resolve(import.meta.dirname, "../../../../")
    const agentsMdPath = join(repoRoot, "AGENTS.md")
    expect(existsSync(agentsMdPath)).toBe(true)

    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      resolveAgentsMd: undefined, // fall through to the REAL resolver.
    })
    const sendPrompt = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      cwd: repoRoot,
      role: "executor",
      prompt: "verify the leaf contract",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.descriptor.agentsMd).toBe(agentsMdPath)
    // This repo's AGENTS.md is well over 8 KiB → pointer mode.
    expect(result.descriptor.agentsMdMode).toBe("pointer")

    const prompt = sendPrompt.mock.calls[0]?.[1] as string
    expect(prompt).toContain("read it before your first tool call")
    const dispositionIdx = prompt.indexOf("You are the leaf")
    const pointerIdx = prompt.indexOf("read it before your first tool call")
    const taskIdx = prompt.indexOf("verify the leaf contract")
    expect(pointerIdx).toBeGreaterThan(dispositionIdx)
    expect(taskIdx).toBeGreaterThan(pointerIdx)
  })

  it("inlines a small AGENTS.md when cwd is a non-repo dir carrying one (real resolver)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agentproto-am-inline-"))
    writeFileSync(join(tmp, "AGENTS.md"), "short contract body")
    try {
      const startSession = vi.fn(async () => fakeAgentSession())
      const { deps } = baseDeps({
        resolveAgentAdapter: makeResolver(startSession),
        resolveAgentsMd: undefined, // fall through to the REAL resolver.
      })
      const result = await spawnAgentSession(deps, {
        adapter: "mock",
        cwd: tmp,
        prompt: "hi",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected success")
      expect(result.descriptor.agentsMd).toBe(join(tmp, "AGENTS.md"))
      expect(result.descriptor.agentsMdMode).toBe("inline")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
