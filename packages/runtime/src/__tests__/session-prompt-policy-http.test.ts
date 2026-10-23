/**
 * HTTP-level coverage for `POST /sessions/:id/prompt-policy` (http-server.ts)
 * — the transport twin of the `agent_set_prompt_policy` MCP tool, and the
 * only way a non-MCP caller (Pygmalion's `EngineClient`, notably) can
 * (re-)grant `allowPromptFrom` on a session that is ALREADY LIVE: unlike the
 * spawn-time field, this reaches a permanent `keepAlive` agent that was
 * already running before the grant existed.
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

describe("POST /sessions/:id/prompt-policy — HTTP route", () => {
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
    return fetch(`http://127.0.0.1:${http.url.split(":").pop()}/sessions/${id}/prompt-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("grants allowPromptFrom on an already-live session — returns {ok, sessionId, allowPromptFrom} and updates the registry", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await post(http, id, { allowPromptFrom: ["label:pygmalion-brain-persistent"] })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; sessionId: string; allowPromptFrom: string[] }
      expect(body).toEqual({ ok: true, sessionId: id, allowPromptFrom: ["label:pygmalion-brain-persistent"] })
      expect(registry.get(id)?.allowPromptFrom).toEqual(["label:pygmalion-brain-persistent"])
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("an empty array resets to owner+operator only", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    registry.setPromptPolicy(id, ["any"])
    const http = await start(registry)
    try {
      const res = await post(http, id, { allowPromptFrom: [] })
      expect(res.status).toBe(200)
      expect(registry.get(id)?.allowPromptFrom).toBeUndefined()
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("404s on an unknown session id", async () => {
    const registry = reg()
    const http = await start(registry)
    try {
      const res = await post(http, "sess_nope", { allowPromptFrom: ["any"] })
      expect(res.status).toBe(404)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })

  it("400s on a malformed allowPromptFrom value", async () => {
    const registry = reg()
    const id = spawnLive(registry)
    const http = await start(registry)
    try {
      const res = await post(http, id, { allowPromptFrom: { not: "an array" } })
      expect(res.status).toBe(400)
      expect(registry.get(id)?.allowPromptFrom).toBeUndefined()
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
