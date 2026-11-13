/**
 * Writes to `/remote/*` and `/tunnels*` take the same gate as the mutating
 * `/sessions/*` routes: per-boot token (or allowlisted Origin), no foreign
 * browser Origin, and a JSON content-type on POST / PUT / PATCH. GET routes
 * stay open.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry } from "../sessions.js"
import { TunnelRegistry } from "../tunnel-registry.js"
import { makeTunnelCredsStore } from "../tunnel-adapters.js"
import type { RemoteController } from "../remote-controller.js"
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

const conversations: ConversationStore = {
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
const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }
const TOKEN = "per-boot-token"
const authed = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

let dir: string
let prevHome: string | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentproto-remote-tunnels-auth-"))
  prevHome = process.env.AGENTPROTO_HOME
  process.env.AGENTPROTO_HOME = dir
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.AGENTPROTO_HOME
  else process.env.AGENTPROTO_HOME = prevHome
  await rm(dir, { recursive: true, force: true })
})

async function withServer(
  fn: (base: string, calls: { enable: number; disable: number }) => Promise<void>,
): Promise<void> {
  const sessions = createSessionsRegistry({ persist: false })
  const tunnels = new TunnelRegistry({ persistPath: join(dir, "tunnels.json"), workspace: dir })
  const calls = { enable: 0, disable: 0 }
  const remote = {
    status: () => ({ enabled: false }),
    enable: async () => {
      calls.enable++
      return { publicUrl: "https://example.test" }
    },
    disable: async () => {
      calls.disable++
      return { disabled: true }
    },
  } as unknown as RemoteController
  const port = await freePort()
  const opts: RuntimeHttpServerOptions = {
    port,
    token: TOKEN,
    auth: { mode: "bearer", token: "mcp-bearer" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations,
    events: createRuntimeEvents(),
    heartbeat,
    meta: { workspace: dir, registered: [] },
    sessions,
    resolveAgentAdapter: (async () => {
      throw new Error("unused")
    }) as never,
    tunnels,
    remote,
  }
  const http = await startHttpServer(opts)
  try {
    await fn(`http://127.0.0.1:${port}`, calls)
  } finally {
    await http.stop()
    sessions.shutdown()
    await tunnels.shutdown()
  }
}

const providerBody = JSON.stringify({
  provisionerUrl: "https://api.example.com",
  oidcIssuer: "https://auth.example.com",
  oidcClientId: "client-id",
})

describe("/remote/* writes", () => {
  it("refuses enable and disable without the token and does not call the controller", async () => {
    await withServer(async (base, calls) => {
      for (const path of ["/remote/enable", "/remote/disable"]) {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
        expect(res.status).toBe(401)
        const wrong = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { authorization: "Bearer nope", "content-type": "application/json" },
          body: "{}",
        })
        expect(wrong.status).toBe(401)
      }
      expect(calls).toEqual({ enable: 0, disable: 0 })
    })
  })

  it("refuses a foreign browser Origin even with a text/plain body", async () => {
    await withServer(async (base, calls) => {
      const res = await fetch(`${base}/remote/enable`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "text/plain" },
        body: "{}",
      })
      expect(res.status).toBe(403)
      expect(calls.enable).toBe(0)
    })
  })

  it("refuses a non-JSON content-type with the token", async () => {
    await withServer(async (base, calls) => {
      const res = await fetch(`${base}/remote/enable`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
        body: "{}",
      })
      expect(res.status).toBe(415)
      expect(calls.enable).toBe(0)
    })
  })

  it("accepts authenticated JSON writes; GET /remote/status stays open", async () => {
    await withServer(async (base, calls) => {
      expect((await fetch(`${base}/remote/status`)).status).toBe(200)
      expect((await fetch(`${base}/remote/enable`, { method: "POST", headers: authed, body: "{}" })).status).toBe(200)
      expect((await fetch(`${base}/remote/disable`, { method: "POST", headers: authed, body: "{}" })).status).toBe(200)
      expect(calls).toEqual({ enable: 1, disable: 1 })
    })
  })
})

describe("/tunnels* writes", () => {
  it("refuses unauthenticated and wrong-token writes; nothing is stored or created", async () => {
    await withServer(async base => {
      const create = await fetch(`${base}/tunnels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetPort: 3000 }),
      })
      expect(create.status).toBe(401)
      const put = await fetch(`${base}/tunnels/providers/cloudflare-provisioned`, {
        method: "PUT",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: providerBody,
      })
      expect(put.status).toBe(401)
      const del = await fetch(`${base}/tunnels/some-id`, { method: "DELETE" })
      expect(del.status).toBe(401)
      const login = await fetch(`${base}/tunnels/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "cloudflare-provisioned" }),
      })
      expect(login.status).toBe(401)
      expect(await makeTunnelCredsStore(dir).read("cloudflare-provisioned")).toBeNull()
      const list = (await (await fetch(`${base}/tunnels`)).json()) as { tunnels: unknown[] }
      expect(list.tunnels).toEqual([])
    })
  })

  it("refuses a foreign browser Origin and a non-JSON content-type", async () => {
    await withServer(async base => {
      const foreign = await fetch(`${base}/tunnels/providers/cloudflare-provisioned`, {
        method: "PUT",
        headers: { origin: "https://evil.example", "content-type": "text/plain" },
        body: providerBody,
      })
      expect(foreign.status).toBe(403)
      const plain = await fetch(`${base}/tunnels/providers/cloudflare-provisioned`, {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
        body: providerBody,
      })
      expect(plain.status).toBe(415)
      expect(await makeTunnelCredsStore(dir).read("cloudflare-provisioned")).toBeNull()
    })
  })

  it("accepts authenticated JSON writes; GET /tunnels stays open", async () => {
    await withServer(async base => {
      expect((await fetch(`${base}/tunnels`)).status).toBe(200)
      const put = await fetch(`${base}/tunnels/providers/cloudflare-provisioned`, {
        method: "PUT",
        headers: authed,
        body: providerBody,
      })
      expect(put.status).toBe(200)
      expect(await makeTunnelCredsStore(dir).read("cloudflare-provisioned")).toMatchObject({ oidcClientId: "client-id" })
    })
  })
})
