import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OidcDeviceClient, type OidcSession, type OidcSessionStore } from "../remote-providers/oidc-device.js"
import {
  cloudflareProvisionedTunnelProvider,
  fileSessionStore,
} from "../remote-providers/cloudflare-provisioned.js"
import type { FetchLike } from "../remote-providers/cloudflare-api.js"
import type { ProcessSpawner, SpawnRequest, SupervisedProcess } from "../remote-providers/process-supervisor.js"

// ── fakes ────────────────────────────────────────────────────────────────

const ISSUER = "https://auth.example.com"
const PROVISIONER = "https://api.example.com/tunnels"

function jwt(sub: string, n: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${enc({ alg: "none" })}.${enc({ sub, n })}.sig`
}

function respond(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/** Fake Zitadel-ish IdP + provisioning service behind one fetch. */
class FakeWorld {
  // IdP
  pendingPolls = 2
  slowDownOnce = false
  denied = false
  issued = 0
  refreshes = 0
  refreshRevoked = false
  // provisioner
  entitled = true
  tunnels = new Map<string, { hostnames: string[]; service: string | null }>()
  authSeen: string[] = []
  rejectNextWith401 = false
  requests: Array<{ method: string; url: string; body?: unknown }> = []

  private issue(): object {
    this.issued++
    return {
      access_token: jwt("user-42", this.issued),
      refresh_token: `refresh-${this.issued}`,
      expires_in: 3600,
    }
  }

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    const method = init?.method ?? "GET"
    const raw = init?.body
    const form = raw && init?.headers?.["content-type"]?.includes("urlencoded")
      ? Object.fromEntries(new URLSearchParams(raw))
      : undefined
    const json = raw && !form ? (JSON.parse(raw) as unknown) : undefined
    this.requests.push({ method, url: input, ...(json !== undefined ? { body: json } : {}) })

    if (url.origin === ISSUER) {
      if (url.pathname === "/.well-known/openid-configuration") {
        return respond(200, {
          issuer: ISSUER,
          token_endpoint: `${ISSUER}/oauth/v2/token`,
          device_authorization_endpoint: `${ISSUER}/oauth/v2/device_authorization`,
        })
      }
      if (url.pathname === "/oauth/v2/device_authorization") {
        expect(form?.client_id).toBe("client-1")
        expect(form?.scope).toContain("offline_access")
        return respond(200, {
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: `${ISSUER}/device`,
          verification_uri_complete: `${ISSUER}/device?user_code=ABCD-1234`,
          expires_in: 600,
          interval: 5,
        })
      }
      if (url.pathname === "/oauth/v2/token") {
        if (form?.grant_type === "refresh_token") {
          this.refreshes++
          if (this.refreshRevoked) return respond(400, { error: "invalid_grant" })
          return respond(200, this.issue())
        }
        if (this.denied) return respond(400, { error: "access_denied" })
        if (this.slowDownOnce) {
          this.slowDownOnce = false
          return respond(400, { error: "slow_down" })
        }
        if (this.pendingPolls > 0) {
          this.pendingPolls--
          return respond(400, { error: "authorization_pending" })
        }
        return respond(200, this.issue())
      }
    }

    if (input.startsWith(`${PROVISIONER}/v1/tunnels/`)) {
      const auth = init?.headers?.authorization ?? ""
      this.authSeen.push(auth)
      if (this.rejectNextWith401) {
        this.rejectNextWith401 = false
        return respond(401, { error: "unauthorized", message: "token expired" })
      }
      if (!auth.startsWith("Bearer ")) return respond(401, { error: "unauthorized" })
      const key = decodeURIComponent(url.pathname.split("/").pop()!)
      if (method === "PUT") {
        if (!this.entitled) {
          return respond(402, {
            error: "payment_required",
            message: "no active tunnel plan",
            checkoutUrl: "https://pay.example.com/c/1",
          })
        }
        const b = json as { service: string | null; hostnames: string[] }
        const prev = this.tunnels.get(key)
        const hostnames = b.hostnames.length > 0 ? b.hostnames : ["user-42.example.sh"]
        this.tunnels.set(key, { hostnames, service: b.service ?? prev?.service ?? null })
        return respond(200, { tunnelId: `tun-${key}`, hostnames, token: "connector-secret" })
      }
      if (method === "DELETE") {
        if (!this.tunnels.delete(key)) return respond(404, { error: "not_found" })
        return respond(204, null)
      }
    }

    if (url.hostname.endsWith(".example.sh") || url.hostname.endsWith(".example.net")) {
      return respond(404, {})
    }
    return respond(404, { error: "no_route" })
  }
}

function memoryStore(): OidcSessionStore & { value: OidcSession | null } {
  const s = {
    value: null as OidcSession | null,
    async read() {
      return s.value
    },
    async write(v: OidcSession) {
      s.value = v
    },
    async clear() {
      s.value = null
    },
  }
  return s
}

class FakeProc implements SupervisedProcess {
  readonly pid = 4242
  private cbs: Array<(c: number | null, s: NodeJS.Signals | null) => void> = []
  kill(signal?: NodeJS.Signals): void {
    this.cbs.forEach(cb => cb(null, signal ?? "SIGTERM"))
  }
  onExit(cb: (c: number | null, s: NodeJS.Signals | null) => void): void {
    this.cbs.push(cb)
  }
}

const noSleep = async () => {}

// ── OIDC device flow ─────────────────────────────────────────────────────

describe("OidcDeviceClient", () => {
  it("device login: prompt, background polling through pending/slow_down, session stored", async () => {
    const world = new FakeWorld()
    world.slowDownOnce = true
    const store = memoryStore()
    const sleeps: number[] = []
    const client = new OidcDeviceClient({
      config: { issuer: ISSUER, clientId: "client-1" },
      store,
      fetch: world.fetch,
      sleep: async ms => {
        sleeps.push(ms)
      },
    })
    const prompt = await client.beginLogin()
    expect(prompt).toMatchObject({
      userCode: "ABCD-1234",
      verificationUri: `${ISSUER}/device`,
      verificationUriComplete: `${ISSUER}/device?user_code=ABCD-1234`,
    })
    // a second call while pending returns the same code, no new device auth
    expect((await client.beginLogin()).userCode).toBe("ABCD-1234")
    expect((await client.state()).status).toBe("pending")

    await client.waitForLogin()
    expect(sleeps).toEqual([5000, 10000, 10000, 10000]) // slow_down adds 5s
    expect(store.value).toMatchObject({ refreshToken: "refresh-1", subject: "user-42" })
    expect(await client.state()).toMatchObject({ status: "logged_in", subject: "user-42" })
    expect(world.requests.filter(r => r.url.endsWith("/device_authorization"))).toHaveLength(1)
  })

  it("denied login surfaces as failed and stores nothing", async () => {
    const world = new FakeWorld()
    world.denied = true
    const store = memoryStore()
    const client = new OidcDeviceClient({
      config: { issuer: ISSUER, clientId: "client-1" },
      store,
      fetch: world.fetch,
      sleep: noSleep,
    })
    await client.beginLogin()
    await client.waitForLogin()
    expect(await client.state()).toEqual({ status: "failed", reason: "login was denied" })
    expect(store.value).toBeNull()
  })

  it("refreshes an expiring token, and a revoked refresh token clears the session", async () => {
    const world = new FakeWorld()
    const store = memoryStore()
    let now = 1_000_000
    store.value = { accessToken: "old", refreshToken: "refresh-0", expiresAt: now + 30_000 }
    const client = new OidcDeviceClient({
      config: { issuer: ISSUER, clientId: "client-1" },
      store,
      fetch: world.fetch,
      now: () => now,
    })
    // within the 60s skew → refresh
    const t = await client.accessToken()
    expect(t).not.toBe("old")
    expect(world.refreshes).toBe(1)
    expect(store.value?.refreshToken).toBe("refresh-1")
    // still fresh → no refresh
    await client.accessToken()
    expect(world.refreshes).toBe(1)

    world.refreshRevoked = true
    now += 4_000_000
    await expect(client.accessToken()).rejects.toThrow(/run tunnel_login again/)
    expect(store.value).toBeNull()
  })

  it("fails clearly when the issuer has no device endpoint", async () => {
    const fetchImpl: FetchLike = async () => respond(200, { token_endpoint: `${ISSUER}/t` })
    const client = new OidcDeviceClient({
      config: { issuer: ISSUER, clientId: "c" },
      store: memoryStore(),
      fetch: fetchImpl,
    })
    await expect(client.beginLogin()).rejects.toThrow(/enable the Device Code grant/)
  })

  it("errors never contain a token", async () => {
    const store = memoryStore()
    const client = new OidcDeviceClient({
      config: { issuer: ISSUER, clientId: "c" },
      store,
      fetch: new FakeWorld().fetch,
    })
    const err = (await client.accessToken().catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/run tunnel_login first/)
  })
})

// ── provider ─────────────────────────────────────────────────────────────

const CREDS = { provisionerUrl: PROVISIONER, oidcIssuer: ISSUER, oidcClientId: "client-1" }

async function loggedInProvider(world: FakeWorld, extra: Record<string, unknown> = {}) {
  const store = memoryStore()
  const requests: SpawnRequest[] = []
  const spawner: ProcessSpawner = req => {
    requests.push(req)
    return new FakeProc()
  }
  const provider = cloudflareProvisionedTunnelProvider(CREDS, {
    fetch: world.fetch,
    sessionStore: store,
    sleep: noSleep,
    spawner,
    healthIntervalMs: 0,
    ...extra,
  })
  await provider.auth!.begin()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 20 && (await provider.auth!.state()).status !== "logged_in"; i++) {
    await new Promise(r => setTimeout(r, 0))
  }
  expect((await provider.auth!.state()).status).toBe("logged_in")
  return { provider, store, requests }
}

describe("cloudflareProvisionedTunnelProvider", () => {
  it("validates its setup: https URLs, all three fields", () => {
    const p = cloudflareProvisionedTunnelProvider(null)
    expect(p.setupFields?.map(f => f.name)).toEqual([
      "provisionerUrl",
      "oidcIssuer",
      "oidcClientId",
      "oidcScopes",
    ])
    expect(() => p.validateSetup!({ ...CREDS, provisionerUrl: "http://api.example.com" })).toThrow(/https/)
    expect(() => p.validateSetup!({ ...CREDS, provisionerUrl: "http://127.0.0.1:8787" })).not.toThrow()
    expect(() => p.validateSetup!({ provisionerUrl: PROVISIONER, oidcIssuer: ISSUER })).toThrow(/oidcClientId/)
  })

  it("start without login asks for tunnel_login and spawns nothing", async () => {
    const world = new FakeWorld()
    const requests: SpawnRequest[] = []
    const p = cloudflareProvisionedTunnelProvider(CREDS, {
      fetch: world.fetch,
      sessionStore: memoryStore(),
      spawner: req => {
        requests.push(req)
        return new FakeProc()
      },
    })
    await expect(
      p.start({ target: { host: "127.0.0.1", port: 8081 }, workspace: "/x", tunnel: { key: "k", hostnames: [] } }),
    ).rejects.toThrow(/tunnel_login/)
    expect(requests).toHaveLength(0)
  })

  it("start: PUT with bearer + service, assigned hostname, connector token in env only", async () => {
    const world = new FakeWorld()
    const { provider, requests } = await loggedInProvider(world)
    const res = await provider.start({
      target: { host: "127.0.0.1", port: 8081 },
      workspace: "/x",
      tunnel: { key: "relay-ab12", hostnames: [] },
    })
    expect(res).toMatchObject({
      publicUrl: "https://user-42.example.sh",
      hostnames: ["user-42.example.sh"],
      tunnelId: "tun-relay-ab12",
    })
    const put = world.requests.find(r => r.method === "PUT")!
    expect(put.url).toBe(`${PROVISIONER}/v1/tunnels/relay-ab12`)
    expect(put.body).toEqual({ service: "http://127.0.0.1:8081", hostnames: [] })
    expect(world.authSeen.at(-1)).toMatch(/^Bearer ey/)
    expect(requests[0]!.env).toEqual({ TUNNEL_TOKEN: "connector-secret" })
    expect(requests[0]!.args.join(" ")).not.toContain("connector-secret")
    await provider.stop()
  })

  it("refreshes once and retries on 401", async () => {
    const world = new FakeWorld()
    const { provider } = await loggedInProvider(world)
    world.rejectNextWith401 = true
    await provider.start({
      target: { host: "127.0.0.1", port: 8081 },
      workspace: "/x",
      tunnel: { key: "k", hostnames: [] },
    })
    expect(world.refreshes).toBe(1)
    expect(world.authSeen).toHaveLength(2)
    expect(world.authSeen[0]).not.toBe(world.authSeen[1])
    await provider.stop()
  })

  it("402 surfaces the checkout URL", async () => {
    const world = new FakeWorld()
    world.entitled = false
    const { provider, requests } = await loggedInProvider(world)
    await expect(
      provider.start({
        target: { host: "127.0.0.1", port: 8081 },
        workspace: "/x",
        tunnel: { key: "k", hostnames: [] },
      }),
    ).rejects.toThrow(/402.*no active tunnel plan.*subscribe at https:\/\/pay\.example\.com\/c\/1/)
    expect(requests).toHaveLength(0)
  })

  it("requested hostname, swap add/remove, destroy (404 tolerated)", async () => {
    const world = new FakeWorld()
    const { provider } = await loggedInProvider(world)
    const identity = { key: "wa", hostnames: ["wa.user-42.example.sh"] }
    await provider.start({ target: { host: "127.0.0.1", port: 9000 }, workspace: "/x", tunnel: identity })
    await provider.addHostname!(identity, "relay.user-42.example.sh")
    expect(world.tunnels.get("wa")?.hostnames).toEqual(["relay.user-42.example.sh", "wa.user-42.example.sh"])
    await provider.removeHostname!(
      { key: "wa", hostnames: ["relay.user-42.example.sh", "wa.user-42.example.sh"] },
      "wa.user-42.example.sh",
    )
    expect(world.tunnels.get("wa")?.hostnames).toEqual(["relay.user-42.example.sh"])
    expect(world.tunnels.get("wa")?.service).toBe("http://127.0.0.1:9000")
    await provider.stop()

    // stopped: a swap sends service:null so the provisioner keeps the origin
    await provider.addHostname!({ key: "wa", hostnames: ["relay.user-42.example.sh"] }, "x.user-42.example.sh")
    expect(world.requests.filter(r => r.method === "PUT").at(-1)?.body).toMatchObject({ service: null })

    await provider.destroy!({ key: "wa", hostnames: [] })
    expect(world.tunnels.has("wa")).toBe(false)
    await expect(provider.destroy!({ key: "wa", hostnames: [] })).resolves.toBeUndefined()
  })
})

describe("fileSessionStore", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oidc-store-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("writes owner-only and clears", async () => {
    const path = join(dir, "nested", "s.json")
    const store = fileSessionStore(path)
    expect(await store.read()).toBeNull()
    await store.write({ accessToken: "a", expiresAt: 1 })
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0)
    expect(await store.read()).toEqual({ accessToken: "a", expiresAt: 1 })
    await store.clear()
    expect(await store.read()).toBeNull()
  })
})
