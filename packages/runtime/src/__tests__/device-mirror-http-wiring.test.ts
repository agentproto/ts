/**
 * BOOTSTRAP P7b/P7a HTTP wiring — the session READ routes call the
 * `deviceMirrorSync` hook before reading, and the controller prompt route
 * resolves a controller session id via the wired session registry.
 */

import { describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { ForwardHttpRequest, ForwardHttpResponse, HostRegistry } from "../host-registry.js"
import type { PairingRegistry } from "../pairing-registry.js"
import type { SessionsRegistry } from "../sessions.js"

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

async function withServer(
  opts: Pick<RuntimeHttpServerOptions, "hostRegistry" | "sessions" | "deviceMirrorSync">,
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
    meta: { workspace: process.cwd(), registered: [] },
    ...opts,
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

describe("device-mirror read-path wiring (P7b)", () => {
  it("GET /sessions/:id + /output + /events call deviceMirrorSync before reading", async () => {
    const sync = vi.fn(async () => undefined)
    // A registry double: the descriptor read must still succeed.
    const sessions = {
      findByIdOrName: () => undefined,
      get: () => undefined,
      list: () => [],
      attach: () => undefined,
    } as unknown as SessionsRegistry
    await withServer({ deviceMirrorSync: sync, sessions }, async base => {
      await fetch(`${base}/sessions/sess_x1`)
      await fetch(`${base}/sessions/sess_x1/output?lastN=5`)
      await fetch(`${base}/sessions/sess_x1/events?since=0`)
      expect(sync).toHaveBeenCalledWith("sess_x1")
    })
  })

  it("a missing sync hook leaves the read paths unchanged", async () => {
    const sessions = {
      findByIdOrName: () => undefined,
      get: () => undefined,
    } as unknown as SessionsRegistry
    await withServer({ sessions }, async base => {
      const res = await fetch(`${base}/sessions/sess_nope`)
      expect(res.status).toBe(404)
    })
  })
})

describe("controller-id device prompt over HTTP (P7a)", () => {
  it("rewrites a controller id to its mapped host id and relays ok:true", async () => {
    const forwards: ForwardHttpRequest[] = []
    let i = 0
    const responders: Array<(req: ForwardHttpRequest) => ForwardHttpResponse> = [
      () => ({ status: 404, headers: {}, body: new Uint8Array(Buffer.from(JSON.stringify({ message: 'enqueuePrompt: no session "sess_c" "sess_c"' }))) }),
      () => ({ status: 202, headers: {}, body: new Uint8Array(Buffer.from(JSON.stringify({ ok: true }))) }),
    ]
    const hosts = {
      forwardHttp: async (_t: string, req: ForwardHttpRequest) => {
        forwards.push(req)
        return responders[i++ % responders.length]!(req)
      },
    } as unknown as HostRegistry
    const sessions = {
      findByIdOrName: (q: string) =>
        q === "sess_c" ? { id: "sess_c", hostSessionId: "sess_h", hostFingerprint: "fp1" } : undefined,
    } as unknown as SessionsRegistry
    await withServer({ hostRegistry: hosts, sessions }, async base => {
      const res = await fetch(`${base}/devices/fp1/sessions/sess_c/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "go on" }),
      })
      expect(await res.json()).toMatchObject({ ok: true })
      expect(forwards).toHaveLength(2)
      expect(forwards[1]!.path).toBe("/device-prompt/sess_h?wait=false")
    })
  })
})
