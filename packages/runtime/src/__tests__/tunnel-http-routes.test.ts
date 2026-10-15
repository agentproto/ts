/**
 * HTTP surface added for local UIs: `GET|POST /tunnels/login` and
 * `PUT /tunnels/providers/:slug` — 400 paths, storage, and the tunnel-auth
 * gate in front of the credential-writing route.
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
const BEARER = "routes-bearer"

let dir: string
let prevHome: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentproto-tunnel-routes-"))
  prevHome = process.env.AGENTPROTO_HOME
  process.env.AGENTPROTO_HOME = dir
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.AGENTPROTO_HOME
  else process.env.AGENTPROTO_HOME = prevHome
  await rm(dir, { recursive: true, force: true })
})

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const sessions = createSessionsRegistry({ persist: false })
  const tunnels = new TunnelRegistry({ persistPath: join(dir, "tunnels.json"), workspace: dir })
  const port = await freePort()
  const opts: RuntimeHttpServerOptions = {
    port,
    auth: { mode: "bearer", token: BEARER },
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
  }
  const http = await startHttpServer(opts)
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
    sessions.shutdown()
    await tunnels.shutdown()
  }
}

const json = { "content-type": "application/json" }

describe("tunnel HTTP routes", () => {
  it("GET /tunnels/login: 400 without slug or for a provider without login; never begins a login", async () => {
    await withServer(async base => {
      expect((await fetch(`${base}/tunnels/login`)).status).toBe(400)
      const named = await fetch(`${base}/tunnels/login?slug=cloudflare-named`)
      expect(named.status).toBe(400)
      expect(await named.json()).toEqual({ error: "provider 'cloudflare-named' has no login" })
      const unconfigured = await fetch(`${base}/tunnels/login?slug=cloudflare-provisioned`)
      expect(unconfigured.status).toBe(400)
      expect(((await unconfigured.json()) as { error: string }).error).toMatch(/not configured/)
    })
  })

  it("PUT /tunnels/providers/:slug: malformed slug 400, invalid fields 400, valid fields stored and never echoed", async () => {
    await withServer(async base => {
      const bad = await fetch(`${base}/tunnels/providers/%E0%A4%A`, { method: "PUT", headers: json, body: "{}" })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toMatchObject({ error: "bad_slug" })

      const insecure = await fetch(`${base}/tunnels/providers/cloudflare-provisioned`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ provisionerUrl: "http://api.example.com", oidcIssuer: "https://auth.example.com", oidcClientId: "c" }),
      })
      expect(insecure.status).toBe(400)

      const ok = await fetch(`${base}/tunnels/providers/cloudflare-provisioned`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ provisionerUrl: "https://api.example.com", oidcIssuer: "https://auth.example.com", oidcClientId: "client-secretish" }),
      })
      expect(ok.status).toBe(200)
      expect(await ok.text()).not.toContain("client-secretish")
      expect(await makeTunnelCredsStore(dir).read("cloudflare-provisioned")).toMatchObject({ oidcClientId: "client-secretish" })

      const state = await fetch(`${base}/tunnels/login?slug=cloudflare-provisioned`)
      expect(state.status).toBe(200)
      expect(await state.json()).toEqual({ status: "logged_out" })
    })
  })

  it("the credential-writing route is behind the tunnel bearer gate for forwarded requests", async () => {
    await withServer(async base => {
      const body = JSON.stringify({ provisionerUrl: "https://evil.example", oidcIssuer: "https://evil.example", oidcClientId: "x" })
      const forwarded = await fetch(`${base}/tunnels/providers/cloudflare-provisioned`, {
        method: "PUT",
        headers: { ...json, "x-forwarded-for": "203.0.113.7" },
        body,
      })
      expect(forwarded.status).toBe(401)
      expect(await makeTunnelCredsStore(dir).read("cloudflare-provisioned")).toBeNull()

      const withBearer = await fetch(`${base}/tunnels/providers/cloudflare-provisioned`, {
        method: "PUT",
        headers: { ...json, "x-forwarded-for": "203.0.113.7", authorization: `Bearer ${BEARER}` },
        body,
      })
      expect(withBearer.status).toBe(200)
    })
  })
})
