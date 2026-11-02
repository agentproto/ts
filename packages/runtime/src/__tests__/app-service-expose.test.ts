/**
 * AIP-53 `services[].expose` (app-service-expose.ts + the keyed
 * `TunnelRegistry.ensureKeyed` + the launcher in app-services.ts). Fakes
 * only: a mock RemoteProvider behind a TunnelRegistry subclass and a fake
 * exposer. No real tunnel, no network, no process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AppService } from "@agentproto/app"
import {
  APP_SERVICE_PUBLIC_URL_ENV,
  appServiceTunnelKey,
  createTunnelRegistryExposer,
  isStableExposeProvider,
  selectExposeProvider,
  type AppServiceExposer,
  type AppServiceExposure,
  type ExposedAppService,
} from "../app-service-expose.js"
import {
  createAppServiceStore,
  ensureAppServiceOwners,
  reensureAppServiceOwners,
  removeAppServiceOwners,
} from "../app-services.js"
import { TunnelRegistry, type TunnelDescriptor } from "../tunnel-registry.js"
import type { ProviderStartOptions, RemoteProvider, TunnelIdentity } from "../remote-providers/types.js"

const APP_ID = "@test/expose-app"

interface Recorder {
  starts: ProviderStartOptions[]
  destroys: TunnelIdentity[]
  stops: number
  failStart?: string
}

function mockProvider(rec: Recorder): RemoteProvider {
  return {
    id: "mock",
    async start(opts) {
      rec.starts.push(opts)
      if (rec.failStart) throw new Error(rec.failStart)
      const host = opts.tunnel?.hostnames[0] ?? `${(opts.tunnel?.key ?? "x").replace(/[^a-z0-9]+/g, "-")}.example.test`
      return { publicUrl: `https://${host}`, pid: 4242, tunnelId: "remote-1", hostnames: [host] }
    },
    async stop() {
      rec.stops += 1
    },
    async destroy(t) {
      rec.destroys.push(t)
    },
  }
}

let tmp: string
const live: TunnelRegistry[] = []

function makeRegistry(rec: Recorder, persistPath = join(tmp, "tunnels.json")): TunnelRegistry {
  const reg = new (class extends TunnelRegistry {
    protected override async pickProviderForTest(): Promise<RemoteProvider> {
      return mockProvider(rec)
    }
  })({ persistPath, workspace: tmp })
  live.push(reg)
  return reg
}

const newRec = (): Recorder => ({ starts: [], destroys: [], stops: 0 })

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "app-service-expose-"))
})
afterEach(async () => {
  await Promise.all(live.splice(0).map(r => r.shutdown()))
  rmSync(tmp, { recursive: true, force: true })
})

const miniapp: ExposedAppService = {
  name: "miniapp",
  command: "node",
  args: ["dist/miniapp.js"],
  port: 8788,
  expose: { auth: "service", hostname: "session-chat" },
}

describe("selectExposeProvider (host config, never the app's)", () => {
  const creds = (map: Record<string, Record<string, string>>) => async (slug: string) => map[slug] ?? null

  it("the configured provider wins", async () => {
    expect(
      await selectExposeProvider({
        configured: "ngrok",
        readCreds: creds({ "cloudflare-provisioned": { provisionerUrl: "https://p" } }),
      }),
    ).toBe("ngrok")
  })

  it("defaults to cloudflare-provisioned when its creds are registered", async () => {
    expect(
      await selectExposeProvider({
        readCreds: creds({
          "cloudflare-provisioned": { provisionerUrl: "https://p", apiKey: "sk-x" },
          "cloudflare-managed": { zones: "[]" },
        }),
      }),
    ).toBe("cloudflare-provisioned")
  })

  it("then cloudflare-managed when registered", async () => {
    expect(await selectExposeProvider({ readCreds: creds({ "cloudflare-managed": { zones: "[]" } }) })).toBe(
      "cloudflare-managed",
    )
  })

  it("falls back to cloudflare-quick, reported as not stable", async () => {
    const slug = await selectExposeProvider({ readCreds: creds({}) })
    expect(slug).toBe("cloudflare-quick")
    expect(isStableExposeProvider(slug)).toBe(false)
    expect(isStableExposeProvider("cloudflare-provisioned")).toBe(true)
    // A broken creds store is treated as nothing registered.
    expect(
      await selectExposeProvider({
        readCreds: async () => {
          throw new Error("EACCES")
        },
      }),
    ).toBe("cloudflare-quick")
  })
})

describe("appServiceTunnelKey (AIP-53 Tunnel key)", () => {
  const PROVISIONER_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/

  it("derives the spec's exact key", () => {
    expect(appServiceTunnelKey("@agentik/pygmalion", "telegram-miniapp")).toBe(
      "app.agentik-pygmalion.telegram-miniapp.f29069fe",
    )
  })

  it("always matches the provisioner key alphabet, and keeps apart ids that reduce alike", () => {
    const long = `a${"b-".repeat(29)}c` // 60 chars, a valid kebab name
    expect(long).toHaveLength(60)
    const ids = ["@agentik/pygmalion", "@Scope/My_App.V2", "---", "@@//", "UPPER/Case/Path/With/Many/Segments/And/More", "x"]
    for (const id of ids) {
      for (const name of ["web", "telegram-miniapp", long]) {
        const key = appServiceTunnelKey(id, name)
        expect(key, `${id} + ${name}`).toMatch(PROVISIONER_KEY_RE)
        expect(appServiceTunnelKey(id, name)).toBe(key) // deterministic
      }
    }
    expect(appServiceTunnelKey("@a/b", "web")).not.toBe(appServiceTunnelKey("a-b", "web"))
  })
})

describe("TunnelRegistry.ensureKeyed (stable identity)", () => {
  it("hands the provider the caller's key and returns the same tunnel on re-ensure", async () => {
    const rec = newRec()
    const reg = makeRegistry(rec)
    const key = appServiceTunnelKey(APP_ID, "miniapp")
    expect(key).toMatch(/^app\.test-expose-app\.miniapp\.[0-9a-f]{8}$/)
    const a = await reg.ensureKeyed({ key, provider: "cloudflare-provisioned", targetPort: 8788, public: true })
    expect(rec.starts).toHaveLength(1)
    expect(rec.starts[0]!.tunnel?.key).toBe(key)

    const b = await reg.ensureKeyed({ key, provider: "cloudflare-provisioned", targetPort: 8788, public: true })
    expect(b.id).toBe(a.id)
    expect(rec.starts).toHaveLength(1)
    expect(reg.list().filter(d => d.key === key)).toHaveLength(1)
  })

  it("concurrent ensures of one key never create two tunnels", async () => {
    const rec = newRec()
    const reg = makeRegistry(rec)
    const key = appServiceTunnelKey(APP_ID, "miniapp")
    const [a, b] = await Promise.all([
      reg.ensureKeyed({ key, provider: "cloudflare-provisioned", targetPort: 8788 }),
      reg.ensureKeyed({ key, provider: "cloudflare-provisioned", targetPort: 8788 }),
    ])
    expect(a.id).toBe(b.id)
    expect(reg.list()).toHaveLength(1)
    expect(rec.starts).toHaveLength(1)
  })

  it("restarts a stopped keyed tunnel in place, same descriptor and same provider key", async () => {
    const rec = newRec()
    const reg = makeRegistry(rec)
    const key = appServiceTunnelKey(APP_ID, "miniapp")
    const a = await reg.ensureKeyed({ key, provider: "cloudflare-provisioned", targetPort: 8788 })
    await reg.stop(a.id)
    const b = await reg.ensureKeyed({ key, provider: "cloudflare-provisioned", targetPort: 8788 })
    expect(b.id).toBe(a.id)
    expect(b.status).toBe("active")
    expect(rec.starts.map(s => s.tunnel?.key)).toEqual([key, key])
    expect(reg.list()).toHaveLength(1)
  })

  it("survives a daemon boot: the persisted descriptor is reused with the same key, and is not autostarted", async () => {
    const rec = newRec()
    const path = join(tmp, "boot-tunnels.json")
    const key = appServiceTunnelKey(APP_ID, "miniapp")
    const reg1 = makeRegistry(rec, path)
    const a = await reg1.ensureKeyed({ key, provider: "cloudflare-provisioned", targetPort: 8788, autostart: true })
    await reg1.shutdown() // flushes persistence, like a daemon stop

    const rec2 = newRec()
    const reg2 = makeRegistry(rec2, path)
    await reg2.restoreOnBoot()
    expect(rec2.starts).toHaveLength(0) // the services boot pass owns it, not autostart
    expect(reg2.findByKey(key)?.status).toBe("stopped")

    const b = await reg2.ensureKeyed({ key, provider: "cloudflare-provisioned", targetPort: 8788 })
    expect(b.id).toBe(a.id)
    expect(rec2.starts[0]!.tunnel?.key).toBe(key)
    expect(rec2.starts[0]!.tunnel?.hostnames).toEqual(a.hostnames)
    expect(reg2.list()).toHaveLength(1)
  })

  it("create refuses a key that is already registered", async () => {
    const reg = makeRegistry(newRec())
    await reg.ensureKeyed({ key: "k", provider: "cloudflare-provisioned", targetPort: 1 })
    await expect(reg.create({ key: "k", provider: "cloudflare-provisioned", targetPort: 1 })).rejects.toThrow(
      /already registered/,
    )
  })
})

describe("createTunnelRegistryExposer", () => {
  const noCreds = async () => null
  const provisioned = async (slug: string) =>
    slug === "cloudflare-provisioned" ? { provisionerUrl: "https://p", apiKey: "sk-x" } : null

  it("auth: service is a public tunnel; the exposure carries the bare origin", async () => {
    const rec = newRec()
    const reg = makeRegistry(rec)
    const exposer = createTunnelRegistryExposer({ registry: reg, readCreds: provisioned })
    const x = await exposer.ensure(APP_ID, miniapp)
    expect(x).toMatchObject({
      name: "miniapp",
      auth: "service",
      stable: true,
      state: "active",
      publicUrl: "https://session-chat",
      provider: "cloudflare-provisioned",
    })
    const desc = reg.findByKey(appServiceTunnelKey(APP_ID, "miniapp"))!
    expect(x.tunnelId).toBe(desc.id)
    expect(desc.access).toBe("public")
    expect(desc.targetPort).toBe(8788)
    expect(rec.starts[0]!.tunnel?.hostnames).toEqual(["session-chat"])
    expect(exposer.list(APP_ID)).toEqual(["miniapp"])
  })

  it("auth: guard (default) is guarded and the origin never carries the access token", async () => {
    const rec = newRec()
    const reg = makeRegistry(rec)
    const exposer = createTunnelRegistryExposer({ registry: reg, readCreds: provisioned })
    const x = await exposer.ensure(APP_ID, { name: "web", entry: "node web.js", port: 4321, expose: {} })
    expect(x.auth).toBe("guard")
    const desc = reg.findByKey(appServiceTunnelKey(APP_ID, "web"))! as TunnelDescriptor
    expect(desc.access).toBe("private")
    expect(desc.url).toContain("t=") // the entry link exists for a caller who asks
    expect(x.publicUrl).toMatch(/^https:\/\/[^/?#]+$/)
    expect(x.publicUrl).not.toContain("t=")
  })

  it("uses the configured provider and reports a quick fallback as not stable", async () => {
    const reg = makeRegistry(newRec())
    const exposer = createTunnelRegistryExposer({
      registry: reg,
      readCreds: noCreds,
    })
    const x = await exposer.ensure(APP_ID, miniapp)
    expect(x.provider).toBe("cloudflare-quick")
    expect(x.stable).toBe(false)

    const reg2 = makeRegistry(newRec(), join(tmp, "t2.json"))
    const configured = createTunnelRegistryExposer({
      registry: reg2,
      readCreds: provisioned,
      configuredProvider: async () => "ngrok",
    })
    expect((await configured.ensure(APP_ID, miniapp)).provider).toBe("ngrok")
  })

  it("places a label under the first managed zone", async () => {
    const rec = newRec()
    const reg = makeRegistry(rec)
    const zones = JSON.stringify([{ zone: "example.com", accountId: "acc", tokenRef: "env:CF" }])
    const exposer = createTunnelRegistryExposer({
      registry: reg,
      readCreds: async slug => (slug === "cloudflare-managed" ? { zones } : null),
    })
    const x = await exposer.ensure(APP_ID, miniapp)
    expect(x.provider).toBe("cloudflare-managed")
    expect(rec.starts[0]!.tunnel?.hostnames).toEqual(["session-chat.example.com"])
  })

  it("a failed tunnel is reported, never thrown, and a retry reuses the same descriptor", async () => {
    const rec: Recorder = { ...newRec(), failStart: "provision failed (402)" }
    const reg = makeRegistry(rec)
    const exposer = createTunnelRegistryExposer({ registry: reg, readCreds: provisioned })
    const x = await exposer.ensure(APP_ID, miniapp)
    expect(x.state).toBe("error")
    expect(x.error).toContain("402")
    expect(x.publicUrl).toBeUndefined()
    const firstId = x.tunnelId
    rec.failStart = undefined
    const y = await exposer.ensure(APP_ID, miniapp)
    expect(y.state).toBe("active")
    expect(y.tunnelId).toBe(firstId)
    expect(reg.list()).toHaveLength(1)
  })

  it("hands the provider the derived key and finds a tunnel by owner for a service no longer declared", async () => {
    const rec = newRec()
    const reg = makeRegistry(rec)
    const exposer = createTunnelRegistryExposer({ registry: reg, readCreds: provisioned })
    const appId = "@agentik/pygmalion"
    await exposer.ensure(appId, { ...miniapp, name: "telegram-miniapp" })
    await exposer.ensure(appId, { name: "web", entry: "x", port: 4000, expose: {} })
    expect(rec.starts[0]!.tunnel?.key).toBe("app.agentik-pygmalion.telegram-miniapp.f29069fe")
    expect(exposer.list(appId).sort()).toEqual(["telegram-miniapp", "web"])
    expect(exposer.list("@agentik/other")).toEqual([])

    // The manifest dropped `telegram-miniapp`: the launcher only knows the
    // name from list(), and remove() still finds the tunnel.
    const store = createAppServiceStore({ persist: false })
    const result = await ensureAppServiceOwners({
      store,
      appId,
      services: [{ name: "web", entry: "x", port: 4000, expose: {} }],
      isOwnerAlive: () => false,
      spawn: async () => ({ ok: true, sessionId: "s" }),
      killOwner: () => {},
      exposer,
    })
    expect(result.unexposed).toEqual(["telegram-miniapp"])
    expect(rec.destroys.map(d => d.key)).toEqual(["app.agentik-pygmalion.telegram-miniapp.f29069fe"])
    expect(exposer.list(appId)).toEqual(["web"])
  })

  it("remove stops the connector and deletes the tunnel remotely", async () => {
    const rec = newRec()
    const reg = makeRegistry(rec)
    const exposer = createTunnelRegistryExposer({ registry: reg, readCreds: provisioned })
    await exposer.ensure(APP_ID, miniapp)
    await exposer.remove(APP_ID, "miniapp")
    expect(rec.stops).toBeGreaterThan(0)
    expect(rec.destroys.map(d => d.key)).toEqual([appServiceTunnelKey(APP_ID, "miniapp")])
    expect(reg.findByKey(appServiceTunnelKey(APP_ID, "miniapp"))).toBeUndefined()
    expect(exposer.list(APP_ID)).toEqual([])
  })
})

/** In-memory exposer: records the call order against spawns. */
function fakeExposer(opts: { fail?: Set<string>; log?: string[]; origin?: (name: string) => string } = {}) {
  const tunnels = new Map<string, AppServiceExposure & { appId: string }>()
  const log = opts.log ?? []
  let created = 0
  const exposer: AppServiceExposer & { created: () => number } = {
    created: () => created,
    async ensure(appId, service) {
      log.push(`ensure ${service.name}`)
      const key = appServiceTunnelKey(appId, service.name)
      if (opts.fail?.has(service.name)) {
        return { name: service.name, auth: service.expose.auth ?? "guard", stable: true, state: "error", error: "provider down" }
      }
      const prev = tunnels.get(key)
      if (prev) {
        const { appId: _a, ...x } = prev
        return opts.origin ? { ...x, publicUrl: opts.origin(service.name) } : x
      }
      created += 1
      const x: AppServiceExposure = {
        name: service.name,
        auth: service.expose.auth ?? "guard",
        stable: true,
        state: "active",
        publicUrl: opts.origin?.(service.name) ?? `https://${service.name}.example.test`,
        tunnelId: `t-${created}`,
      }
      tunnels.set(key, { ...x, appId })
      return x
    },
    status(appId, service) {
      return tunnels.get(appServiceTunnelKey(appId, service.name))
    },
    list(appId) {
      return [...tunnels.values()].filter(t => t.appId === appId).map(t => t.name)
    },
    async remove(appId, name) {
      log.push(`remove ${name}`)
      tunnels.delete(appServiceTunnelKey(appId, name))
    },
  }
  return exposer
}

describe("ensureAppServiceOwners with expose", () => {
  const web: AppService = { name: "web", entry: "node web.js", port: 4321 }

  it("ensures the tunnel BEFORE the spawn and passes only the origin in AGENTPROTO_PUBLIC_URL", async () => {
    const log: string[] = []
    const exposer = fakeExposer({ log })
    const envs: Record<string, Record<string, string> | undefined> = {}
    let n = 0
    const result = await ensureAppServiceOwners({
      store: createAppServiceStore({ persist: false }),
      appId: APP_ID,
      services: [miniapp, web],
      isOwnerAlive: () => false,
      spawn: async (service, extra) => {
        log.push(`spawn ${service.name}`)
        envs[service.name] = extra?.env
        return { ok: true, sessionId: `s${++n}` }
      },
      killOwner: () => {},
      exposer,
    })
    expect(log).toEqual(["ensure miniapp", "spawn miniapp", "spawn web"])
    expect(envs["miniapp"]).toEqual({ [APP_SERVICE_PUBLIC_URL_ENV]: "https://miniapp.example.test" })
    expect(envs["web"]).toBeUndefined()
    expect(result.exposures).toEqual([expect.objectContaining({ name: "miniapp", state: "active", auth: "service" })])
  })

  it("a failed tunnel still starts the process, without AGENTPROTO_PUBLIC_URL, and does not count as a spawn error", async () => {
    const exposer = fakeExposer({ fail: new Set(["miniapp"]) })
    const spawn = vi.fn(async (_s: AppService, _extra?: { env?: Record<string, string> }) => ({
      ok: true as const,
      sessionId: "s1",
    }))
    const result = await ensureAppServiceOwners({
      store: createAppServiceStore({ persist: false }),
      appId: APP_ID,
      services: [miniapp],
      isOwnerAlive: () => false,
      spawn,
      killOwner: () => {},
      exposer,
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![1]).toBeUndefined()
    expect(result.errors).toEqual([])
    expect(result.spawned.map(o => o.name)).toEqual(["miniapp"])
    expect(result.exposures).toEqual([expect.objectContaining({ name: "miniapp", state: "error", error: "provider down" })])
  })

  it("re-ensure and boot re-ensure reuse the tunnel (no second one)", async () => {
    const exposer = fakeExposer()
    const store = createAppServiceStore({ persist: false })
    let n = 0
    const deps = {
      store,
      appId: APP_ID,
      services: [miniapp],
      spawn: async () => ({ ok: true as const, sessionId: `s${++n}` }),
      killOwner: () => {},
      exposer,
    }
    const first = await ensureAppServiceOwners({ ...deps, isOwnerAlive: () => true })
    await ensureAppServiceOwners({ ...deps, isOwnerAlive: () => true })
    const boot = await reensureAppServiceOwners(deps)
    expect(exposer.created()).toBe(1)
    expect(boot.exposures?.[0]?.tunnelId).toBe(first.exposures?.[0]?.tunnelId)
  })

  it("dropping expose, or the service, deletes its tunnel", async () => {
    const log: string[] = []
    const exposer = fakeExposer({ log })
    const store = createAppServiceStore({ persist: false })
    const other: ExposedAppService = { name: "other", entry: "node o.js", port: 9000, expose: {} }
    const base = {
      store,
      appId: APP_ID,
      isOwnerAlive: () => true,
      spawn: async (s: AppService) => ({ ok: true as const, sessionId: `s-${s.name}` }),
      killOwner: () => {},
      exposer,
    }
    await ensureAppServiceOwners({ ...base, services: [miniapp, other] })
    expect(exposer.list(APP_ID).sort()).toEqual(["miniapp", "other"])

    // `expose` removed from miniapp, `other` removed from the manifest.
    const { expose: _drop, ...plain } = miniapp
    const result = await ensureAppServiceOwners({ ...base, services: [plain] })
    expect(result.unexposed?.sort()).toEqual(["miniapp", "other"])
    expect(result.removed).toEqual(["other"])
    expect(exposer.list(APP_ID)).toEqual([])
  })

  it("respawns a running owner when its origin is no longer current, keeps it when unchanged", async () => {
    const store = createAppServiceStore({ persist: false })
    let n = 0
    const spawn = vi.fn(async (_s: AppService, _extra?: { env?: Record<string, string> }) => ({
      ok: true as const,
      sessionId: `s${++n}`,
    }))
    const killOwner = vi.fn()
    const { expose: _e, ...plain } = miniapp
    let origin = "https://first.example.test"
    const fail = new Set<string>()
    const exposer = fakeExposer({ origin: () => origin, fail })
    const base = { store, appId: APP_ID, isOwnerAlive: () => true, spawn, killOwner, exposer }

    // Running without expose.
    await ensureAppServiceOwners({ ...base, services: [plain] })
    expect(spawn).toHaveBeenCalledTimes(1)

    // `expose` added to the running service: restarted with the env.
    const added = await ensureAppServiceOwners({ ...base, services: [miniapp] })
    expect(killOwner).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]![1]).toEqual({ env: { [APP_SERVICE_PUBLIC_URL_ENV]: "https://first.example.test" } })
    expect(added.spawned.map(o => o.publicUrl)).toEqual(["https://first.example.test"])

    // Same origin: kept.
    const same = await ensureAppServiceOwners({ ...base, services: [miniapp] })
    expect(same.kept.map(o => o.name)).toEqual(["miniapp"])
    expect(spawn).toHaveBeenCalledTimes(2)

    // The provider handed out a new URL: restarted again.
    origin = "https://second.example.test"
    await ensureAppServiceOwners({ ...base, services: [miniapp] })
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(spawn.mock.calls[2]![1]).toEqual({ env: { [APP_SERVICE_PUBLIC_URL_ENV]: "https://second.example.test" } })

    // A tunnel in error leaves the running process alone (transient failure).
    fail.add("miniapp")
    const failed = await ensureAppServiceOwners({ ...base, services: [miniapp] })
    expect(failed.kept.map(o => o.name)).toEqual(["miniapp"])
    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it("uninstall (removeAppServiceOwners) deletes every tunnel of the app", async () => {
    const exposer = fakeExposer()
    const store = createAppServiceStore({ persist: false })
    await ensureAppServiceOwners({
      store,
      appId: APP_ID,
      services: [miniapp],
      isOwnerAlive: () => false,
      spawn: async () => ({ ok: true, sessionId: "s1" }),
      killOwner: () => {},
      exposer,
    })
    expect(exposer.list(APP_ID)).toEqual(["miniapp"])
    const removed = await removeAppServiceOwners({ store, appId: APP_ID, killOwner: () => {}, exposer })
    expect(removed).toEqual(["miniapp"])
    expect(exposer.list(APP_ID)).toEqual([])
  })
})
