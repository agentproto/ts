/**
 * Shadow signal routing over the daemon HTTP surface: `POST /sentinels`
 * (webhook-target branch) stamps the router's decision without changing the
 * provider, and `GET /sentinels/routes[/explain]` back `agentproto sentinel
 * routes`. Real HTTP layer via startHttpServer.
 */

import "../sentinel-platform.js"

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import {
  createFakeSentinelProvider,
  createSentinelStore,
  type SentinelProviderHandle,
  type SentinelRoute,
  type SentinelRouteLogLine,
} from "@agentproto/sentinel"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

function provider(slug: string, subjects: string[], ready: boolean | string = true): SentinelProviderHandle {
  return Object.assign(createFakeSentinelProvider({ slug, subjects }), {
    readiness: async () => (ready === true ? { ready: true } : { ready: false, reason: String(ready) }),
  })
}

/** agentpush unready, so the legacy chain lands on local-gh. */
const handles: Record<string, SentinelProviderHandle> = {
  agentpush: provider("agentpush", ["*"], "no agentpush API key"),
  "local-gh": provider("local-gh", ["github"]),
  session: provider("session", ["session"]),
}

async function withServer(routes: SentinelRoute[], fn: (base: string, log: SentinelRouteLogLine[]) => Promise<void>): Promise<void> {
  const port = await freePort()
  const log: SentinelRouteLogLine[] = []
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
    sentinels: {
      store: createSentinelStore({ persist: false }),
      resolveProvider: async slug => handles[slug] ?? null,
      isSessionAlive: () => true,
      routing: { config: () => ({ routes }), log: line => void log.push(line) },
      publicUrl: () => undefined,
    },
  })
  try {
    await fn(`http://127.0.0.1:${port}`, log)
  } finally {
    await http.stop()
  }
}

describe("sentinel routes over HTTP (shadow)", () => {
  // Plan test 3, shadow form: the webhook-target branch has no `session:`
  // special case, so today it lands on the chain (local-gh here). The router
  // resolves `session`; it is recorded, not applied.
  it("POST /sentinels webhook target with session:sess_x stamps routed=session, provider stays legacy", async () => {
    await withServer([], async (base, log) => {
      const res = await fetch(`${base}/sentinels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "session:sess_x", target: { kind: "webhook", url: "https://example.com/hook" } }),
      })
      expect(res.status).toBe(201)
      const view = (await res.json()) as { provider: string; route?: Record<string, unknown> }
      expect(view.provider).toBe("local-gh")
      expect(view.route).toMatchObject({ rule: "builtin:session", routed: "session", legacy: "local-gh", applied: false })
      expect(log).toEqual([expect.objectContaining({ site: "http", subject: "session:sess_x", routed: "session", legacy: "local-gh" })])
    })
  })

  it("GET /sentinels/routes lists the table and is not read as a sentinel id", async () => {
    await withServer([{ id: "gh-default", match: { subject: "github:*" }, via: ["local-gh"] }], async base => {
      const res = await fetch(`${base}/sentinels/routes`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { mode: string; routes: Array<{ id: string }> }
      expect(body.mode).toBe("shadow")
      expect(body.routes.map(r => r.id)).toEqual(["gh-default", "builtin:session", "builtin:github", "builtin:default"])
    })
  })

  it("GET /sentinels/routes/explain answers which provider for a subject and why", async () => {
    await withServer([], async base => {
      const res = await fetch(`${base}/sentinels/routes/explain?subject=${encodeURIComponent("telegram:x")}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        rule: "builtin:default",
        slug: null,
        error: "route_unavailable",
        walked: [{ provider: "agentpush", rejected: "unready: no agentpush API key" }],
      })
      expect((await fetch(`${base}/sentinels/routes/explain`)).status).toBe(400)
      expect((await fetch(`${base}/sentinels/routes/explain?subject=x&site=nope`)).status).toBe(400)
    })
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
