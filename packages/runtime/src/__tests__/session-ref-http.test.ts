/**
 * WP-C1 — HTTP surface for the session resolver + slug.
 *
 * Covers the two behaviours the CLI/HTTP lane owns:
 *   1. `PATCH /sessions/:id` accepts a `slug` in the body (rename), setting
 *      the addressable handle through the registry.
 *   2. A session route param (`:idOrName` / `:id`) resolves a session by its
 *      slug — every route slot goes through the shared `resolveSessionRef`,
 *      not a bare registry map lookup.
 *
 * Harness follows session-archive-http.test.ts: a real http server on a free
 * port, driven with fetch.
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

describe("session-ref HTTP surface", () => {
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

  function spawnLive(registry: ReturnType<typeof reg>, label = "rename-target"): string {
    return registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "claude-code",
      label,
    }).id
  }

  const base = (http: RuntimeHttpServerHandle): string =>
    `http://127.0.0.1:${http.url.split(":").pop()}`

  it("PATCH /sessions/:id with { slug } sets the addressable slug", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await fetch(`${base(http)}/sessions/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "custom-handle" }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id: string; slug?: string }
      expect(body.id).toBe(id)
      expect(body.slug).toBe("custom-handle")
      expect(registry.get(id)?.slug).toBe("custom-handle")
      // The new slug is now addressable through the shared resolver.
      expect(registry.findByIdOrName("custom-handle")?.id).toBe(id)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("de-duplicates a colliding slug override with -2", async () => {
    const registry = reg()
    const a = spawnLive(registry, "first")
    const b = spawnLive(registry, "second")
    const http = await start(registry)
    try {
      const rename = (id: string, slug: string) =>
        fetch(`${base(http)}/sessions/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug }),
        })
      await rename(a, "shared")
      const res = await rename(b, "shared")
      expect(res.status).toBe(200)
      expect(registry.get(b)?.slug).toBe("shared-2")
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("resolves a session route param by slug (GET /sessions/:slug)", async () => {
    const registry = reg()
    const id = spawnLive(registry) // slug is minted from the label "rename-target"
    const http = await start(registry)
    try {
      const res = await fetch(`${base(http)}/sessions/rename-target`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id: string }
      expect(body.id).toBe(id)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("resolves a sub-route param by slug (GET /sessions/:slug/queue)", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await fetch(`${base(http)}/sessions/rename-target/queue`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; id: string; queue: unknown[] }
      expect(body.ok).toBe(true)
      expect(body.id).toBe(id)
      expect(body.queue).toEqual([])
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("404s a route param that matches no id, slug, or name", async () => {
    const registry = reg()
    spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await fetch(`${base(http)}/sessions/sess_nope/queue`)
      expect(res.status).toBe(404)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
