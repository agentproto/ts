/**
 * Unit coverage for `spawnAgentSession` (session-spawn.ts) — the shared
 * spawn logic extracted from agent-tools.ts's `agent_start` handler.
 * Calls the function directly (no MCP transport) so these are cheap,
 * synchronous-ish checks of the orchestrator guardrails + the hermes
 * default-mcpServers safety net. The MCP-level behaviour is covered
 * separately (agent-start-mode.test.ts, orchestrator-guardrails.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
}))
vi.mock("../claude-code-oauth-source.js", () => ({
  resolveClaudeCodeOauthToken: (id: string) => oauthState.impl(id),
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

import { spawnAgentSession, cleanAgentLines, type SpawnAgentSessionDeps } from "../session-spawn.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"
import { getMcpCredentialDeps, setMcpCredentialDeps } from "../mcp-credential-deps.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
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
    ...overrides,
  }
  return { registry, deps }
}

describe("spawnAgentSession", () => {
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
    expect(captured[0]?.mcpServers).toEqual([
      { name: "agentproto", transport: "http", ref: daemonMcpUrl },
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

  it("(c) does not default mcpServers for a non-hermes adapter", async () => {
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return fakeAgentSession()
    })
    const { deps } = baseDeps({
      resolveAgentAdapter: makeResolver(startSession),
      daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    })

    const result = await spawnAgentSession(deps, { adapter: "claude-code", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toBeUndefined()
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

  it("omitting idempotencyKey is a no-op — repeated identical calls still spawn independently (today's behaviour)", async () => {
    const startSession = vi.fn(async () => fakeAgentSession())
    const { registry, deps } = baseDeps({ resolveAgentAdapter: makeResolver(startSession) })
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

    // 31s later — past SPAWN_CLAIM_WINDOW_MS (30s).
    nowSpy.mockReturnValue(1_000 + 31_000)
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
          ref: "http://127.0.0.1:18790/mcp?denyTools=agent_start,agent_prompt",
        },
      ])
    }
  })

  it("supervisor (explicit) keeps the plain hermes default-gateway ref (no denyTools)", async () => {
    const { deps } = baseDeps({ daemonMcpUrl: "http://127.0.0.1:18790/mcp" })

    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: "/tmp",
      role: "supervisor",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.mcpServers).toEqual([
        { name: "agentproto", transport: "http", ref: "http://127.0.0.1:18790/mcp" },
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

describe("spawnAgentSession — billing-auth resolution wiring", () => {
  beforeEach(() => {
    storeKeys.value = {}
  })

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
    opts: { defaultModel?: string } = {},
  ): { resolver: AgentAdapterResolver; captured: CapturedStartSession[] } {
    const captured: CapturedStartSession[] = []
    const resolver: AgentAdapterResolver = async () => ({
      startSession: vi.fn(async (o: { auth?: CapturedAuth; options?: Record<string, boolean | number | string> }) => {
        captured.push({ auth: o.auth, options: o.options })
        return fakeAgentSession()
      }),
      commandPreview: "mock-adapter",
      ...(descriptor ? { authDescriptor: descriptor } : {}),
      ...(opts.defaultModel ? { defaultModel: opts.defaultModel } : {}),
    })
    return { resolver, captured }
  }

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
