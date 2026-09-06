/**
 * HTTP-level parity test for `POST /sessions/agent` (http-server.ts)
 * against the MCP `agent_start` tool (agent-tools.ts) — both now
 * delegate to the same `spawnAgentSession` (session-spawn.ts). Closes
 * the exact gap PR #158 found: the HTTP route used to silently drop
 * `orchestrator`/`mcpServers`, so a hermes/mastracode child spawned via
 * HTTP never got the mcpServers the MCP path gave it.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import type { AcpMcpServer } from "@agentproto/acp"

import { startHttpServer, buildSpawnSessionHttpArgs, type AgentAdapterResolver } from "../http-server.js"
import type { SpawnAgentSessionInput } from "../session-spawn.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createOrchestratorInjector, createScopeTokenRegistry } from "../orchestrator-gateway.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_http_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

describe("POST /sessions/agent — orchestrator/mcpServers parity with agent_start (MCP)", () => {
  it("orchestrator:true + caller mcpServers → descriptor carries BOTH entries", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
    const sessionEvents = createSessionEventBus()
    const scopeTokens = createScopeTokenRegistry()
    const port = await freePort()
    const buildOrchestratorMcp = createOrchestratorInjector({
      scopeTokens,
      sessionEvents,
      port,
    })

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      buildOrchestratorMcp,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const callerEntry: AcpMcpServer = {
        name: "custom",
        transport: "http",
        ref: "http://example.test/mcp",
      }
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adapter: "mock",
          cwd: "/tmp",
          orchestrator: true,
          mcpServers: [callerEntry],
        }),
      })
      expect(res.status).toBe(201)
      const desc = (await res.json()) as SessionDescriptor
      expect(desc.mcpServers).toHaveLength(2)
      expect(desc.mcpServers).toContainEqual(callerEntry)
      const orchestratorEntry = desc.mcpServers?.find(s => s.name === "agentproto")
      expect(orchestratorEntry).toBeDefined()
      expect(orchestratorEntry?.ref).toContain("/mcp/orchestrator?scope=")

      // Same shape as the MCP path: the adapter itself was started with
      // both entries merged into one mcpServers array.
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.arrayContaining([
            callerEntry,
            expect.objectContaining({ name: "agentproto" }),
          ]),
        }),
      )
    } finally {
      await http.stop()
    }
  })

  it("trace:true (and stringified \"true\") forwards to registry.spawnAgent; omitted stays absent", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const spawnSpy = vi.spyOn(registry, "spawnAgent")
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
    const port = await freePort()

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const spawn = (extra: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${port}/sessions/agent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ adapter: "mock", cwd: "/tmp", ...extra }),
        })

      // JSON boolean true → trace:true reaches the registry.
      expect((await spawn({ trace: true })).status).toBe(201)
      expect(spawnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ trace: true }))

      // Stringified "true" (form-ish caller) coerces to boolean true.
      expect((await spawn({ trace: "true" })).status).toBe(201)
      expect(spawnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ trace: true }))

      // Omitted → the field is not forwarded at all (registry default applies).
      expect((await spawn({})).status).toBe(201)
      const lastArg = spawnSpy.mock.calls[spawnSpy.mock.calls.length - 1]?.[0]
      expect(lastArg).toBeDefined()
      expect("trace" in (lastArg as object)).toBe(false)
    } finally {
      await http.stop()
    }
  })

  it("orchestrator:true with no buildOrchestratorMcp wired → 501 not-enabled", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
    const port = await freePort()

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      // no buildOrchestratorMcp — daemon started without the sub-gateway.
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", orchestrator: true }),
      })
      expect(res.status).toBe(501)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("orchestrator_not_enabled")
      expect(startSession).not.toHaveBeenCalled()
      expect(registry.list()).toHaveLength(0)
    } finally {
      await http.stop()
    }
  })

  it("parentSessionId lineage hint (WP-R1) is honoured on the root HTTP route", async () => {
    const registry = createSessionsRegistry({ persist: false })
    // Seed a parent at depth 2 so the hint-derived child depth is observable.
    const parent = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "mock",
      harness: "mock",
      depth: 2,
    })
    const startSession = vi.fn(async () => fakeAgentSession())
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
    const port = await freePort()

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", parentSessionId: parent.id }),
      })
      expect(res.status).toBe(201)
      const desc = (await res.json()) as SessionDescriptor
      expect(desc.parentSessionId).toBe(parent.id)
      expect(desc.depth).toBe(3) // parent depth (2) + 1
    } finally {
      await http.stop()
    }
  })
})

describe("POST /sessions/agent — sandbox field forwarding", () => {
  it("sandbox body field is parsed and forwarded; no resolver → sandbox_provider_not_found", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const startSession = vi.fn(async () => ({
      sessionId: "acp_sb_test",
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> { return },
      async cancel() {},
      async close() {},
    }))
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "mock-adapter",
    })
    const port = await freePort()

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      // No resolveSandboxProvider — sandbox_provider_not_found expected.
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      // A string slug — simplest form.
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "mock", cwd: "/tmp", sandbox: "e2b" }),
      })
      // No resolver wired → spawnAgentSession returns sandbox_provider_not_found → HTTP 500.
      expect(res.status).not.toBe(201)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("sandbox_provider_not_found")
      // The local adapter resolver must NOT have been consulted — sandbox
      // branch short-circuits before adapter resolution.
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      await http.stop()
    }
  })

  it("forwards the WHOLE inline sandbox spec — extraPorts + env survive the mapper (regression for #1150)", () => {
    const args = buildSpawnSessionHttpArgs(
      {
        adapter: "opencode",
        cwd: "/home/user",
        sandbox: {
          provider: "e2b",
          config: { template: "tnqtmeims5q9ex7j9k06", timeoutMs: 3_600_000 },
          extraPorts: [3210],
          env: { passthrough: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] },
          lifecycle: { destroy_on: "workspace-close" },
        },
      },
      "opencode",
    )

    expect(typeof args.sandbox).toBe("object")
    const spec = args.sandbox as Extract<typeof args.sandbox, { provider: string }>
    // The fields the old hand-rolled mapper silently DROPPED must now survive.
    expect(spec.provider).toBe("e2b")
    expect(spec.config).toMatchObject({ template: "tnqtmeims5q9ex7j9k06", timeoutMs: 3_600_000 })
    expect(spec.extraPorts).toEqual([3210])
    expect(spec.env?.passthrough).toEqual(["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"])
    expect(spec.lifecycle?.destroy_on).toBe("workspace-close")
  })

  it("tolerates a JSON-stringified sandbox spec and still forwards extraPorts/env", () => {
    const args = buildSpawnSessionHttpArgs(
      {
        adapter: "opencode",
        sandbox: JSON.stringify({
          provider: "e2b",
          config: {},
          extraPorts: [8080, 5173],
          env: { passthrough: ["FOO"] },
        }),
      },
      "opencode",
    )
    const spec = args.sandbox as Extract<typeof args.sandbox, { provider: string }>
    expect(spec.extraPorts).toEqual([8080, 5173])
    expect(spec.env?.passthrough).toEqual(["FOO"])
  })

  it("still accepts a bare provider slug string and a minimal {provider} object", () => {
    expect(buildSpawnSessionHttpArgs({ adapter: "opencode", sandbox: "e2b" }, "opencode").sandbox).toBe("e2b")
    const minimal = buildSpawnSessionHttpArgs(
      { adapter: "opencode", sandbox: { provider: "local" } },
      "opencode",
    ).sandbox as Extract<SpawnAgentSessionInput["sandbox"], { provider: string }>
    expect(minimal.provider).toBe("local")
    expect(minimal.config).toEqual({})
  })
})
