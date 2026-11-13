/**
 * `POST /cron` REST route — the operator creation path used by
 * `agentproto cron add`. It records the operator as the job's creator, even
 * though the route carries no session identity. Writes need the per-boot
 * token, a JSON content-type and a non-foreign browser Origin.
 * Exercises the real REST layer via `startHttpServer`, same pattern as
 * routines-http-routes.test.ts.
 */

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createCronScheduler, type CronScheduler } from "../cron-scheduler.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

describe("/cron REST route", () => {
  const TOKEN = "cron-test-token"
  const authed = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }
  const jobBody = JSON.stringify({
    schedule: "0 9 * * *",
    action: { kind: "tool", tool: "worktree_gc" },
  })

  async function withServer(fn: (base: string, scheduler: CronScheduler) => Promise<void>): Promise<void> {
    const port = await freePort()
    const workspace = mkdtempSync(join(tmpdir(), "cron-http-"))
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const cronScheduler = createCronScheduler({ sessionEvents, registry, workspace })

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      token: TOKEN,
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      cronScheduler,
    })
    try {
      await fn(`http://127.0.0.1:${port}`, cronScheduler)
    } finally {
      await http.stop()
      cronScheduler.shutdown()
      rmSync(workspace, { recursive: true, force: true })
    }
  }

  it("POST /cron records an operator-created job with createdBy {kind:operator}", async () => {
    await withServer(async (base, scheduler) => {
      const res = await fetch(`${base}/cron`, {
        method: "POST",
        headers: authed,
        body: jobBody,
      })
      expect(res.status).toBe(201)
      const job = (await res.json()) as { id: string; createdBy?: unknown }
      expect(job.createdBy).toEqual({ kind: "operator" })
      expect(scheduler.get(job.id)?.createdBy).toEqual({ kind: "operator" })
    })
  })

  it("refuses unauthenticated writes (no token) and leaves the scheduler untouched", async () => {
    await withServer(async (base, scheduler) => {
      const seed = await scheduler.create({
        schedule: "0 9 * * *",
        action: { kind: "tool", tool: "worktree_gc" },
        createdBy: { kind: "operator" },
      })
      const json = { "content-type": "application/json" }
      const create = await fetch(`${base}/cron`, { method: "POST", headers: json, body: jobBody })
      const run = await fetch(`${base}/cron/${seed.id}/run`, { method: "POST", headers: json, body: "{}" })
      const patch = await fetch(`${base}/cron/${seed.id}`, { method: "PATCH", headers: json, body: '{"active":false}' })
      const del = await fetch(`${base}/cron/${seed.id}`, { method: "DELETE" })
      expect([create.status, run.status, patch.status, del.status]).toEqual([401, 401, 401, 401])
      const wrong = await fetch(`${base}/cron`, {
        method: "POST",
        headers: { ...json, authorization: "Bearer nope" },
        body: jobBody,
      })
      expect(wrong.status).toBe(401)
      expect(scheduler.list().map(j => j.id)).toEqual([seed.id])
      expect(scheduler.get(seed.id)?.active).not.toBe(false)
    })
  })

  it("refuses a cross-origin text/plain POST (CSRF) without creating a job", async () => {
    await withServer(async (base, scheduler) => {
      const res = await fetch(`${base}/cron`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "text/plain" },
        body: jobBody,
      })
      expect(res.status).toBe(403)
      expect(scheduler.list()).toHaveLength(0)
    })
  })

  it("refuses an authenticated write whose content-type is not JSON", async () => {
    await withServer(async (base, scheduler) => {
      const res = await fetch(`${base}/cron`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
        body: jobBody,
      })
      expect(res.status).toBe(415)
      const none = await fetch(`${base}/cron`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: jobBody,
      })
      expect(none.status).toBe(415)
      expect(scheduler.list()).toHaveLength(0)
    })
  })

  it("accepts authenticated JSON for create, patch, run and delete; GET stays readable", async () => {
    await withServer(async (base, scheduler) => {
      const create = await fetch(`${base}/cron`, { method: "POST", headers: authed, body: jobBody })
      expect(create.status).toBe(201)
      const { id } = (await create.json()) as { id: string }
      const charset = await fetch(`${base}/cron/${id}`, {
        method: "PATCH",
        headers: { ...authed, "content-type": "application/json; charset=utf-8" },
        body: '{"active":false}',
      })
      expect(charset.status).toBe(200)
      expect(scheduler.get(id)?.active).toBe(false)
      const list = await fetch(`${base}/cron`)
      expect(list.status).toBe(200)
      const runs = await fetch(`${base}/cron/runs`)
      expect(runs.status).toBe(200)
      const del = await fetch(`${base}/cron/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } })
      expect(del.status).toBe(200)
      expect(scheduler.list()).toHaveLength(0)
    })
  })
})

// ── tiny stubs (mirror routines-http-routes.test.ts) ──

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
