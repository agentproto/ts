/**
 * `GET /sessions/stats` - the per-session resource report the CLI's
 * `sessions --stats` reads. Uses the real default sampler (one `ps`), so the
 * assertions pin the wiring and shape, not exact numbers.
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

describe("GET /sessions/stats", () => {
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

  it("returns host, labelled session rows, daemon, provisioning, orphans and totals", async () => {
    const { port, registry } = await boot()
    // The test runner's own pid is a real live process the sampler can find.
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("agent", process.pid),
      adapterSlug: "fake",
      label: "self",
    })
    const report = (await getJson(port, "/sessions/stats?fresh=true")) as {
      detail: string
      host: { cpuCount: number; loadAvg: number[]; freeMemBytes: number }
      sessions: Array<{ sessionId: string; label?: string; rssBytes: number; procCount: number }>
      daemon: { pid: number }
      provisioning: { inFlight: unknown[] }
      orphans: unknown[]
      totals: { rssBytes: number; procCount: number }
    }
    expect(report.detail).toBe("summary")
    expect(report.host.cpuCount).toBeGreaterThan(0)
    expect(report.host.loadAvg).toHaveLength(3)
    expect(report.host.freeMemBytes).toBeGreaterThan(0)
    const row = report.sessions.find(s => s.sessionId === desc.id)
    expect(row?.label).toBe("self")
    expect(row?.rssBytes).toBeGreaterThan(0)
    expect(report.daemon.pid).toBe(process.pid)
    expect(Array.isArray(report.provisioning.inFlight)).toBe(true)
    expect(Array.isArray(report.orphans)).toBe(true)
    expect(report.totals.procCount).toBeGreaterThanOrEqual(row?.procCount ?? 1)
  }, 30_000)

  it("includes per-process detail for ?detail=full", async () => {
    const { port, registry } = await boot()
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("agent", process.pid),
      adapterSlug: "fake",
    })
    const report = (await getJson(port, "/sessions/stats?detail=full")) as {
      detail: string
      sessions: Array<{ processes?: Array<{ pid: number; command: string }> }>
    }
    expect(report.detail).toBe("full")
    expect(report.sessions[0]?.processes?.some(p => p.pid === process.pid)).toBe(true)
  }, 30_000)

  it("rejects an unknown detail level with 400", async () => {
    const { port } = await boot()
    const res = await fetch(`http://127.0.0.1:${port}/sessions/stats?detail=bogus`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_detail")
  })
})
