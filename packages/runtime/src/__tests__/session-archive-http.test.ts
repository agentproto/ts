/**
 * HTTP-level coverage for `POST /sessions/:id/archive` (http-server.ts) — the
 * transport twin of the `session_archive` MCP verb. A thin shell over
 * `registry.archiveSession`: 200 for a terminal session (hidden from the
 * default list, still readable), 409 while the session is still alive, 404 on
 * an unknown id.
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

describe("POST /sessions/:id/archive — HTTP route", () => {
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

  async function post(http: RuntimeHttpServerHandle, id: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${http.url.split(":").pop()}/sessions/${id}/archive`, { method: "POST" })
  }

  it("archives a terminal session — 200, hidden from the default list, still readable", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    registry.kill(id)
    const http = await start(registry)
    try {
      const res = await post(http, id)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; sessionId: string; archived: boolean; archivedAt: string }
      expect(body).toMatchObject({ ok: true, sessionId: id, archived: true })
      expect(typeof body.archivedAt).toBe("string")
      expect(registry.get(id)?.archived).toBe(true)
      expect(registry.list().some((d) => d.id === id)).toBe(false)
      expect(registry.list({ includeArchived: true }).some((d) => d.id === id)).toBe(true)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("is idempotent on an already-archived session", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    registry.kill(id)
    registry.archiveSession(id)
    const http = await start(registry)
    try {
      expect((await post(http, id)).status).toBe(200)
      expect(registry.get(id)?.archived).toBe(true)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("409s on a still-running session and leaves it visible", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await post(http, id)
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe("session_not_terminal")
      expect(body.message).toContain("is still")
      expect(registry.get(id)?.archived).toBeFalsy()
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("404s on an unknown session id", async () => {
    const registry = reg()
    const http = await start(registry)
    try {
      const res = await post(http, "sess_nope")
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toBe("session_not_found")
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
