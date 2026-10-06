/**
 * What a session's harness actually loaded from the daemon's `/mcp` mount:
 * the observer wraps the (stateless, per-POST) transport, keeps the latest
 * `initialize` / `server/discover` / `tools/list` outcome per
 * `?callerSessionId=`, and feeds `session_capabilities.mcpServers[]` plus the
 * `mcp:degraded` bus event. This is the blind spot that hid the
 * "0 MCP tools although the mount is declared" bug.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import {
  assessDaemonMount,
  createMcpObservationStore,
  daemonMountStatus,
  isDaemonMountFor,
  wireMcpDegradedWarnings,
  type McpSessionObservation,
} from "../mcp-session-observer.js"
import { buildSessionCapabilities } from "../session-capabilities.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { withDeferredTools } from "../deferred-tools.js"

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
  return { start() {}, stop() {}, async fireNow() {} }
}

type FactoryKind = "eager" | "deferred" | "zero" | "failing"

async function factoryFor(kind: FactoryKind) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  if (kind === "zero") {
    server.tool("alpha", "first tool", {}, async () => ({ content: [{ type: "text", text: "a" }] }))
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
    return server
  }
  const target = kind === "deferred" ? withDeferredTools(server, { alwaysOn: new Set(["alpha"]) }) : server
  target.tool("alpha", "first tool", {}, async () => ({ content: [{ type: "text", text: "a" }] }))
  target.tool("beta", "second tool", {}, async () => ({ content: [{ type: "text", text: "b" }] }))
  if (kind === "failing") {
    server.server.setRequestHandler(ListToolsRequestSchema, () => {
      throw new Error("tools/list exploded")
    })
  }
  return server
}

async function withDaemon<T>(
  kind: FactoryKind,
  run: (ctx: { port: number; store: ReturnType<typeof createMcpObservationStore> }) => Promise<T>,
): Promise<T> {
  const port = await freePort()
  const store = createMcpObservationStore()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: () => factoryFor(kind),
    mcpObservations: store,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    return await run({ port, store })
  } finally {
    await http.stop()
  }
}

async function listToolsAs(port: number, query: string): Promise<{ names: string[] } | { error: string }> {
  const client = new Client({ name: "observer-test", version: "0" })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp${query}`))
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    return { names: tools.map(t => t.name) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    await client.close().catch(() => {})
  }
}

describe("/mcp observer (end to end over the real HTTP transport)", () => {
  it("records an eager tools/list per callerSessionId", async () => {
    await withDaemon("eager", async ({ port, store }) => {
      const res = await listToolsAs(port, "?callerSessionId=sess_eager")
      expect(res).toMatchObject({ names: expect.arrayContaining(["alpha", "beta"]) })
      const obs = store.get("sess_eager")
      expect(obs?.initialize?.ok).toBe(true)
      expect(obs?.toolsList).toMatchObject({ ok: true, deferred: false })
      expect(obs?.toolsList?.toolCount).toBeGreaterThanOrEqual(2)
      expect(obs?.toolsList?.tools.find(t => t.name === "alpha")).toEqual({ name: "alpha", description: "first tool" })
      expect(obs?.toolsList?.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(daemonMountStatus(obs, 1)).toBe("listed")
      expect(assessDaemonMount(obs)).toBeUndefined()
    })
  })

  it("flags the deferred projection (alwaysOn + tool_search only)", async () => {
    await withDaemon("deferred", async ({ port, store }) => {
      await listToolsAs(port, "?callerSessionId=sess_deferred&deferred=1")
      const tl = store.get("sess_deferred")?.toolsList
      expect(tl?.deferred).toBe(true)
      expect(tl?.tools.map(t => t.name)).toContain("tool_search")
      expect(tl?.tools.map(t => t.name)).not.toContain("beta")
    })
  })

  it("keeps sessions apart and ignores connections without callerSessionId", async () => {
    await withDaemon("eager", async ({ port, store }) => {
      await listToolsAs(port, "?callerSessionId=sess_a")
      await listToolsAs(port, "")
      expect(store.get("sess_a")).toBeDefined()
      expect(store.get("sess_b")).toBeUndefined()
    })
  })

  it("reports a failing tools/list as an error", async () => {
    await withDaemon("failing", async ({ port, store }) => {
      const res = await listToolsAs(port, "?callerSessionId=sess_fail")
      expect(res).toHaveProperty("error")
      const obs = store.get("sess_fail")
      expect(obs?.toolsList?.ok).toBe(false)
      expect(obs?.toolsList?.error).toContain("tools/list exploded")
      expect(daemonMountStatus(obs, 1)).toBe("error")
      expect(assessDaemonMount(obs)).toMatchObject({ reason: "error" })
    })
  })

  it("reports a successful but empty tools/list as zero-tools", async () => {
    await withDaemon("zero", async ({ port, store }) => {
      await listToolsAs(port, "?callerSessionId=sess_zero")
      const obs = store.get("sess_zero")
      expect(obs?.toolsList).toMatchObject({ ok: true, toolCount: 0, tools: [] })
      expect(daemonMountStatus(obs, 1)).toBe("listed")
      expect(assessDaemonMount(obs)).toEqual({ reason: "zero-tools" })
    })
  })

  it("records the era the client asked for and an HTTP-level rejection", async () => {
    await withDaemon("eager", async ({ port, store }) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp?callerSessionId=sess_old`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2020-01-01",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
      expect(res.status).toBe(400)
      const obs = store.get("sess_old")
      expect(obs?.httpError?.status).toBe(400)
      expect(daemonMountStatus(obs, 1)).toBe("error")
      expect(assessDaemonMount(obs)).toEqual({ reason: "error", detail: "HTTP 400" })
    })
  })

  it("records the header era (pre-coercion) on tools/list", async () => {
    await withDaemon("eager", async ({ port, store }) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp?callerSessionId=sess_modern`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
      expect(res.status).toBe(200)
      expect(store.get("sess_modern")?.toolsList?.protocolVersion).toBe("2026-07-28")
    })
  })
})

describe("daemonMountStatus / assessDaemonMount", () => {
  const at = "2026-10-06T00:00:00.000Z"
  const base = { firstSeenAt: at, lastSeenAt: at }

  it("maps every observation shape to a status", () => {
    expect(daemonMountStatus(undefined, 0)).toBe("declared")
    expect(daemonMountStatus(undefined, undefined)).toBe("declared")
    expect(daemonMountStatus(undefined, 2)).toBe("never-contacted")
    expect(daemonMountStatus({ ...base, initialize: { at, ok: true } }, 1)).toBe("connected")
    expect(daemonMountStatus({ ...base, discover: { at, ok: true } }, 1)).toBe("connected")
    expect(daemonMountStatus({ ...base, initialize: { at, ok: false, error: "x" } }, 1)).toBe("error")
    expect(
      daemonMountStatus({ ...base, toolsList: { at, ok: true, toolCount: 3, deferred: false, tools: [] } }, 1),
    ).toBe("listed")
    expect(
      daemonMountStatus({ ...base, toolsList: { at, ok: false, error: "x", toolCount: 0, deferred: false, tools: [] } }, 1),
    ).toBe("error")
  })

  it("assesses never-listed, zero-tools and handshake errors", () => {
    expect(assessDaemonMount(undefined)).toEqual({ reason: "never-listed" })
    expect(assessDaemonMount({ ...base, initialize: { at, ok: true } })).toEqual({
      reason: "never-listed",
      detail: "handshake seen but no tools/list",
    })
    expect(assessDaemonMount({ ...base, discover: { at, ok: false, error: "-32601: nope" } })).toEqual({
      reason: "error",
      detail: "server/discover -32601: nope",
    })
    expect(
      assessDaemonMount({ ...base, toolsList: { at, ok: true, toolCount: 0, deferred: false, tools: [] } }),
    ).toEqual({ reason: "zero-tools" })
  })

  it("only treats the daemon's own /mcp stamped with this session as the observable mount", () => {
    const mount = { transport: "http", ref: "http://127.0.0.1:18790/mcp?callerSessionId=sess_1&deferred=0" }
    expect(isDaemonMountFor("sess_1", mount)).toBe(true)
    expect(isDaemonMountFor("sess_2", mount)).toBe(false)
    expect(isDaemonMountFor("sess_1", { transport: "http", ref: "http://127.0.0.1:18790/mcp/orchestrator?scope=t" })).toBe(false)
    expect(isDaemonMountFor("sess_1", { transport: "stdio", ref: "npx foo" })).toBe(false)
    expect(isDaemonMountFor("sess_1", { transport: "http" })).toBe(false)
    expect(isDaemonMountFor("sess_1", { transport: "http", ref: "not a url" })).toBe(false)
  })
})

function fakeAgent(): AgentSessionLike {
  return {
    sessionId: "acp_obs",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

describe("session_capabilities mcpServers (additive fields)", () => {
  const at = "2026-10-06T00:00:00.000Z"

  function spawn() {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: fakeAgent(), adapterSlug: "mock" })
    const withMounts = {
      ...desc,
      mcpServers: [
        { name: "agentproto", transport: "http" as const, ref: `http://127.0.0.1:18790/mcp?callerSessionId=${desc.id}` },
        { name: "github", transport: "http" as const, ref: "https://example.test/mcp" },
      ],
    }
    return { registry, withMounts }
  }

  it("marks non-daemon servers declared and never puts tool data on them", () => {
    const { registry, withMounts } = spawn()
    const listed: McpSessionObservation = {
      firstSeenAt: at,
      lastSeenAt: at,
      toolsList: { at, ok: true, toolCount: 1, deferred: false, tools: [{ name: "x" }] },
    }
    const github = buildSessionCapabilities({ ...withMounts, turnsCompleted: 3 }, 0, listed).mcpServers.find(
      s => s.name === "github",
    )
    expect(github).toEqual({ name: "github", transport: "http", ref: "https://example.test/mcp", status: "declared" })
    registry.shutdown()
  })

  it("daemon mount: declared before any turn, never-contacted after one, listed with tools once observed, error when failing", () => {
    const { registry, withMounts } = spawn()
    const daemon = (turns?: number, obs?: McpSessionObservation) =>
      buildSessionCapabilities({ ...withMounts, ...(turns !== undefined ? { turnsCompleted: turns } : {}) }, 0, obs)
        .mcpServers[0]

    expect(daemon(0)).toMatchObject({ name: "agentproto", status: "declared" })
    expect(daemon(1)).toMatchObject({ status: "never-contacted" })
    expect(daemon(1)).not.toHaveProperty("tools")

    const listed: McpSessionObservation = {
      firstSeenAt: at,
      lastSeenAt: at,
      initialize: { at, ok: true, protocolVersion: "2025-11-25" },
      toolsList: {
        at,
        ok: true,
        toolCount: 2,
        deferred: true,
        protocolVersion: "2025-11-25",
        tools: [{ name: "tool_search", description: "d" }, { name: "agent_output" }],
      },
    }
    expect(daemon(1, listed)).toMatchObject({
      status: "listed",
      toolCount: 2,
      deferred: true,
      protocolVersion: "2025-11-25",
      lastSeenAt: at,
      tools: [{ name: "tool_search", description: "d" }, { name: "agent_output" }],
    })

    const failed: McpSessionObservation = {
      firstSeenAt: at,
      lastSeenAt: at,
      toolsList: { at, ok: false, error: "-32603: boom", toolCount: 0, deferred: false, tools: [] },
    }
    expect(daemon(1, failed)).toMatchObject({ status: "error", error: "-32603: boom" })
    expect(daemon(1, failed)).not.toHaveProperty("tools")
    registry.shutdown()
  })
})

describe("mcp:degraded", () => {
  function setup(opts: { withMount: boolean }) {
    const registry = createSessionsRegistry({ persist: false })
    const sessionEvents = createSessionEventBus()
    const store = createMcpObservationStore()
    const events: SessionEvent[] = []
    sessionEvents.on("mcp:degraded", ev => events.push(ev))
    const spawned = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: fakeAgent(),
      adapterSlug: "mock",
      label: "probe",
    })
    const desc = {
      ...spawned,
      mcpServers: opts.withMount
        ? [{ name: "agentproto", transport: "http" as const, ref: `http://127.0.0.1:18790/mcp?callerSessionId=${spawned.id}` }]
        : [],
    }
    wireMcpDegradedWarnings({ sessionEvents, getSession: () => desc, store })
    const turnEnd = (reason?: string) =>
      sessionEvents.emit({
        type: "session:turn-end",
        sessionId: desc.id,
        awaitingInput: false,
        ...(reason ? { reason } : {}),
        ts: new Date().toISOString(),
      })
    return { registry, sessionEvents, store, events, desc, turnEnd }
  }

  it("fires once when a turn ends without the harness ever listing the mount", () => {
    const { events, turnEnd, registry, desc } = setup({ withMount: true })
    turnEnd("completed")
    turnEnd("completed")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "mcp:degraded",
      sessionId: desc.id,
      server: "agentproto",
      reason: "never-listed",
      label: "probe",
    })
    registry.shutdown()
  })

  it("stays quiet for a mount-less session and for turns that failed or were cut", () => {
    const failedTurn = setup({ withMount: true })
    failedTurn.turnEnd("error")
    failedTurn.turnEnd("cancelled")
    expect(failedTurn.events).toHaveLength(0)
    failedTurn.registry.shutdown()

    const bare = setup({ withMount: false })
    bare.turnEnd("completed")
    expect(bare.events).toHaveLength(0)
    bare.registry.shutdown()
  })

  it("goes quiet once the harness lists the mount", async () => {
    await withDaemon("eager", async ({ port, store }) => {
      const registry = createSessionsRegistry({ persist: false })
      const sessionEvents = createSessionEventBus()
      const events: SessionEvent[] = []
      sessionEvents.on("mcp:degraded", ev => events.push(ev))
      const spawned = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: fakeAgent(), adapterSlug: "mock" })
      const desc = {
        ...spawned,
        mcpServers: [{ name: "agentproto", transport: "http" as const, ref: `http://127.0.0.1:${port}/mcp?callerSessionId=${spawned.id}` }],
      }
      wireMcpDegradedWarnings({ sessionEvents, getSession: () => desc, store })
      const turnEnd = () =>
        sessionEvents.emit({ type: "session:turn-end", sessionId: desc.id, awaitingInput: false, reason: "completed", ts: "t" })

      turnEnd()
      expect(events.map(e => (e.type === "mcp:degraded" ? e.reason : ""))).toEqual(["never-listed"])
      await listToolsAs(port, `?callerSessionId=${desc.id}`)
      turnEnd()
      expect(events).toHaveLength(1)
      registry.shutdown()
    })
  })
})
