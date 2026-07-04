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
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
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
