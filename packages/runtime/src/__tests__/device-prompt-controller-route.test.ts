/**
 * POST /devices/:id/sessions/:sessionId/prompt (BOOTSTRAP P4 item 1) — the
 * controller-side REST twin of the `device_prompt` MCP tool, over the real
 * REST layer via `startHttpServer` with stub pairing/host registries (the
 * E2E channel itself is exercised in host-registry.test.ts; here the forward
 * target is scripted).
 */

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { ForwardHttpRequest, ForwardHttpResponse, HostRegistry } from "../host-registry.js"
import type { PairingRegistry } from "../pairing-registry.js"

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

const emptyPairings = {
  list: async () => [],
  rename: async () => false,
  revoke: async () => false,
  isOnline: () => false,
} as unknown as PairingRegistry

/** Scripted host registry: each `forwardHttp` call runs the next responder. */
function fakeHosts(responders: Array<(req: ForwardHttpRequest) => ForwardHttpResponse>): {
  hosts: HostRegistry
  forwards: ForwardHttpRequest[]
} {
  const forwards: ForwardHttpRequest[] = []
  let i = 0
  const hosts = {
    forwardHttp: async (_id: string, req: ForwardHttpRequest) => {
      forwards.push(req)
      const responder = responders[Math.min(i, responders.length - 1)]!
      i++
      return responder(req)
    },
  } as unknown as HostRegistry
  return { hosts, forwards }
}

function jsonRes(status: number, body: unknown): ForwardHttpResponse {
  return { status, headers: {}, body: new Uint8Array(Buffer.from(JSON.stringify(body))) }
}

async function withServer(
  hosts: HostRegistry,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    pairings: emptyPairings,
    hostRegistry: hosts,
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

describe("POST /devices/:id/sessions/:sessionId/prompt", () => {
  it("fire-and-forget: forwards to the host's /device-prompt route and relays 200 {ok:true}", async () => {
    const { hosts, forwards } = fakeHosts([() => jsonRes(202, { ok: true, id: "s1", queued: true })])
    await withServer(hosts, async base => {
      const res = await fetch(`${base}/devices/office-mac/sessions/s1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "go check X" }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true })
      expect(forwards).toHaveLength(1)
      expect(forwards[0]!.method).toBe("POST")
      expect(forwards[0]!.path).toBe("/device-prompt/s1?wait=false")
      expect(JSON.parse(Buffer.from(forwards[0]!.body!).toString("utf8"))).toEqual({
        prompt: "go check X",
        queue: true,
      })
    })
  })

  it("?wait=true polls the host descriptor until the turn drains", async () => {
    const { hosts, forwards } = fakeHosts([
      () => jsonRes(202, { ok: true, id: "s1", queued: true }),
      () => jsonRes(200, { id: "s1", alive: true, busy: true, promptQueue: [{ id: "q1" }] }),
      () => jsonRes(200, { id: "s1", alive: true, busy: false, promptQueue: [] }),
    ])
    await withServer(hosts, async base => {
      const res = await fetch(`${base}/devices/office-mac/sessions/s1/prompt?wait=true&waitPollMs=10`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true })
      expect(forwards).toHaveLength(3)
    })
  })

  it("the host's non-2xx refusal surfaces with its status", async () => {
    const { hosts } = fakeHosts([() => jsonRes(403, { error: "spawn_disabled", message: "not opted in" })])
    await withServer(hosts, async base => {
      const res = await fetch(`${base}/devices/office-mac/sessions/s1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ ok: false, message: "not opted in" })
    })
  })

  it("a non-host target surfaces the registry's refusal as ok:false", async () => {
    const hosts = {
      forwardHttp: async () => {
        throw new Error('no host matched "ghost"')
      },
    } as unknown as HostRegistry
    await withServer(hosts, async base => {
      const res = await fetch(`${base}/devices/ghost/sessions/s1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      })
      // The enqueue forward itself threw (unknown target) — the route
      // relays that as a 400 with the registry's message, not a hang.
      expect(res.status).toBe(400)
      const body = (await res.json()) as { ok: boolean; message: string }
      expect(body.ok).toBe(false)
      expect(body.message).toMatch(/no host matched/)
    })
  })
})
