/**
 * HTTP surface of the typed-message inbox (AIP-46 §Session messages):
 * `POST /sessions/:id/messages`, `GET /sessions/:id/inbox`,
 * `POST /sessions/:id/inbox/ack`.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
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

const conversations: ConversationStore = {
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
const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }

function idle(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    // eslint-disable-next-line require-yield
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
  }
}

describe("typed-message HTTP routes", () => {
  it("send as human / as a child (ACL), list the inbox, ack it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "inbox-http-"))
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const parent = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: idle("p"), adapterSlug: "fake" })
    const child = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: idle("c"),
      adapterSlug: "fake",
      parentSessionId: parent.id,
      depth: 1,
    })
    const stranger = registry.spawnAgent({ workspaceSlug: "w", cwd: "/tmp", agentSession: idle("s"), adapterSlug: "fake" })
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({ startSession: vi.fn(), commandPreview: "x" })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const base = `http://127.0.0.1:${port}`
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    try {
      // Human operator → fyi (no wake).
      const h = await post(`/sessions/${parent.id}/messages`, { text: "note from me", urgency: "fyi" })
      expect(h.status).toBe(200)
      const hb = (await h.json()) as { relation: string; messageId: string; delivered: { via: string } }
      expect(hb).toMatchObject({ relation: "human", delivered: { via: "inbox" } })

      // Child → parent via the trusted callerSessionId query.
      const c = await post(`/sessions/${parent.id}/messages?callerSessionId=${child.id}`, {
        text: "done",
        kind: "done",
        urgency: "fyi",
      })
      expect(c.status).toBe(200)
      expect(await c.json()).toMatchObject({ relation: "child" })

      // Stranger → parent: refused. A body `from` is refused outright.
      expect((await post(`/sessions/${parent.id}/messages?callerSessionId=${stranger.id}`, { text: "x" })).status).toBe(403)
      expect((await post(`/sessions/${parent.id}/messages`, { text: "x", from: { relation: "child" } })).status).toBe(400)
      expect((await post(`/sessions/${parent.id}/messages`, { text: "x", kind: "nope" })).status).toBe(400)

      const inbox = (await (await fetch(`${base}/sessions/${parent.id}/inbox`)).json()) as {
        inbox: Array<{ id: string; from: { relation: string } }>
      }
      expect(inbox.inbox.map(m => m.from.relation)).toEqual(["human", "child"])

      const ack = await post(`/sessions/${parent.id}/inbox/ack`, { ids: [hb.messageId] })
      expect(await ack.json()).toMatchObject({ acked: [hb.messageId] })
      const after = (await (await fetch(`${base}/sessions/${parent.id}/inbox`)).json()) as { inbox: unknown[] }
      expect(after.inbox).toHaveLength(1)
      expect((await post(`/sessions/${parent.id}/inbox/ack`, { ids: 3 })).status).toBe(400)
      expect((await fetch(`${base}/sessions/sess_nope/inbox`)).status).toBe(404)
    } finally {
      await http.stop()
      registry.shutdown()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
