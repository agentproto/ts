/**
 * Push-ingress counterpart to inbound-watcher.ts's poll loop —
 * POST /inbound lets a caller (e.g. an agentpush webhook) inject a
 * human reply as a user turn without waiting on the 5s poll. Exercises
 * the real REST layer via `startHttpServer`, same pattern as
 * workspaces-http-routes.test.ts.
 */

import { describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { InboundMessage, InboundRouteMode } from "../inbound-router.js"
import { createInboundEndpointStore } from "../inbound-endpoints.js"

type ServerOpts = {
  token?: string
  endpointStore?: ReturnType<typeof createInboundEndpointStore>
  routeInboundMessage?: (
    msg: InboundMessage,
    mode: InboundRouteMode,
  ) => Promise<{
    action: "routed" | "spawned" | "restarted-routed" | "skipped"
    sessionId?: string
  }>
}

async function withServer(
  fn: (base: string) => Promise<void>,
  opts?: ServerOpts,
): Promise<void> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    ...(opts?.token ? { token: opts.token } : {}),
    ...(opts?.routeInboundMessage
      ? { routeInboundMessage: opts.routeInboundMessage }
      : {}),
    ...(opts?.endpointStore
      ? { endpointStore: opts.endpointStore }
      : {}),
    mcpServerFactory: async () =>
      (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

describe("POST /inbound — push ingress", () => {
  it("requires a bearer token", async () => {
    const TOKEN = "test-secret-token"
    const routeInboundMessage = vi.fn()
    await withServer(
      async base => {
        const res = await fetch(`${base}/inbound`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            alias: "tg",
            source: "phone1",
            contact_ref: "user1",
            text: "hi",
          }),
        })
        expect(res.status).toBe(401)
        expect(routeInboundMessage).not.toHaveBeenCalled()
      },
      { token: TOKEN, routeInboundMessage },
    )
  })

  it("routes a bound contact and returns 200 with the action", async () => {
    const TOKEN = "test-secret-token"
    const routeInboundMessage = vi.fn(async () => ({
      action: "routed" as const,
      sessionId: "s1",
    }))
    await withServer(
      async base => {
        const res = await fetch(`${base}/inbound`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({
            alias: "tg",
            source: "phone1",
            contact_ref: "user1",
            text: "hi",
          }),
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { action: string; sessionId?: string }
        expect(body).toEqual({ action: "routed", sessionId: "s1" })
        expect(routeInboundMessage).toHaveBeenCalledWith(
          {
            alias: "tg",
            source: "phone1",
            contactRef: "user1",
            text: "hi",
          },
          "route-or-spawn",
        )
      },
      { token: TOKEN, routeInboundMessage },
    )
  })

  it("400s when a required field is missing", async () => {
    const TOKEN = "test-secret-token"
    const routeInboundMessage = vi.fn()
    await withServer(
      async base => {
        const res = await fetch(`${base}/inbound`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({
            alias: "tg",
            source: "phone1",
            text: "hi",
          }),
        })
        expect(res.status).toBe(400)
        expect((await res.json()) as { error: string }).toMatchObject({
          error: "missing_contact_ref",
        })
        expect(routeInboundMessage).not.toHaveBeenCalled()
      },
      { token: TOKEN, routeInboundMessage },
    )
  })

  it("501s when routeInboundMessage isn't wired", async () => {
    const TOKEN = "test-secret-token"
    await withServer(
      async base => {
        const res = await fetch(`${base}/inbound`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({
            alias: "tg",
            source: "phone1",
            contact_ref: "user1",
            text: "hi",
          }),
        })
        expect(res.status).toBe(501)
        expect((await res.json()) as { error: string }).toMatchObject({
          error: "inbound_routing_not_configured",
        })
      },
      { token: TOKEN },
    )
  })
})

describe("POST /inbound/:slug — provider-agnostic push ingress", () => {
  it("404s when endpoint store is not wired", async () => {
    const routeInboundMessage = vi.fn()
    await withServer(
      async base => {
        const res = await fetch(`${base}/inbound/my-hook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        })
        expect(res.status).toBe(404)
        expect(routeInboundMessage).not.toHaveBeenCalled()
      },
      { routeInboundMessage },
    )
  })

  it("404s for unknown or disabled slug", async () => {
    const store = createInboundEndpointStore({ persist: false })
    store.upsert({
      slug: "enabled",
      provider: "generic",
      alias: "g",
      mode: "route-or-spawn",
    })
    store.upsert({
      slug: "disabled",
      provider: "generic",
      alias: "g",
      mode: "route-or-spawn",
      enabled: false,
    })
    await withServer(
      async base => {
        const unknown = await fetch(`${base}/inbound/missing`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        })
        expect(unknown.status).toBe(404)

        const disabled = await fetch(`${base}/inbound/disabled`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        })
        expect(disabled.status).toBe(404)
      },
      { endpointStore: store },
    )
  })

  it("routes a generic message and deduplicates by id", async () => {
    const store = createInboundEndpointStore({ persist: false })
    store.upsert({
      slug: "hook",
      provider: "generic",
      alias: "g",
      mode: "route-or-spawn",
    })
    const routeInboundMessage = vi.fn(async () => ({
      action: "spawned" as const,
      sessionId: "s1",
    }))
    await withServer(
      async base => {
        const first = await fetch(`${base}/inbound/hook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "src1",
            contact_ref: "u1",
            text: "hello",
            provider_message_id: "m1",
          }),
        })
        expect(first.status).toBe(200)
        expect(await first.json()).toEqual({ action: "spawned", sessionId: "s1" })
        expect(routeInboundMessage).toHaveBeenCalledWith(
          {
            alias: "g",
            source: "src1",
            contactRef: "u1",
            text: "hello",
          },
          "route-or-spawn",
        )

        const dup = await fetch(`${base}/inbound/hook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "src1",
            contact_ref: "u1",
            text: "hello",
            provider_message_id: "m1",
          }),
        })
        expect(dup.status).toBe(200)
        expect(await dup.json()).toEqual({ action: "duplicate" })
        expect(routeInboundMessage).toHaveBeenCalledTimes(1)
      },
      { endpointStore: store, routeInboundMessage },
    )
  })

  it("returns an agentpush challenge without routing", async () => {
    const store = createInboundEndpointStore({ persist: false })
    store.upsert({
      slug: "ap-hook",
      provider: "agentpush",
      alias: "ap",
      mode: "route-or-spawn",
    })
    const routeInboundMessage = vi.fn()
    await withServer(
      async base => {
        const res = await fetch(`${base}/inbound/ap-hook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challenge: "verify-me" }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ challenge: "verify-me" })
        expect(routeInboundMessage).not.toHaveBeenCalled()
      },
      { endpointStore: store, routeInboundMessage },
    )
  })

  it("routes a generic message when secret is not set", async () => {
    const TOKEN = "test-secret-token"
    const store = createInboundEndpointStore({ persist: false })
    store.upsert({
      slug: "hook",
      provider: "generic",
      alias: "g",
      mode: "route-or-spawn",
    })
    const routeInboundMessage = vi.fn(async () => ({
      action: "routed" as const,
      sessionId: "s1",
    }))
    await withServer(
      async base => {
        const res = await fetch(`${base}/inbound/hook`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({
            source: "src1",
            contact_ref: "u1",
            text: "hello",
          }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ action: "routed", sessionId: "s1" })
      },
      { token: TOKEN, endpointStore: store, routeInboundMessage },
    )
  })
})

// ── tiny stubs (mirror workspaces-http-routes.test.ts) ──

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
