/**
 * `POST /relay/parent-message` through the real REST layer
 * (`startHttpServer`): the tunnel-bearer exemption (the route authenticates
 * itself with the per-session relay token, exactly like `/inbound/:slug`
 * authenticates with its own HMAC) and the route's own token gate.
 */

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { mintParentRelayGrant, PARENT_RELAY_PATH, PARENT_RELAY_TOKEN_HEADER } from "../parent-relay.js"

const TOKEN = "tunnel-bearer-token"

async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve))
  const port = (srv.address() as AddressInfo).port
  await new Promise<void>(resolve => srv.close(() => resolve()))
  return port
}

function noopConversations(): ConversationStore {
  return {
    append: async () => {},
    read: async () => [],
    list: async () => [],
  } as unknown as ConversationStore
}

function noopHeartbeat(): HeartbeatRunner {
  return { tick: async () => {}, start: () => {}, stop: () => {} } as unknown as HeartbeatRunner
}

async function setup(opts?: { auth?: "none" | "bearer" }) {
  const registry: SessionsRegistry = createSessionsRegistry({ persist: false })
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: opts?.auth === "bearer" ? { mode: "bearer", token: TOKEN } : { mode: "none" },
    sessions: registry,
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  const post = (
    path: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }).then(async res => ({ status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }))
  return { registry, port, post, stop: () => http.stop() }
}

describe("POST /relay/parent-message", () => {
  it("bearer mode: the route is exempt from the tunnel bearer (the relay token authenticates it), and an absent/unknown relay token is refused", async () => {
    const s = await setup({ auth: "bearer" })
    try {
      const proxied = { "x-forwarded-for": "140.82.115.10" }

      // Control: an ordinary route is still refused by the tunnel-bearer gate.
      const control = await s.post("/sessions/agent", "{}", { ...proxied })
      expect(control.status).toBe(401)
      expect(control.json.error).toBe("tunnel_unauthorized")

      // The relay route: NOT tunnel_unauthorized (it is exempt), but the
      // route's own token gate refuses the request.
      const noToken = await s.post(PARENT_RELAY_PATH, JSON.stringify({ message: "hi" }), { ...proxied })
      expect(noToken.status).toBe(401)
      expect(noToken.json.error).toBe("relay_token_missing")

      const badToken = await s.post(
        PARENT_RELAY_PATH,
        JSON.stringify({ message: "hi" }),
        { ...proxied, [PARENT_RELAY_TOKEN_HEADER]: "not-a-real-token" },
      )
      expect(badToken.status).toBe(401)
      expect(badToken.json.error).toBe("relay_token_unknown")
    } finally {
      await s.stop()
    }
  })

  it("a valid relay token is accepted without the daemon bearer (the box only carries the relay token)", async () => {
    const s = await setup({ auth: "bearer" })
    try {
      const parent = s.registry.spawnAgent({
        workspaceSlug: "w",
        cwd: "/tmp",
        agentSession: {
          sessionId: "acp_relay",
          // eslint-disable-next-line require-yield
          async *send() {},
          async cancel() {},
          async close() {},
        },
        adapterSlug: "mock",
        depth: 0,
      })
      const remote = mintParentRelayGrant({
        parentSessionId: parent.id,
        boxSessionId: "sess_box",
        url: "https://host.example",
      })
      const res = await s.post(
        PARENT_RELAY_PATH,
        JSON.stringify({ message: "report from the box", kind: "report", urgency: "next-turn" }),
        { "x-forwarded-for": "140.82.115.10", [PARENT_RELAY_TOKEN_HEADER]: remote.token },
      )
      expect(res.status).toBe(200)
      expect(res.json).toMatchObject({ ok: true })
    } finally {
      await s.stop()
    }
  })
})
