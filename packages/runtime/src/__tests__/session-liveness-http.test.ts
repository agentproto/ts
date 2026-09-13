/**
 * HTTP-level coverage for the session liveness signal — `alive` on the
 * session descriptor returned by GET /sessions and GET /sessions/:id, and
 * the GET /sessions/:id/alive probe (200 alive / 410 dead / 404 unknown).
 *
 * Regression context: a consumer's revive logic treated `res.ok` on
 * GET /sessions/:id as liveness. The record exists even after an
 * out-of-band kill (status "killed"), so the consumer saw a corpse as
 * alive and reported a successful resume that resumed nothing. This suite
 * pins the contract: 200 on /sessions/:id means the record exists; liveness
 * is `alive` (or the /alive probe, which escalates to 410 when dead).
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

describe("session liveness — alive field + GET /sessions/:id/alive", () => {
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

  /** Kill OUT OF BAND via the registry's kill path — not a graceful close. */
  function spawnKilled(registry: ReturnType<typeof reg>): string {
    const id = spawnLive(registry)
    registry.kill(id)
    return id
  }

  function base(http: RuntimeHttpServerHandle): string {
    return `http://127.0.0.1:${http.url.split(":").pop()}`
  }

  it("a killed session is still a 200 record with status killed and alive:false", async () => {
    const registry = reg()
    const dead = spawnKilled(registry)
    const http = await start(registry)
    try {
      const res = await fetch(`${base(http)}/sessions/${dead}`)
      expect(res.status).toBe(200)
      const desc = (await res.json()) as { status: string; alive: boolean }
      expect(desc.status).toBe("killed")
      expect(desc.alive).toBe(false)
    } finally {
      await http.stop()
    }
  })

  it("GET /sessions/:id/alive returns 410 Gone for a dead record and 200 for a live one", async () => {
    const registry = reg()
    const dead = spawnKilled(registry)
    const live = spawnLive(registry)
    const http = await start(registry)
    try {
      const deadRes = await fetch(`${base(http)}/sessions/${dead}/alive`)
      expect(deadRes.status).toBe(410)
      const deadBody = (await deadRes.json()) as { alive: boolean; status: string }
      expect(deadBody).toEqual({ alive: false, status: "killed" })

      const liveRes = await fetch(`${base(http)}/sessions/${live}/alive`)
      expect(liveRes.status).toBe(200)
      const liveBody = (await liveRes.json()) as { alive: boolean; status: string }
      expect(liveBody.alive).toBe(true)
      expect(liveBody.status).toBe("running")
    } finally {
      await http.stop()
    }
  })

  it("an alive session returns 200 on /sessions/:id with alive:true", async () => {
    const registry = reg()
    const live = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await fetch(`${base(http)}/sessions/${live}`)
      expect(res.status).toBe(200)
      const desc = (await res.json()) as { status: string; alive: boolean }
      expect(desc.status).toBe("running")
      expect(desc.alive).toBe(true)
    } finally {
      await http.stop()
    }
  })

  it("GET /sessions marks alive:false on killed rows and alive:true on live ones", async () => {
    const registry = reg()
    const dead = spawnKilled(registry)
    const live = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await fetch(`${base(http)}/sessions`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        sessions: { id: string; alive: boolean }[]
      }
      const byId = new Map(body.sessions.map(s => [s.id, s.alive]))
      expect(byId.get(dead)).toBe(false)
      expect(byId.get(live)).toBe(true)
    } finally {
      await http.stop()
    }
  })

  it("404 for an unknown id on both routes", async () => {
    const registry = reg()
    const http = await start(registry)
    try {
      const detail = await fetch(`${base(http)}/sessions/nope`)
      expect(detail.status).toBe(404)
      const probe = await fetch(`${base(http)}/sessions/nope/alive`)
      expect(probe.status).toBe(404)
    } finally {
      await http.stop()
    }
  })
})