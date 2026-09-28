/**
 * Approvals HTTP twins (`approvals/http.ts`) — the `web_click` decision
 * route's origin/token gate, plus the non-MCP request/list/get/wait/
 * consume surface. Mirrors `pending-permissions.test.ts`'s REST-transport
 * `withServer` pattern (real `startHttpServer` on a random port, `fetch`).
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createRuntimeEvents } from "../events.js"
import { startHttpServer } from "../http-server.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

let home: string
let engine: ApprovalsEngine

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-http-"))
})

afterEach(() => {
  engine?.dispose()
  rmSync(home, { recursive: true, force: true })
})

const TOKEN = "test-daemon-token"
const ALLOWED_ORIGIN = "https://approve.example.invalid"

async function withServer(
  webOrigins: readonly string[],
  fn: (base: string, engine: ApprovalsEngine) => Promise<void>,
): Promise<void> {
  const bus = createSessionEventBus()
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: bus, webOrigins })
  const registry = createSessionsRegistry({ persist: false, transcriptDir: join(home, "sessions") })
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    token: TOKEN,
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: registry,
    meta: { workspace: process.cwd(), registered: [] },
    approvals: engine,
    approvalsWebOrigins: webOrigins,
  })
  try {
    await fn(`http://127.0.0.1:${port}`, engine)
  } finally {
    await http.stop()
    registry.shutdown()
  }
}

describe("Approvals HTTP: request / list / get / consume", () => {
  it("POST /approvals creates a pending request; GET /approvals/:id reads it back", async () => {
    await withServer([], async base => {
      const createRes = await fetch(`${base}/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "send", title: "Send invoice", preview: { to: "a@b.invalid" }, payload: { x: 1 } }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { id: string; status: string }
      expect(created.status).toBe("pending")

      const getRes = await fetch(`${base}/approvals/${created.id}`)
      expect(getRes.status).toBe(200)
      const got = (await getRes.json()) as { id: string; status: string }
      expect(got.id).toBe(created.id)

      const listRes = await fetch(`${base}/approvals?status=pending`)
      const list = (await listRes.json()) as { approvals: Array<{ id: string }> }
      expect(list.approvals.map(a => a.id)).toContain(created.id)
    })
  })

  it("GET /approvals/:id 404s on an unknown id", async () => {
    await withServer([], async base => {
      const res = await fetch(`${base}/approvals/apr_ghost`)
      expect(res.status).toBe(404)
    })
  })

  it("POST /approvals/:id/consume: not approved yet -> 409 approval_not_approved", async () => {
    await withServer([], async (base, engine) => {
      const record = engine.request(
        { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
        { operator: true },
      )
      const res = await fetch(`${base}/approvals/${record.id}/consume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { x: 1 } }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("approval_not_approved")
    })
  })

  it("GET /approvals/:id/wait resolves once decided", async () => {
    await withServer([ALLOWED_ORIGIN], async (base, engine) => {
      const record = engine.request(
        { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
        { operator: true },
      )
      const waitPromise = fetch(`${base}/approvals/${record.id}/wait?timeoutMs=5000`)
      await new Promise(r => setTimeout(r, 20))
      await engine.decideWeb(record.id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })
      const res = await waitPromise
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string }
      expect(body.status).toBe("approved")
    })
  })
})

describe("Approvals HTTP: web_click decision route — origin AND token required", () => {
  it("no Origin header -> 403, approval stays pending", async () => {
    await withServer([ALLOWED_ORIGIN], async (base, engine) => {
      const record = engine.request(
        { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
        { operator: true },
      )
      const res = await fetch(`${base}/approvals/${record.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(res.status).toBe(403)
      expect(engine.get(record.id)?.status).toBe("pending")
    })
  })

  it("a wrong Origin -> 403, approval stays pending", async () => {
    await withServer([ALLOWED_ORIGIN], async (base, engine) => {
      const record = engine.request(
        { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
        { operator: true },
      )
      const res = await fetch(`${base}/approvals/${record.id}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          origin: "https://evil.example.invalid",
        },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(res.status).toBe(403)
      expect(engine.get(record.id)?.status).toBe("pending")
    })
  })

  it("allowed Origin but no/bad token -> 401, approval stays pending", async () => {
    await withServer([ALLOWED_ORIGIN], async (base, engine) => {
      const record = engine.request(
        { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
        { operator: true },
      )
      const res = await fetch(`${base}/approvals/${record.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(res.status).toBe(401)
      expect(engine.get(record.id)?.status).toBe("pending")
    })
  })

  it("empty webOrigins config -> the channel is off, decision always 403s even with a valid token", async () => {
    await withServer([], async (base, engine) => {
      const record = engine.request(
        { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
        { operator: true },
      )
      const res = await fetch(`${base}/approvals/${record.id}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(res.status).toBe(403)
      expect(engine.get(record.id)?.status).toBe("pending")
    })
  })

  it("allowed Origin AND valid token -> decides", async () => {
    await withServer([ALLOWED_ORIGIN], async (base, engine) => {
      const record = engine.request(
        { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
        { operator: true },
      )
      const res = await fetch(`${base}/approvals/${record.id}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string; decision: { channel: string } }
      expect(body.status).toBe("approved")
      expect(body.decision.channel).toBe("web_click")
    })
  })
})

// ── tiny stubs (mirror pending-permissions.test.ts) ──

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
