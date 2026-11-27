/**
 * Device pairing over HTTP, through the real server and a real approvals
 * engine, on requests that look like they crossed a tunnel (forwarded header,
 * daemon in bearer mode): offer -> request -> human confirmation -> token ->
 * limited access -> revocation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { DeviceAccessStore, setDeviceAccessStoreForTests } from "../device-access.js"
import { createDeviceRegistry } from "../device-registry.js"
import type { PairingRegistry } from "../pairing-registry.js"

const FWD = { "x-forwarded-for": "203.0.113.9" }
const DAEMON_BEARER = "daemon-bearer-secret"

describe("device pairing over HTTP", () => {
  let dir: string
  let store: DeviceAccessStore
  let engine: ApprovalsEngine
  let appRegistry: AppRegistry
  const dispatched: Array<{ tool: string; args: unknown }> = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "device-access-http-"))
    store = new DeviceAccessStore({ persist: false })
    setDeviceAccessStoreForTests(store)
    engine = createApprovalsEngine({ homeDir: join(dir, "approvals"), sessionEvents: createSessionEventBus(), webOrigins: ["https://approve.example.invalid"] })
    await writeFile(join(dir, "ui.html"), "<html><body>x</body></html>")
    appRegistry = createAppRegistry()
    for (const [appId, name] of [["acme/one", "One"], ["acme/two", "Two"]] as const) {
      appRegistry.upsertApp({
        appId,
        dir,
        name,
        description: `${name} app`,
        agents: [],
        workflows: [],
        unvalidatedAgentTools: [],
        ui: { path: join(dir, "ui.html"), tools: ["directory_list"] },
      })
    }
    appRegistry.upsertApp({ appId: "acme/headless", dir, name: "Headless", agents: [], workflows: [], unvalidatedAgentTools: [] })
    appRegistry.upsertApp({
      appId: "acme/local-only",
      dir,
      name: "Local only",
      access: { remote: false },
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: join(dir, "ui.html"), tools: ["directory_list"] },
    })
    dispatched.length = 0
  })

  afterEach(async () => {
    engine.dispose()
    setDeviceAccessStoreForTests(undefined)
    await rm(dir, { recursive: true, force: true })
  })

  async function withServer(fn: (base: string) => Promise<void>, extra: Partial<RuntimeHttpServerOptions> = {}): Promise<void> {
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
      auth: { mode: "bearer", token: DAEMON_BEARER },
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
      },
      events: createRuntimeEvents(),
      heartbeat: { start() {}, stop() {}, async fireNow() {} },
      meta: { workspace: process.cwd(), registered: [] },
      appRegistry,
      approvals: engine,
      assetLinksPath: join(dir, "assetlinks.json"),
      appToolCallDeps: {
        dispatchTool: async (tool: string, args: Record<string, unknown>) => {
          dispatched.push({ tool, args })
          return { ok: true }
        },
      },
      ...extra,
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...FWD, ...headers }, body: JSON.stringify(body) })

  /** Run the whole ceremony; returns the token. */
  async function connect(base: string, apps: "*" | string[], sessionsRead = false) {
    const offer = store.offer({ grant: { apps, sessionsRead } })
    const r = await post(base, "/device-pair/request", { offer: offer.code, deviceName: "Pixel 9", platform: "android" })
    expect(r.status).toBe(200)
    const req = (await r.json()) as { requestId: string; pollSecret: string; number: string }
    const pending = engine.list({ status: "pending" })
    expect(pending).toHaveLength(1)
    await engine.decideWeb(pending[0]!.id, "approve", { ipAddress: "127.0.0.1", userAgent: "test" })
    const polled = await fetch(`${base}/device-pair/request/${req.requestId}`, { headers: { ...FWD, "x-poll-secret": req.pollSecret } })
    const body = (await polled.json()) as { status: string; token: string; deviceId: string }
    expect(body.status).toBe("approved")
    return { token: body.token, deviceId: body.deviceId, req }
  }

  it("the full ceremony: no access before the human decision, a token after, delivered once", async () => {
    await withServer(async base => {
      const offer = store.offer({ grant: { apps: ["acme/one"] } })
      const r = await post(base, "/device-pair/request", { offer: offer.code, deviceName: "Pixel 9", platform: "android" })
      expect(r.status).toBe(200)
      expect(r.headers.get("access-control-allow-origin")).toBe("*")
      const req = (await r.json()) as { requestId: string; pollSecret: string; number: string }
      expect(req.number).toMatch(/^[1-9][0-9]$/)

      // The confirmation names the device and repeats the number; nothing is granted yet.
      const [approval] = engine.list({ status: "pending" })
      expect(approval!.kind).toBe("device_pairing")
      expect(approval!.title).toContain(req.number)
      expect(approval!.title).toContain("Pixel 9")
      const early = await fetch(`${base}/device-pair/request/${req.requestId}`, { headers: { ...FWD, "x-poll-secret": req.pollSecret } })
      expect(await early.json()).toEqual({ status: "pending" })
      expect(store.list()).toHaveLength(0)

      await engine.decideWeb(approval!.id, "approve", { ipAddress: "127.0.0.1", userAgent: "test" })
      const done = await fetch(`${base}/device-pair/request/${req.requestId}`, { headers: { ...FWD, "x-poll-secret": req.pollSecret } })
      const body = (await done.json()) as { status: string; token: string }
      expect(body.status).toBe("approved")
      expect(body.token).toMatch(/^dvt_/)
      const again = await fetch(`${base}/device-pair/request/${req.requestId}`, { headers: { ...FWD, "x-poll-secret": req.pollSecret } })
      expect(again.status).toBe(410)
    })
  })

  it("a refused confirmation, a replayed offer and a bad poll secret give nothing", async () => {
    await withServer(async base => {
      const offer = store.offer({ grant: { apps: "*" } })
      const r = await post(base, "/device-pair/request", { offer: offer.code })
      const req = (await r.json()) as { requestId: string; pollSecret: string }
      const [approval] = engine.list({ status: "pending" })
      await engine.decideWeb(approval!.id, "deny", { ipAddress: "127.0.0.1", userAgent: "test" })
      const poll = await fetch(`${base}/device-pair/request/${req.requestId}`, { headers: { ...FWD, "x-poll-secret": req.pollSecret } })
      expect(await poll.json()).toEqual({ status: "denied" })
      expect(store.list()).toHaveLength(0)
      expect((await post(base, "/device-pair/request", { offer: offer.code })).status).toBe(400)
      const bad = await fetch(`${base}/device-pair/request/${req.requestId}`, { headers: { ...FWD, "x-poll-secret": "nope" } })
      expect(bad.status).toBe(404)
      expect((await post(base, "/device-pair/request", { nothing: true })).status).toBe(400)
      expect((await post(base, "/device-pair/request", { offer: "WRONGWRONGWRONG0" })).status).toBe(400)
    })
  })

  it("without a confirmation channel nothing can be requested", async () => {
    await withServer(
      async base => {
        const offer = store.offer({ grant: { apps: "*" } })
        const r = await post(base, "/device-pair/request", { offer: offer.code })
        expect(r.status).toBe(503)
        expect(((await r.json()) as { error: string }).error).toBe("no_confirmation_channel")
      },
      { approvals: undefined },
    )
  })

  it("an approvals engine with no enabled channel cannot confirm anything, so nothing is requested", async () => {
    const mute = createApprovalsEngine({ homeDir: join(dir, "approvals-mute"), sessionEvents: createSessionEventBus(), webOrigins: [] })
    try {
      await withServer(
        async base => {
          const offer = store.offer({ grant: { apps: "*" } })
          const r = await post(base, "/device-pair/request", { offer: offer.code })
          expect(r.status).toBe(503)
          expect(mute.list({ status: "pending" })).toHaveLength(0)
          expect(store.pendingRequests()).toHaveLength(0)
        },
        { approvals: { ...mute, enabledChannels: [] } as ApprovalsEngine },
      )
    } finally {
      mute.dispose()
    }
  })

  it("a device is limited to the apps of its grant: other apps answer grant_out_of_scope, even by the cookie", async () => {
    await withServer(async base => {
      const { token } = await connect(base, ["acme/one"])
      const call = (appId: string, headers: Record<string, string>) =>
        fetch(`${base}/apps/${encodeURIComponent(appId)}/tool-call`, {
          method: "POST",
          headers: { "content-type": "application/json", ...FWD, ...headers },
          body: JSON.stringify({ tool: "directory_list", args: { path: "/" } }),
        })
      const ok = await call("acme/one", { authorization: `Bearer ${token}` })
      expect(ok.status).toBe(200)
      expect(dispatched).toEqual([{ tool: "directory_list", args: { path: "/" } }])
      const other = await call("acme/two", { authorization: `Bearer ${token}` })
      expect(other.status).toBe(403)
      expect(await other.json()).toEqual({ error: "grant_out_of_scope" })
      const cookie = await call("acme/one", { cookie: `agentproto_device=${token}` })
      expect(cookie.status).toBe(200)
      const cookieOther = await call("acme/two", { cookie: `agentproto_device=${token}` })
      expect(cookieOther.status).toBe(403)
      // A tool outside the app's own ui.tools allowlist is still refused.
      const notAllowed = await fetch(`${base}/apps/acme%2Fone/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", ...FWD, authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool: "command_execute", args: {} }),
      })
      // The refusal comes back as the tool result, and the tool never ran.
      expect(JSON.stringify(await notAllowed.json())).toMatch(/not.*(allow|expos)|allowlist/i)
      expect(dispatched.map(d => d.tool)).toEqual(["directory_list", "directory_list"])
    })
  })

  it("a cookie token presented from another origin is refused; a header token is not an ambient credential", async () => {
    await withServer(async base => {
      const { token } = await connect(base, "*")
      const res = await fetch(`${base}/apps/acme%2Fone/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", ...FWD, origin: "https://evil.example", cookie: `agentproto_device=${token}` },
        body: JSON.stringify({ tool: "directory_list", args: {} }),
      })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe("cross_origin")
    })
  })

  it("no token, a stranger's token, or a daemon-less request still needs the daemon bearer", async () => {
    await withServer(async base => {
      const plain = await fetch(`${base}/apps/acme%2Fone/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", ...FWD },
        body: JSON.stringify({ tool: "directory_list", args: {} }),
      })
      expect(plain.status).toBe(401)
      const fake = await fetch(`${base}/apps/acme%2Fone/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", ...FWD, authorization: "Bearer dvt_notarealtoken" },
        body: JSON.stringify({ tool: "directory_list", args: {} }),
      })
      expect(fake.status).toBe(401)
      // A device token does not open the rest of the daemon.
      const { token } = await connect(base, "*")
      expect((await fetch(`${base}/sessions`, { headers: { ...FWD, authorization: `Bearer ${token}` } })).status).toBe(401)
    })
  })

  it("session reads follow the grant's sessionsRead flag", async () => {
    await withServer(async base => {
      const without = await connect(base, ["acme/one"], false)
      const r1 = await fetch(`${base}/sessions/sess_x`, { headers: { ...FWD, authorization: `Bearer ${without.token}` } })
      expect(r1.status).toBe(401)
      const withRead = await connect(base, ["acme/one"], true)
      const r2 = await fetch(`${base}/sessions/sess_x`, { headers: { ...FWD, authorization: `Bearer ${withRead.token}` } })
      expect(r2.status).not.toBe(401)
      // Reads only: a write route stays closed to a device.
      const w = await fetch(`${base}/sessions/sess_x/kill`, { method: "POST", headers: { ...FWD, authorization: `Bearer ${withRead.token}` } })
      expect(w.status).toBe(401)
    })
  })

  it("/device/me lists only the granted apps that have a UI, and a revoked device gets access_revoked", async () => {
    await withServer(async base => {
      const all = await connect(base, "*")
      const me = await fetch(`${base}/device/me`, { headers: { ...FWD, authorization: `Bearer ${all.token}` } })
      const body = (await me.json()) as { name: string; apps: Array<{ appId: string; uiPath: string }>; machine: { name: string } }
      expect(body.name).toBe("Pixel 9")
      expect(body.apps.map(a => a.appId).sort()).toEqual(["acme/one", "acme/two"])
      expect(body.apps[0]!.uiPath).toMatch(/^\/apps\/acme\/(one|two)\/ui$/)
      expect(body.machine.name.length).toBeGreaterThan(0)

      const one = await connect(base, ["acme/one", "acme/headless"])
      const me1 = (await (await fetch(`${base}/device/me`, { headers: { ...FWD, authorization: `Bearer ${one.token}` } })).json()) as { apps: Array<{ appId: string }> }
      expect(me1.apps.map(a => a.appId)).toEqual(["acme/one"])

      expect(store.revoke(all.deviceId)).toBe(true)
      const revoked = await fetch(`${base}/device/me`, { headers: { ...FWD, authorization: `Bearer ${all.token}` } })
      expect(revoked.status).toBe(401)
      expect(await revoked.json()).toEqual({ error: "access_revoked" })
      const revokedCall = await fetch(`${base}/apps/acme%2Fone/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", ...FWD, authorization: `Bearer ${all.token}` },
        body: JSON.stringify({ tool: "directory_list", args: {} }),
      })
      expect(revokedCall.status).toBe(401)
      expect(await revokedCall.json()).toEqual({ error: "access_revoked" })
      expect((await fetch(`${base}/device/me`, { headers: FWD })).status).toBe(401)
    })
  })

  it("an app that says access.remote: false is neither listed nor reachable from a device, whatever the grant", async () => {
    await withServer(async base => {
      const { token } = await connect(base, "*")
      const me = (await (await fetch(`${base}/device/me`, { headers: { ...FWD, authorization: `Bearer ${token}` } })).json()) as { apps: Array<{ appId: string }> }
      expect(me.apps.map(a => a.appId)).not.toContain("acme/local-only")
      const res = await fetch(`${base}/apps/acme%2Flocal-only/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", ...FWD, authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool: "directory_list", args: {} }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "grant_out_of_scope" })
      expect(dispatched).toHaveLength(0)
    })
  })

  it("serves the pairing page without the code reaching the server, and the App Links proof from a file", async () => {
    await withServer(async base => {
      const page = await fetch(`${base}/pair`, { headers: FWD })
      expect(page.status).toBe(200)
      expect(page.headers.get("referrer-policy")).toBe("no-referrer")
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'")
      const html = await page.text()
      expect(html).toContain("location.hash")
      expect(html).toContain("sh.agentproto.hub")
      expect(html).not.toMatch(/https?:\/\/(?!schema)/)

      expect((await fetch(`${base}/.well-known/assetlinks.json`, { headers: FWD })).status).toBe(404)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "assetlinks.json"), '[{"relation":["delegate_permission/common.handle_all_urls"]}]')
      const al = await fetch(`${base}/.well-known/assetlinks.json`, { headers: FWD })
      expect(al.status).toBe(200)
      expect(await al.text()).toContain("handle_all_urls")
    })
  })

  it("app devices appear in the daemon's device list, and revoking from there cuts the access", async () => {
    await withServer(async base => {
      const { token, deviceId } = await connect(base, ["acme/one"])
      const pairing = { list: async () => [], isOnline: () => false, rename: async () => false, revoke: async () => false } as unknown as PairingRegistry
      const registry = createDeviceRegistry(pairing, undefined, store)
      const listed = await registry.list()
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ fingerprint: deviceId, name: "Pixel 9", kind: "app", platform: "android", grant: { apps: ["acme/one"] } })
      expect(await registry.rename(deviceId, "Jeremy's phone")).toBe(true)
      expect((await registry.list())[0]!.name).toBe("Jeremy's phone")
      expect(await registry.revoke(deviceId)).toBe(true)
      expect(store.check(token)).toEqual({ error: "access_revoked" })
    })
  })
})
