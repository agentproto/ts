/**
 * `POST /sessions/:id/retire` — request/response contract (Lane B / Pygmalion
 * calls this route to migrate a brain's wiring to its replacement).
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
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

const noopConversations = (): ConversationStore => ({
  async open() {},
  async appendTurn() {},
  async read() {
    return { meta: {} as never, turns: [] }
  },
  async list() {
    return []
  },
  pathFor: (id: string) => id,
})

const noopHeartbeat = (): HeartbeatRunner => ({ start() {}, stop() {}, async fireNow() {} })

async function mcpServerFactory() {
  const { createMcpServer } = await import("@agentproto/mcp-server")
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const resolveAgentAdapter: AgentAdapterResolver = async () => ({
  async startSession() {
    throw new Error("not used in this test")
  },
  commandPreview: "mock-adapter",
})

const idleSession = (): AgentSessionLike => ({
  sessionId: "idle",
  async *send() {},
  async cancel() {},
  async close() {},
})

describe("POST /sessions/:id/retire", () => {
  let stop: (() => Promise<void>) | undefined
  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  async function withServer(
    run: (call: (id: string, body?: unknown) => Promise<{ status: number; body: any }>, reg: SessionsRegistry, port: number) => Promise<void>,
  ): Promise<void> {
    const reg = createSessionsRegistry({ persist: false })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: reg,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    stop = () => http.stop()
    const call = async (id: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${id}/retire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, body: await res.json() }
    }
    await run(call, reg, port)
  }

  const spawn = (reg: SessionsRegistry, name: string) =>
    reg.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", adapterSlug: "fake", label: name, agentSession: idleSession() })

  it("retires an alive row with a successor (by name): 200 shape, row superseded, summary exposes retiredAt + continuedTo", async () => {
    await withServer(async (call, reg, port) => {
      const old = spawn(reg, "old-brain")
      const next = spawn(reg, "new-brain")
      reg.get(next.id)!.name = "new-brain"
      const res = await call(old.id, { successor: "new-brain" })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        ok: true,
        id: old.id,
        killed: true,
        retiredAt: expect.any(String),
        endedReason: "operator-stopped",
        continuedTo: next.id,
      })
      expect(reg.get(old.id)?.status).toBe("killed")

      const list = await (await fetch(`http://127.0.0.1:${port}/sessions/summaries?includeArchived=true`)).json() as {
        summaries: Array<{ id: string; retiredAt?: string; continuedTo?: string }>
      }
      const row = list.summaries.find(r => r.id === old.id)
      expect(row?.continuedTo).toBe(next.id)
      expect(row?.retiredAt).toEqual(expect.any(String))
    })
  })

  it("is idempotent and works on a terminal row; reason: completed maps to operator-completed", async () => {
    await withServer(async (call, reg) => {
      const old = spawn(reg, "o")
      const next = spawn(reg, "n")
      reg.kill(old.id, undefined, "idle-reaped")
      const first = await call(old.id, { successor: next.id, reason: "completed" })
      expect(first.status).toBe(200)
      expect(first.body).toMatchObject({ ok: true, killed: false, continuedTo: next.id })
      const second = await call(old.id, { successor: next.id })
      expect(second.status).toBe(200)
      expect(second.body).toMatchObject({ ok: true, killed: false, continuedTo: next.id })
    })
  })

  it("no body → retires without a successor", async () => {
    await withServer(async (call, reg) => {
      const old = spawn(reg, "o")
      const res = await call(old.id)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.continuedTo).toBeUndefined()
      expect(reg.get(old.id)?.retiredAt).toEqual(expect.any(String))
    })
  })

  it("error contract: 404 session_not_found / successor_not_found, 400 invalid_successor / successor_cycle / invalid_body", async () => {
    await withServer(async (call, reg) => {
      const a = spawn(reg, "a")
      const b = spawn(reg, "b")
      expect(await call("sess_ghost")).toMatchObject({ status: 404, body: { error: "session_not_found" } })
      expect(await call(a.id, { successor: "ghost" })).toMatchObject({ status: 404, body: { error: "successor_not_found" } })
      expect(await call(a.id, { successor: a.id })).toMatchObject({ status: 400, body: { error: "invalid_successor" } })
      expect(await call(a.id, { successor: 7 })).toMatchObject({ status: 400, body: { error: "invalid_body" } })
      expect(await call(a.id, { reason: 7 })).toMatchObject({ status: 400, body: { error: "invalid_body" } })
      expect((await call(a.id, { successor: b.id })).status).toBe(200)
      expect(await call(b.id, { successor: a.id })).toMatchObject({ status: 400, body: { error: "successor_cycle" } })
    })
  })
})
