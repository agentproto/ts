/**
 * `POST /cron` REST route — the operator creation path used by
 * `agentproto cron add`, hooks and desktop. It records the operator as the
 * job's creator, even though the route carries no session identity.
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
  async function withServer(fn: (base: string, scheduler: CronScheduler) => Promise<void>): Promise<void> {
    const port = await freePort()
    const workspace = mkdtempSync(join(tmpdir(), "cron-http-"))
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const cronScheduler = createCronScheduler({ sessionEvents, registry, workspace })

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schedule: "0 9 * * *",
          action: { kind: "tool", tool: "worktree_gc" },
        }),
      })
      expect(res.status).toBe(201)
      const job = (await res.json()) as { id: string; createdBy?: unknown }
      expect(job.createdBy).toEqual({ kind: "operator" })
      expect(scheduler.get(job.id)?.createdBy).toEqual({ kind: "operator" })
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
