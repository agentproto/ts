/**
 * HTTP-level coverage for `POST /sessions/pinned/order` (http-server.ts) —
 * the transport twin of the `session_reorder_pinned` MCP verb. The route
 * sits ahead of the generic `/sessions/:id/...` matcher so "pinned" is
 * not read as a session id: this checks the happy path (200 + registry
 * updated), a 400 on a body whose `ids` is not a string array, and the
 * 404/400 `reorder_pinned_failed` errors on an unknown / unpinned id.
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

describe("POST /sessions/pinned/order — HTTP route", () => {
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

  async function postOrder(http: RuntimeHttpServerHandle, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${http.url.split(":").pop()}/sessions/pinned/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("reorders the pinned group — returns {ok, ids} and updates the registry", async () => {
    const registry = reg()
    const a = spawnLive(registry)
    const b = spawnLive(registry)
    const c = spawnLive(registry)
    registry.setPinned(a, true)
    registry.setPinned(b, true)
    registry.setPinned(c, true)
    const http = await start(registry)
    try {
      const res = await postOrder(http, { ids: [c, a, b] })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; ids: string[] }
      expect(body).toEqual({ ok: true, ids: [c, a, b] })
      expect(registry.get(c)?.pinnedOrder).toBe(0)
      expect(registry.get(a)?.pinnedOrder).toBe(1)
      expect(registry.get(b)?.pinnedOrder).toBe(2)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("keeps unlisted pinned sessions after the listed ones", async () => {
    const registry = reg()
    const a = spawnLive(registry)
    const b = spawnLive(registry)
    registry.setPinned(a, true)
    registry.setPinned(b, true)
    const http = await start(registry)
    try {
      const res = await postOrder(http, { ids: [b] })
      expect(res.status).toBe(200)
      expect(registry.get(b)?.pinnedOrder).toBe(0)
      expect(registry.get(a)?.pinnedOrder).toBe(1)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("400s on a body whose ids is not a string array", async () => {
    const registry = reg()
    const http = await start(registry)
    try {
      const res = await postOrder(http, { ids: "nope" })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("invalid_body")
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("404s on an unknown session id with reorder_pinned_failed", async () => {
    const registry = reg()
    const http = await start(registry)
    try {
      const res = await postOrder(http, { ids: ["sess_nope"] })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("reorder_pinned_failed")
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("400s on an unpinned session id with reorder_pinned_failed", async () => {
    const registry = reg()
    const a = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await postOrder(http, { ids: [a] })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("reorder_pinned_failed")
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
