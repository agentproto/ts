/**
 * `GET /reactions` REST route: reaction runner health plus the wiring accessor,
 * 404 when not wired, and GET only. Real HTTP layer via startHttpServer.
 */

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { ReactionHealth } from "../action-hooks/reaction-runner.js"

const health: ReactionHealth = {
  generatedAt: 123,
  started: true,
  maxReactionDepth: 4,
  maxConcurrent: 4,
  bindings: [],
  orphans: [],
  totals: { receipts: 0, pending: 0, running: 0, failed: 0, done: 0, dead: 0 },
}

describe("/reactions REST route", () => {
  async function withServer(
    fn: (base: string) => Promise<void>,
    opts: { withReactions?: boolean } = {},
  ): Promise<void> {
    const { withReactions = true } = opts
    const port = await freePort()
    const reactions = withReactions
      ? { health: () => health, wiring: () => ({ active: ["bind-1"], refused: [{ bindingId: "bind-2", error: "nope" }] }) }
      : undefined

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      ...(reactions ? { reactions } : {}),
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("returns health and wiring on GET, 404s without the option and never answers a POST with 200", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/reactions`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as ReactionHealth & {
        wiring: { active: string[]; refused: Array<{ bindingId: string; error: string }> }
      }
      expect(body).toEqual({
        ...health,
        wiring: { active: ["bind-1"], refused: [{ bindingId: "bind-2", error: "nope" }] },
      })

      const post = await fetch(`${base}/reactions`, { method: "POST" })
      expect(post.status).not.toBe(200)
    })

    await withServer(
      async base => {
        const res = await fetch(`${base}/reactions`)
        expect(res.status).toBe(404)
      },
      { withReactions: false },
    )
  })
})

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
