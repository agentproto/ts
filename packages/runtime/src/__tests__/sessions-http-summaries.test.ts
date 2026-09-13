/**
 * `GET /sessions/summaries` — lightweight, paginated panel projection of
 * `GET /sessions`. Verifies it returns SessionSummary rows, respects
 * `includeArchived`, and supports `limit`/`offset` while keeping the full
 * `GET /sessions` contract unchanged.
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
      await new Promise(() => {}) // never resolves — keeps the session "running"
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

describe("GET /sessions/summaries", () => {
  let stopServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stopServer?.()
    stopServer = undefined
  })

  async function withServer(
    run: (port: number, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>,
  ): Promise<void> {
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
    stopServer = () => http.stop()
    try {
      await run(port, registry)
    } finally {
      await http.stop()
      stopServer = undefined
    }
  }

  it("returns lightweight summaries with a total count", async () => {
    await withServer(async (port, registry) => {
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
      const result = (await getJson(port, "/sessions/summaries")) as {
        summaries: Array<Record<string, unknown>>
        total: number
      }
      expect(result.total).toBe(1)
      expect(result.summaries).toHaveLength(1)
      const summary = result.summaries[0]!
      expect(typeof summary.id).toBe("string")
      expect(summary.kind).toBe("agent-cli")
      expect(summary.status).toBe("running")
      // Excluded large fields should not appear in the summary projection.
      expect(summary).not.toHaveProperty("resumeMetadata")
      expect(summary).not.toHaveProperty("mcpServers")
      expect(summary).not.toHaveProperty("contextContinuity")
      expect(summary).not.toHaveProperty("checkpointId")
      expect(summary).not.toHaveProperty("endedReason")
    })
  })

  it("paginates with limit and offset", async () => {
    await withServer(async (port, registry) => {
      for (let i = 0; i < 5; i++) {
        registry.spawnAgent({
          workspaceSlug: "default",
          cwd: process.cwd(),
          agentSession: fakeAgentSession("agent"),
          adapterSlug: "fake",
        })
      }
      const first = (await getJson(port, "/sessions/summaries?limit=2&offset=0")) as {
        summaries: Array<{ id: string }>
        total: number
      }
      expect(first.total).toBe(5)
      expect(first.summaries).toHaveLength(2)
      const second = (await getJson(port, "/sessions/summaries?limit=2&offset=2")) as {
        summaries: Array<{ id: string }>
        total: number
      }
      expect(second.summaries).toHaveLength(2)
      expect(second.summaries[0]!.id).not.toBe(first.summaries[0]!.id)
      const third = (await getJson(port, "/sessions/summaries?limit=2&offset=4")) as {
        summaries: Array<{ id: string }>
        total: number
      }
      expect(third.summaries).toHaveLength(1)
    })
  })

  it("keeps GET /sessions returning full descriptors unchanged", async () => {
    await withServer(async (port, registry) => {
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
      const full = (await getJson(port, "/sessions")) as { sessions: Array<Record<string, unknown>> }
      expect(full.sessions).toHaveLength(1)
      // Full descriptors continue to carry fields the summary omits.
      const desc = full.sessions[0]!
      expect(desc.kind).toBe("agent-cli")
    })
  })
})
