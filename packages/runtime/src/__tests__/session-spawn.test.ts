/**
 * Unit coverage for `spawnAgentSession` (session-spawn.ts) — the shared
 * spawn logic extracted from agent-tools.ts's `agent_start` handler.
 * Calls the function directly (no MCP transport) so these are cheap,
 * synchronous-ish checks of the orchestrator guardrails + the hermes
 * default-mcpServers safety net. The MCP-level behaviour is covered
 * separately (agent-start-mode.test.ts, orchestrator-guardrails.test.ts).
 */

import { describe, it, expect, vi } from "vitest"
import type { AcpMcpServer } from "@agentproto/acp"
import { spawnAgentSession, cleanAgentLines, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { OrchestratorScope } from "../orchestrator-gateway.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"

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
      ownerSessionId: "parent",
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
      ownerSessionId: "parent",
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
