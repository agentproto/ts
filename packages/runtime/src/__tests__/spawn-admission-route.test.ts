import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionsRegistry } from "../sessions.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import {
  recordSpawnAdmission,
  resetSpawnAdmissionCounters,
} from "../action-hooks/spawn-admission-counters.js"

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

describe("GET /spawn-admission", () => {
  it("reports the spawn admission counters and reflects a new event", async () => {
    resetSpawnAdmissionCounters()
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
      const res = await fetch(`${base}/spawn-admission`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        since: string
        total: number
        stages: Record<string, Record<string, number>>
        dedupeSources: Record<string, number>
        codes: Array<{ stage: string; outcome: string; code: string; count: number }>
      }
      expect(body.since).toEqual(expect.any(String))
      expect(body.total).toBe(0)
      expect(body.stages.claim).toEqual({ allow: 0, deny: 0, reuse: 0, defer: 0 })
      expect(body.dedupeSources).toEqual({ explicit: 0, implicit: 0, "worktree-cwd": 0 })
      expect(body.codes).toEqual([])

      recordSpawnAdmission({
        stage: "claim",
        decision: { outcome: "reuse", targetId: "SECRET_TARGET", code: "spawn_claim_hit" },
        dedupeSource: "explicit",
      })
      const after = (await (await fetch(`${base}/spawn-admission`)).json()) as typeof body
      expect(after.total).toBe(1)
      expect(after.stages.claim?.reuse).toBe(1)
      expect(after.dedupeSources.explicit).toBe(1)
      expect(after.codes).toEqual([
        { stage: "claim", outcome: "reuse", code: "spawn_claim_hit", count: 1 },
      ])
      expect(JSON.stringify(after)).not.toContain("SECRET_TARGET")
    } finally {
      await http.stop()
      resetSpawnAdmissionCounters()
    }
  })
})
