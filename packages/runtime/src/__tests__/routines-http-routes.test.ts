/**
 * `GET /routines` REST route — answers from the AIP-41 registrar's
 * `list()` (routine DEFINITIONS from `.routines/*`). Exercises the real
 * REST layer via `startHttpServer`, same pattern as
 * user-presets-http-routes.test.ts.
 */

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { RoutineRegistrar } from "../routine-registrar.js"

function makeMockRegistrar(definitions: unknown[] = []): RoutineRegistrar {
  return {
    reconcile: () => ({ registered: [], skipped: [], removed: [], errors: [] }),
    trigger: async () => ({ ok: true, summary: "mock" }),
    list: () => definitions as ReturnType<RoutineRegistrar["list"]>,
  }
}

describe("/routines REST route", () => {
  async function withServer(
    fn: (base: string) => Promise<void>,
    opts: { withRegistrar?: boolean; definitions?: unknown[] } = {},
  ): Promise<void> {
    const { withRegistrar = true, definitions = [] } = opts
    const port = await freePort()
    const routineRegistrar = withRegistrar ? makeMockRegistrar(definitions) : undefined

    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      ...(routineRegistrar ? { routineRegistrar } : {}),
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("GET /routines returns registrar definitions", async () => {
    const definitions = [{ id: "daily-brief", enabled: true, schedule: { kind: "cron", cron: "0 9 * * *" } }]
    await withServer(
      async base => {
        const listRes = await fetch(`${base}/routines`)
        expect(listRes.status).toBe(200)
        const body = (await listRes.json()) as { routines: unknown[] }
        expect(body.routines).toEqual(definitions)
      },
      { definitions },
    )
  })

  it("GET /routines 404s when no registrar is wired", async () => {
    await withServer(
      async base => {
        const res = await fetch(`${base}/routines`)
        expect(res.status).toBe(404)
      },
      { withRegistrar: false },
    )
  })
})

// ── tiny stubs (mirror user-presets-http-routes.test.ts) ──

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
