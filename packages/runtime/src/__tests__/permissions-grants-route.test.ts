import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { DEFAULT_MESSAGING_DEFAULTS } from "../messaging-defaults.js"

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

describe("GET /permissions/grants", () => {
  it("reports the grants derived from the messaging switches and allowPromptFrom", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const s1 = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: idle("s1"),
      adapterSlug: "fake",
    })
    registry.setOperatorLabel(s1.id, "brain")
    registry.setPromptPolicy(s1.id, ["label:pygmalion-brain-persistent"])

    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: vi.fn(),
      commandPreview: "x",
    })
    const resolveMessagingDefaults = vi.fn(async () => ({
      ...DEFAULT_MESSAGING_DEFAULTS,
      allowSiblings: false,
      allowSameWorkspace: true,
      peerGroups: [] as string[][],
    }))
    const resolveOperatorDelegates = vi.fn(async () => ["label:ops"])

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
      resolveMessagingDefaults,
      resolveOperatorDelegates,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const base = `http://127.0.0.1:${port}`
    try {
      const res = await fetch(`${base}/permissions/grants`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        grants: Array<{
          source: string
          grant: { principal: string; actions: Array<{ action: string; scope?: string }> }
          sessionId?: string
        }>
        unmapped: Array<{ source: string; entry: string }>
        inputs: { allowSameWorkspace: boolean; peerBinding: string }
      }
      expect(body.inputs).toMatchObject({ allowSameWorkspace: true, peerBinding: "slug" })
      expect(body.grants.map(g => g.source)).toEqual([
        "defaults.messaging.allowSameWorkspace",
        "session.allowPromptFrom",
      ])
      expect(body.grants[1]).toMatchObject({
        sessionId: s1.id,
        grant: {
          principal: "session-label://pygmalion-brain-persistent",
          actions: [
            { action: "session:prompt", scope: "label:brain" },
            { action: "session:control", scope: "label:brain" },
          ],
        },
      })
      expect(body.unmapped).toEqual([
        expect.objectContaining({
          source: "defaults.tasks.operatorDelegates",
          entry: "label:ops",
        }),
      ])
      expect(resolveMessagingDefaults).toHaveBeenCalled()
      expect(resolveOperatorDelegates).toHaveBeenCalled()
    } finally {
      await http.stop()
    }
  })

  it("does not treat POST /permissions/grants as an approval", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: vi.fn(),
      commandPreview: "x",
    })
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
    try {
      const res = await fetch(`${base}/permissions/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(res.status).not.toBe(200)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("not_found")
    } finally {
      await http.stop()
    }
  })
})
