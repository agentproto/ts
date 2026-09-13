/**
 * HTTP-level coverage for `POST /sessions/:id/pin` (http-server.ts) — the
 * transport twin of the `session_set_pinned` MCP verb, powering `agentproto
 * sessions pin`/`unpin`. The route is a thin shell over `registry.setPinned`:
 * this checks set/clear, tolerant stringified-boolean bodies (same convention
 * as `keepAlive` on the spawn route), a 404 on an unknown session, and a 400
 * on a body with no usable `pinned` value.
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

describe("POST /sessions/:id/pin — HTTP route", () => {
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

  async function post(http: RuntimeHttpServerHandle, id: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${http.url.split(":").pop()}/sessions/${id}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("pins a session — returns {ok, sessionId, pinned} and updates the registry", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await post(http, id, { pinned: true })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; sessionId: string; pinned: boolean }
      expect(body).toEqual({ ok: true, sessionId: id, pinned: true })
      expect(registry.get(id)?.pinned).toBe(true)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("unpins a session", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    registry.setPinned(id, true)
    const http = await start(registry)
    try {
      const res = await post(http, id, { pinned: false })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { pinned: boolean }
      expect(body.pinned).toBe(false)
      expect(registry.get(id)?.pinned).toBe(false)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("tolerates a stringified boolean body, same convention as keepAlive", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await post(http, id, { pinned: "true" })
      expect(res.status).toBe(200)
      expect(registry.get(id)?.pinned).toBe(true)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("never touches keepAlive", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    const http = await start(registry)
    try {
      await post(http, id, { pinned: true })
      expect(registry.get(id)?.keepAlive).toBeUndefined()
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("404s on an unknown session id", async () => {
    const registry = reg()
    const http = await start(registry)
    try {
      const res = await post(http, "sess_nope", { pinned: true })
      expect(res.status).toBe(404)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("400s on a body with no usable pinned value", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await post(http, id, {})
      expect(res.status).toBe(400)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
