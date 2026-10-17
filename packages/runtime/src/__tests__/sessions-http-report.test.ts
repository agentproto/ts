/**
 * `GET /sessions/report` - the fleet-wide session stats report the CLI's
 * `sessions report` reads. The collection/reduction contracts are covered by
 * session-report.test.ts (pure) and session-report-service.test.ts
 * (collector); this only proves the HTTP wiring: query params, defaults, and
 * the 400 on an invalid `topN`.
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
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
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

describe("GET /sessions/report", () => {
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

  it("defaults to a 12h window and counts a freshly-spawned session", async () => {
    const { port, registry } = await boot()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "claude-code",
      harness: "claude-code",
      label: "self",
    })
    const report = (await getJson(port, "/sessions/report")) as {
      since: string
      totalSessions: number
      activeSessions: Array<{ id: string }>
    }
    expect(report.since).toBe("12h")
    expect(report.totalSessions).toBe(1)
    expect(report.activeSessions.map(s => s.id)).toEqual([desc.id])
  })

  it("honours ?since and ?topN", async () => {
    const { port } = await boot()
    const report = (await getJson(port, "/sessions/report?since=7d&topN=2")) as {
      since: string
      topByCost: unknown[]
    }
    expect(report.since).toBe("7d")
    expect(report.topByCost).toHaveLength(0)
  })

  it("rejects a non-positive topN with 400", async () => {
    const { port } = await boot()
    const res = await fetch(`http://127.0.0.1:${port}/sessions/report?topN=0`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("invalid_topN")
  })
})
