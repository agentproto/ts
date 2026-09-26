/**
 * `GET /sessions`'s strong ETag / `if-none-match` conditional-GET support
 * (BRIEF-D deliverable 4) and the optional `?since=` delta (deliverable 5).
 * Reuses the `strongEtag`/`ifNoneMatchHits` conventions PR #1419 introduced
 * in app-ui-delivery.ts — see that module for the header semantics.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

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

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {}) // never resolves — keeps the session "running"
    },
    async cancel() {},
    async close() {},
  }
}

describe("GET /sessions — strong etag + if-none-match + ?since delta", () => {
  let stopServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stopServer?.()
    stopServer = undefined
  })

  async function withServer(
    run: (port: number, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>,
  ): Promise<void> {
    const registry = createSessionsRegistry({ persist: false })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    stopServer = () => http.stop()
    try {
      await run(port, registry)
    } finally {
      await http.stop()
      stopServer = undefined
    }
  }

  it("serves a strong etag on 200, stable across identical repeats", async () => {
    await withServer(async port => {
      const res1 = await fetch(`http://127.0.0.1:${port}/sessions`)
      expect(res1.status).toBe(200)
      const etag1 = res1.headers.get("etag")
      expect(etag1).toBeTruthy()
      expect(etag1).toMatch(/^"[A-Za-z0-9_-]+"$/)
      await res1.text() // drain

      const res2 = await fetch(`http://127.0.0.1:${port}/sessions`)
      expect(res2.status).toBe(200)
      expect(res2.headers.get("etag")).toBe(etag1)
    })
  })

  it("304s with an empty body when if-none-match matches, and keeps the etag stable", async () => {
    await withServer(async (port, registry) => {
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })

      const res1 = await fetch(`http://127.0.0.1:${port}/sessions`)
      const etag = res1.headers.get("etag")
      expect(etag).toBeTruthy()
      await res1.text()

      const res2 = await fetch(`http://127.0.0.1:${port}/sessions`, {
        headers: { "if-none-match": etag! },
      })
      expect(res2.status).toBe(304)
      expect(res2.headers.get("etag")).toBe(etag)
      const body = await res2.text()
      expect(body).toBe("")
    })
  })

  it("changes the etag when a listed session's lastActivityAt changes", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })

      const res1 = await fetch(`http://127.0.0.1:${port}/sessions`)
      const etag1 = res1.headers.get("etag")
      await res1.text()

      registry.pulseActivity(desc.id)

      const res2 = await fetch(`http://127.0.0.1:${port}/sessions`)
      expect(res2.status).toBe(200)
      expect(res2.headers.get("etag")).not.toBe(etag1)

      // A request carrying the now-stale etag no longer 304s.
      const res3 = await fetch(`http://127.0.0.1:${port}/sessions`, {
        headers: { "if-none-match": etag1! },
      })
      expect(res3.status).toBe(200)
    })
  })

  it("changes the etag when a listed session's busy flag changes", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
      expect(desc.busy).toBeFalsy()

      const res1 = await fetch(`http://127.0.0.1:${port}/sessions`)
      const etag1 = res1.headers.get("etag")
      await res1.text()

      const rt = registry.get(desc.id)
      expect(rt).toBeTruthy()
      // Flip busy directly (mirrors how a live turn marks the descriptor —
      // no public setter exists purely for tests) and confirm the etag
      // tracks it, per the brief's explicit contract for this field.
      ;(rt as { busy?: boolean }).busy = true

      const res2 = await fetch(`http://127.0.0.1:${port}/sessions`)
      expect(res2.status).toBe(200)
      expect(res2.headers.get("etag")).not.toBe(etag1)
    })
  })

  it("400s on an unparseable ?since", async () => {
    await withServer(async port => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions?since=not-a-date`)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("invalid_since")
    })
  })

  it("?since returns only rows changed at/after the timestamp, with the rest omitted", async () => {
    await withServer(async (port, registry) => {
      const first = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })

      // Snapshot AFTER creating the first session, then create a second one
      // (activity strictly after the checkpoint) and touch the first one
      // again — both should show up in the delta.
      const checkpoint = new Date(Date.now() + 5).toISOString()
      await new Promise(r => setTimeout(r, 10))

      const second = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
      registry.pulseActivity(first.id)

      const res = await fetch(`http://127.0.0.1:${port}/sessions?since=${encodeURIComponent(checkpoint)}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sessions: Array<{ id: string }>; removed: string[] }
      const ids = body.sessions.map(s => s.id)
      expect(ids).toContain(first.id)
      expect(ids).toContain(second.id)
      expect(body.removed).toEqual([])
    })
  })

  it("?since reports archived sessions in `removed`", async () => {
    await withServer(async (port, registry) => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession("agent"),
        adapterSlug: "fake",
      })
      await registry.interruptSession(desc.id).catch(() => {})
      // Force the session terminal so it's archivable, mirroring how a
      // real run ends (exit event flips status away from running/starting).
      const rt = registry.get(desc.id)
      expect(rt).toBeTruthy()
      ;(rt as { status: string }).status = "exited"
      registry.archiveSession(desc.id)

      const since = new Date(0).toISOString()
      const res = await fetch(`http://127.0.0.1:${port}/sessions?since=${encodeURIComponent(since)}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sessions: Array<{ id: string }>; removed: string[] }
      expect(body.removed).toContain(desc.id)
      expect(body.sessions.map(s => s.id)).not.toContain(desc.id)
    })
  })
})
