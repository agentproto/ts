/**
 * HTTP-level coverage for `POST /sessions/gc` (http-server.ts) — the transport
 * twin of the `session_gc` MCP verb, powering `agentproto sessions gc`. The
 * route is a thin shell over `registry.gcSessions`: this checks that a bare
 * call ARCHIVES terminal sessions (and never a live one), that `forget:true`
 * DROPS the descriptor, that `olderThanDays` is forwarded, and that a garbage
 * body is tolerated. The GC engine itself is covered by session-gc.test.ts.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerHandle } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
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
  return { start() {}, stop() {}, async fireNow() {} }
}

let n = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `c_${n++}`,
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

describe("POST /sessions/gc — HTTP route", () => {
  async function start(
    registry: ReturnType<typeof createSessionsRegistry>,
  ): Promise<RuntimeHttpServerHandle> {
    const port = await freePort()
    return startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
  }

  function reg() {
    return createSessionsRegistry({ sessionEvents: createSessionEventBus(), persist: false })
  }

  function spawnLive(registry: ReturnType<typeof reg>): string {
    return registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "claude-code",
    }).id
  }

  function spawnDead(registry: ReturnType<typeof reg>): string {
    const id = spawnLive(registry)
    registry.kill(id)
    return id
  }

  async function post(http: RuntimeHttpServerHandle, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${http.url.split(":").pop()}/sessions/gc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("archives terminal sessions by default and never touches a live one", async () => {
    const registry = reg()
    const dead = spawnDead(registry)
    const live = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await post(http, {})
      expect(res.status).toBe(200)
      const body = (await res.json()) as { mode: string; ids: string[]; count: number }
      expect(body.mode).toBe("archived")
      expect(body.ids).toContain(dead)
      expect(body.ids).not.toContain(live)
      expect(body.count).toBe(1)
      expect(registry.get(dead)?.archived).toBe(true)
      expect(registry.get(live)?.archived).not.toBe(true)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("forget:true drops the descriptor entirely (mode: forgotten)", async () => {
    const registry = reg()
    const dead = spawnDead(registry)
    const http = await start(registry)
    try {
      const res = await post(http, { forget: true })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { mode: string; count: number }
      expect(body.mode).toBe("forgotten")
      expect(body.count).toBe(1)
      expect(registry.get(dead)).toBeUndefined()
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("olderThanDays keeps a session more recent than the cutoff", async () => {
    const registry = reg()
    spawnDead(registry) // just-now — younger than 1 day
    const http = await start(registry)
    try {
      const res = await post(http, { olderThanDays: 1 })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { count: number }
      expect(body.count).toBe(0)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("tolerates a garbage body (no fields) as a bare GC-everything call", async () => {
    const registry = reg()
    const dead = spawnDead(registry)
    const http = await start(registry)
    try {
      const res = await post(http, "not-an-object")
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ids: string[]; count: number }
      expect(body.ids).toContain(dead)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
