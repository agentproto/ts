/**
 * `DELETE /sessions/:id` (and `registry.forget`) on a LIVE session must run
 * the same teardown as `agent_kill` — close the adapter (whose driver kills
 * the whole process tree), SIGTERM a PTY/child, and emit `session:exited` so
 * the headless-browser sweep runs — before dropping the row. It used to only
 * drop the row, leaving the adapter tree and any headless Chrome running
 * with nothing tracking them.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionEventBus } from "../session-event-bus.js"
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

async function mcpServerFactory() {
  const { createMcpServer } = await import("@agentproto/mcp-server")
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const resolveAgentAdapter: AgentAdapterResolver = async () => ({
  async startSession() {
    throw new Error("not used in this test")
  },
  commandPreview: "mock-adapter",
})

function fakeAgentSession(): AgentSessionLike & { close: ReturnType<typeof vi.fn> } {
  return {
    sessionId: "acp-live",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {})
    },
    async cancel() {},
    close: vi.fn(async () => {}),
  }
}

function makeRegistry(ptyKill = vi.fn()) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({
    persist: false,
    sessionEvents,
    spawnPty: () => ({
      pid: 4242,
      write: () => {},
      resize: () => {},
      kill: ptyKill,
      onData: () => {},
      onExit: () => {},
    }),
    conversationLinkProbeMs: { initialMs: 3_600_000, intervalMs: 3_600_000 },
  })
  return { registry, sessionEvents, ptyKill }
}

describe("DELETE /sessions/:id on a live session", () => {
  let stop: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  async function serve(registry: ReturnType<typeof createSessionsRegistry>): Promise<number> {
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
    stop = () => http.stop()
    return port
  }

  it("kills a running agent session (adapter closed, session:exited emitted) before forgetting it", async () => {
    const { registry, sessionEvents } = makeRegistry()
    const exited: string[] = []
    sessionEvents.on("session:exited", ev => exited.push(ev.sessionId))
    const agentSession = fakeAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession,
      adapterSlug: "fake",
    })
    expect(desc.status).toBe("running")
    const port = await serve(registry)

    const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, id: desc.id, killed: true })
    expect(agentSession.close).toHaveBeenCalledTimes(1)
    // The exit event is what drives the headless-browser sweep (index.ts).
    expect(exited).toEqual([desc.id])
    expect(registry.get(desc.id)).toBeUndefined()
  })

  it("SIGTERMs a running PTY session before forgetting it", async () => {
    const { registry, ptyKill } = makeRegistry()
    const desc = registry.spawnPty({
      workspaceSlug: "default",
      cwd: process.cwd(),
      argv: ["sh"],
      cols: 80,
      rows: 24,
    })
    const port = await serve(registry)

    const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}`, { method: "DELETE" })
    expect(await res.json()).toEqual({ ok: true, id: desc.id, killed: true })
    expect(ptyKill).toHaveBeenCalledWith("SIGTERM")
    expect(registry.get(desc.id)).toBeUndefined()
  })

  it("only forgets an already-dead session (killed: false, adapter not closed again)", async () => {
    const { registry, sessionEvents } = makeRegistry()
    const agentSession = fakeAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession,
      adapterSlug: "fake",
    })
    registry.kill(desc.id)
    expect(agentSession.close).toHaveBeenCalledTimes(1)
    const exited: string[] = []
    sessionEvents.on("session:exited", ev => exited.push(ev.sessionId))
    const port = await serve(registry)

    const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}`, { method: "DELETE" })
    expect(await res.json()).toEqual({ ok: true, id: desc.id, killed: false })
    expect(agentSession.close).toHaveBeenCalledTimes(1)
    expect(exited).toEqual([])
    expect(registry.get(desc.id)).toBeUndefined()
  })

  it("404s an unknown id", async () => {
    const { registry } = makeRegistry()
    const port = await serve(registry)
    const res = await fetch(`http://127.0.0.1:${port}/sessions/nope`, { method: "DELETE" })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, id: "nope", killed: false })
  })
})

describe("registry.forget", () => {
  it("tears a live session down through kill() rather than orphaning it", () => {
    const { registry, sessionEvents } = makeRegistry()
    const exited: string[] = []
    sessionEvents.on("session:exited", ev => exited.push(ev.sessionId))
    const agentSession = fakeAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession,
      adapterSlug: "fake",
    })

    expect(registry.forget(desc.id)).toBe(true)
    expect(agentSession.close).toHaveBeenCalledTimes(1)
    expect(exited).toEqual([desc.id])
    expect(registry.get(desc.id)).toBeUndefined()
  })
})

describe("other removal paths refuse live sessions", () => {
  it("gcSessions (forget mode) skips a running session", () => {
    const { registry } = makeRegistry()
    const agentSession = fakeAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession,
      adapterSlug: "fake",
    })
    expect(registry.gcSessions({ forget: true }).ids).not.toContain(desc.id)
    expect(registry.get(desc.id)?.status).toBe("running")
    expect(agentSession.close).not.toHaveBeenCalled()
  })

  it("archiveSession throws on a running session", () => {
    const { registry } = makeRegistry()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
    })
    expect(() => registry.archiveSession(desc.id)).toThrow(/still running/)
  })
})
