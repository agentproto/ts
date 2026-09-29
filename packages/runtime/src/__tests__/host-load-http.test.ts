/**
 * `GET /host/load` - the host load report `agentproto host load` reads. Uses
 * the real default probes, so the assertions pin the wiring, shape and the
 * time bound, not exact numbers.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
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

let acpCounter = 0
function fakeAgentSession(prefix: string, pid?: number): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    ...(pid !== undefined ? { pid } : {}),
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {}) // never resolves - keeps the session "running"
    },
    async cancel() {},
    async close() {},
  }
}

async function getJson(port: number, path: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
  return res.json()
}

describe("GET /host/load", () => {
  let stop: (() => Promise<void>) | undefined
  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  async function boot() {
    const registry = createSessionsRegistry({ persist: false })
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
    return { port, registry }
  }

  it("returns load, memory, top lists and warnings with session attribution", async () => {
    const { port, registry } = await boot()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("agent", process.pid),
      adapterSlug: "fake",
      label: "self",
    })
    const report = (await getJson(port, "/host/load?fresh=true&detail=full&budgetMs=20000")) as {
      detail: string
      partial: string[]
      loadAvg: number[]
      cpuCount: number
      loadPerCore: number
      memory: { totalBytes: number; availableBytes: number }
      topByCpu: unknown[]
      topByMemory: unknown[]
      warnings: unknown[]
      sessions: Array<{ sessionId: string; label?: string }>
      processes: Array<{ pid: number; owner: { kind: string; sessionId?: string } }>
    }
    expect(report.detail).toBe("full")
    expect(Array.isArray(report.partial)).toBe(true)
    expect(report.loadAvg).toHaveLength(3)
    expect(report.cpuCount).toBeGreaterThan(0)
    expect(report.loadPerCore).toBeGreaterThanOrEqual(0)
    expect(report.memory.totalBytes).toBeGreaterThan(0)
    expect(report.topByCpu.length).toBeLessThanOrEqual(10)
    expect(report.topByMemory.length).toBeLessThanOrEqual(10)
    expect(Array.isArray(report.warnings)).toBe(true)
    expect(report.sessions.find(s => s.sessionId === desc.id)?.label).toBe("self")
    const me = report.processes.find(p => p.pid === process.pid)
    expect(me?.owner).toMatchObject({ kind: "session", sessionId: desc.id })
  }, 30_000)

  it("defaults to the summary detail", async () => {
    const { port } = await boot()
    const report = (await getJson(port, "/host/load")) as { detail: string; processes?: unknown }
    expect(report.detail).toBe("summary")
    expect(report.processes).toBeUndefined()
  }, 30_000)

  it("rejects an unknown detail level with 400", async () => {
    const { port } = await boot()
    const res = await fetch(`http://127.0.0.1:${port}/host/load?detail=bogus`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_detail")
  })

  it("rejects a bad budget with 400", async () => {
    const { port } = await boot()
    for (const budget of ["abc", "10", "1.5", "99999"]) {
      const res = await fetch(`http://127.0.0.1:${port}/host/load?budgetMs=${budget}`)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid_budget")
    }
  })
})
