/**
 * POST /inbound/:slug interception of Telegram permission taps. A tap is
 * consulted only on a SIGNED telegram endpoint whose alias matches the
 * bridge; everything else routes exactly as before.
 */

import { describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { createInboundEndpointStore } from "../inbound-endpoints.js"

const SECRET = "tg-webhook-secret"
const TAP = { update_id: 1, callback_query: { id: "c", data: "perm:abc:a", from: { id: 1 }, message: { message_id: 5, chat: { id: 7 } } } }
const TEXT = { update_id: 2, message: { message_id: 6, text: "hello", chat: { id: 7, type: "private" }, from: { id: 1, is_bot: false } } }

function setup(over: { secret?: string; alias?: string; handled?: boolean } = {}) {
  const store = createInboundEndpointStore({ persist: false })
  store.upsert({
    slug: "tg",
    provider: "telegram",
    alias: over.alias ?? "default",
    mode: "route-or-spawn",
    ...("secret" in over ? (over.secret ? { secret: over.secret } : {}) : { secret: SECRET }),
  })
  const handleUpdate = vi.fn(async (u: unknown) => ({
    handled: over.handled ?? Boolean((u as { callback_query?: unknown }).callback_query),
  }))
  const routeInboundMessage = vi.fn(async () => ({ action: "routed" as const, sessionId: "s1" }))
  return { store, handleUpdate, routeInboundMessage }
}

async function withServer(
  s: ReturnType<typeof setup>,
  fn: (base: string) => Promise<void>,
  opts: { token?: string } = {},
) {
  const port = await new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    ...(opts.token ? { token: opts.token } : {}),
    endpointStore: s.store,
    routeInboundMessage: s.routeInboundMessage,
    permissionCallbacks: { alias: "default", handleUpdate: s.handleUpdate },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: {
      async open() {},
      async appendTurn() {},
      async read() {
        return { meta: {} as never, turns: [] }
      },
      async list() {
        return []
      },
      pathFor: (id: string) => id,
    } as ConversationStore,
    events: createRuntimeEvents(),
    heartbeat: { start() {}, stop() {}, async fireNow() {} } as HeartbeatRunner,
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

const post = (base: string, body: unknown, secret: string | null = SECRET) =>
  fetch(`${base}/inbound/tg`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    body: JSON.stringify(body),
  })

describe("telegram permission taps on /inbound/:slug", () => {
  it("hands a signed tap to the bridge and does not route it", async () => {
    const s = setup()
    await withServer(s, async base => {
      const res = await post(base, TAP)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ action: "permission_callback" })
      expect(s.handleUpdate).toHaveBeenCalledWith(TAP)
      expect(s.routeInboundMessage).not.toHaveBeenCalled()
    })
  })

  it("lets an ordinary message continue to inbound routing", async () => {
    const s = setup()
    await withServer(s, async base => {
      const res = await post(base, TEXT)
      expect(res.status).toBe(200)
      expect(s.routeInboundMessage).toHaveBeenCalledTimes(1)
    })
  })

  it("rejects a bad webhook secret before the bridge sees anything", async () => {
    const s = setup()
    await withServer(s, async base => {
      const res = await post(base, TAP, "wrong")
      expect(res.status).toBe(401)
      expect(s.handleUpdate).not.toHaveBeenCalled()
    })
  })

  it("never consults the bridge on an unsigned endpoint", async () => {
    const s = setup({ secret: "" })
    await withServer(
      s,
      async base => {
        await fetch(`${base}/inbound/tg`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer t" },
          body: JSON.stringify(TAP),
        })
        expect(s.handleUpdate).not.toHaveBeenCalled()
      },
      { token: "t" },
    )
  })

  it("never consults the bridge for another bot alias", async () => {
    const s = setup({ alias: "other" })
    await withServer(s, async base => {
      await post(base, TAP)
      expect(s.handleUpdate).not.toHaveBeenCalled()
    })
  })
})
