import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TunnelRegistry } from "../tunnel-registry.js"
import type {
  ProviderStartOptions,
  RemoteProvider,
  TunnelIdentity,
} from "../remote-providers/types.js"

interface Recorder {
  calls: string[]
  starts: ProviderStartOptions[]
  failDestroy?: boolean
}

function managedMock(rec: Recorder): RemoteProvider {
  return {
    id: "managed",
    async start(opts) {
      rec.starts.push(opts)
      rec.calls.push(`start ${opts.tunnel?.hostnames.join(",")}`)
      opts.onHealth?.({ state: "degraded", reason: "awaiting first health probe", checkedAt: "t0" })
      return { publicUrl: `https://${opts.tunnel!.hostnames[0]}`, pid: 42, tunnelId: "cf-tunnel-1" }
    },
    async stop() {
      rec.calls.push("stop")
    },
    async destroy(t: TunnelIdentity) {
      rec.calls.push(`destroy ${t.key} ${t.hostnames.join(",")}`)
      if (rec.failDestroy) throw new Error("cloudflare DELETE failed (500)")
    },
    async addHostname(t: TunnelIdentity, h: string) {
      rec.calls.push(`add ${h} to ${t.hostnames.join(",")}`)
    },
    async removeHostname(t: TunnelIdentity, h: string) {
      rec.calls.push(`remove ${h} from ${t.hostnames.join(",")}`)
    },
  }
}

let tmp: string
const live: TunnelRegistry[] = []

function makeRegistry(rec: Recorder) {
  const reg = new (class extends TunnelRegistry {
    protected override async pickProviderForTest(): Promise<RemoteProvider> {
      return managedMock(rec)
    }
  })({ persistPath: join(tmp, "tunnels.json"), workspace: tmp })
  live.push(reg)
  return reg
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tunnel-managed-"))
})
afterEach(async () => {
  await Promise.all(live.splice(0).map(r => r.shutdown()))
  rmSync(tmp, { recursive: true, force: true })
})

describe("TunnelRegistry × cloudflare-managed", () => {
  it("requires a hostname and passes identity + hostnames to the provider", async () => {
    const rec: Recorder = { calls: [], starts: [] }
    const reg = makeRegistry(rec)
    await expect(
      reg.create({ provider: "cloudflare-managed", targetPort: 8081 }),
    ).rejects.toThrow(/requires "hostname"/)

    const desc = await reg.create({
      provider: "cloudflare-managed",
      targetPort: 8081,
      hostname: "WA.Agentik.net",
      name: "wa",
      autostart: true,
      public: true,
    })
    expect(desc.hostname).toBe("wa.agentik.net")
    expect(desc.hostnames).toEqual(["wa.agentik.net"])
    expect(desc.tunnelId).toBe("cf-tunnel-1")
    expect(desc.publicUrl).toBe("https://wa.agentik.net")
    expect(desc.health).toMatchObject({ state: "degraded" })
    expect(rec.starts[0]!.tunnel).toEqual({
      key: `wa-${desc.id.slice(0, 8)}`,
      hostnames: ["wa.agentik.net"],
    })
    expect(rec.starts[0]!.target).toEqual({ host: "127.0.0.1", port: 8081 })
  })

  it("health updates land in the descriptor; stop clears them", async () => {
    const rec: Recorder = { calls: [], starts: [] }
    const reg = makeRegistry(rec)
    const desc = await reg.create({
      provider: "cloudflare-managed",
      targetPort: 8081,
      hostname: "wa.agentik.net",
      public: true,
    })
    rec.starts[0]!.onHealth!({ state: "active", checkedAt: "t1" })
    expect(reg.get(desc.id)?.health).toEqual({ state: "active", checkedAt: "t1" })
    await reg.stop(desc.id)
    expect(reg.get(desc.id)?.health).toBeUndefined()
    // a late probe after stop is ignored
    rec.starts[0]!.onHealth!({ state: "error", reason: "late", checkedAt: "t2" })
    expect(reg.get(desc.id)?.health).toBeUndefined()
  })

  it("swap: add makes the new hostname primary and keeps the old; remove retires it", async () => {
    const rec: Recorder = { calls: [], starts: [] }
    const reg = makeRegistry(rec)
    const desc = await reg.create({
      provider: "cloudflare-managed",
      targetPort: 8081,
      hostname: "wa.agentik.net",
      name: "wa",
    })
    expect(desc.url).toMatch(/^https:\/\/wa\.agentik\.net\/\?t=/)

    const swapped = await reg.addHostname("wa", "wa.clipgen.co")
    expect(swapped.hostnames).toEqual(["wa.clipgen.co", "wa.agentik.net"])
    expect(swapped.hostname).toBe("wa.clipgen.co")
    expect(swapped.publicUrl).toBe("https://wa.clipgen.co")
    expect(swapped.url).toMatch(/^https:\/\/wa\.clipgen\.co\/\?t=/)
    await expect(reg.addHostname("wa", "wa.clipgen.co")).rejects.toThrow(/already routes/)

    const retired = await reg.removeHostname("wa", "wa.agentik.net")
    expect(retired.hostnames).toEqual(["wa.clipgen.co"])
    await expect(reg.removeHostname("wa", "wa.clipgen.co")).rejects.toThrow(/last hostname/)
    await expect(reg.removeHostname("wa", "nope.agentik.net")).rejects.toThrow(/does not route/)

    expect(rec.calls).toContain("add wa.clipgen.co to wa.agentik.net")
    expect(rec.calls).toContain("remove wa.agentik.net from wa.clipgen.co,wa.agentik.net")
  })

  it("delete: stop first, then destroy, then forget", async () => {
    const rec: Recorder = { calls: [], starts: [] }
    const reg = makeRegistry(rec)
    const desc = await reg.create({
      provider: "cloudflare-managed",
      targetPort: 8081,
      hostname: "wa.agentik.net",
      public: true,
    })
    expect(await reg.delete(desc.id)).toBe(true)
    expect(rec.calls.slice(-2)).toEqual(["stop", `destroy ${desc.id} wa.agentik.net`])
    expect(reg.get(desc.id)).toBeUndefined()
    expect(await reg.delete(desc.id)).toBe(false)
  })

  it("a failed remote delete keeps the descriptor with lastError", async () => {
    const rec: Recorder = { calls: [], starts: [], failDestroy: true }
    const reg = makeRegistry(rec)
    const desc = await reg.create({
      provider: "cloudflare-managed",
      targetPort: 8081,
      hostname: "wa.agentik.net",
      public: true,
    })
    await expect(reg.delete(desc.id)).rejects.toThrow(/DELETE failed/)
    expect(reg.get(desc.id)).toMatchObject({ status: "stopped", lastError: /DELETE failed/ })
  })

  it("cloudflare-provisioned: no hostname needed, the provider's assigned one is recorded", async () => {
    const rec: Recorder = { calls: [], starts: [] }
    const reg = new (class extends TunnelRegistry {
      protected override async pickProviderForTest(): Promise<RemoteProvider> {
        const base = managedMock(rec)
        return {
          ...base,
          async start(opts) {
            rec.starts.push(opts)
            return {
              publicUrl: "https://user-42.pygmalion.sh",
              pid: 7,
              tunnelId: "tun-1",
              hostnames: ["user-42.pygmalion.sh"],
            }
          },
        }
      }
    })({ persistPath: join(tmp, "tunnels.json"), workspace: tmp })
    live.push(reg)
    const desc = await reg.create({ provider: "cloudflare-provisioned", targetPort: 4870, public: true })
    expect(rec.starts[0]!.tunnel?.hostnames).toEqual([])
    expect(desc.hostname).toBe("user-42.pygmalion.sh")
    expect(desc.hostnames).toEqual(["user-42.pygmalion.sh"])
    expect(await reg.delete(desc.id)).toBe(true)
    expect(rec.calls.at(-1)).toBe(`destroy ${desc.id} user-42.pygmalion.sh`)
  })

  it("restored (stopped) entries can still be swapped and deleted", async () => {
    const rec: Recorder = { calls: [], starts: [] }
    const reg = makeRegistry(rec)
    const desc = await reg.create({
      provider: "cloudflare-managed",
      targetPort: 8081,
      hostname: "wa.agentik.net",
      public: true,
    })
    await reg.shutdown()

    const reg2 = makeRegistry(rec)
    const restored = reg2.get(desc.id)
    expect(restored?.status).toBe("stopped")
    expect(restored?.health).toBeUndefined()
    await reg2.addHostname(desc.id, "wa2.agentik.net")
    expect(await reg2.delete(desc.id)).toBe(true)
    expect(rec.calls.at(-1)).toBe(`destroy ${desc.id} wa2.agentik.net,wa.agentik.net`)
  })
})

describe("gateway guard: never publish the daemon itself without authentication", () => {
  function guardedRegistry(rec: Recorder, isProtected: () => boolean) {
    const reg = new (class extends TunnelRegistry {
      protected override async pickProviderForTest(): Promise<RemoteProvider> {
        return managedMock(rec)
      }
    })({
      persistPath: join(tmp, "tunnels.json"),
      workspace: tmp,
      gatewayGuard: { port: 18790, isProtected },
    })
    live.push(reg)
    return reg
  }

  it("refuses a public tunnel to the gateway port while unprotected, before anything starts", async () => {
    const rec: Recorder = { calls: [], starts: [] }
    const reg = guardedRegistry(rec, () => false)
    await expect(
      reg.create({ provider: "cloudflare-provisioned", targetPort: 18790, public: true }),
    ).rejects.toThrow(/refusing a public tunnel to this daemon's own port 18790/)
    expect(rec.starts).toHaveLength(0)
    expect(reg.list()).toHaveLength(0)
  })

  it("allows it behind the access guard, to another port, or once bearer mode is on", async () => {
    const rec: Recorder = { calls: [], starts: [] }
    let protectedNow = false
    const reg = guardedRegistry(rec, () => protectedNow)
    await reg.create({ provider: "cloudflare-provisioned", targetPort: 18790 }) // private
    await reg.create({ provider: "cloudflare-provisioned", targetPort: 4871, public: true })
    protectedNow = true
    await reg.create({ provider: "cloudflare-provisioned", targetPort: 18790, public: true })
    expect(rec.starts).toHaveLength(3)
  })

  it("an autostart tunnel restored after bearer mode was turned off comes back as error, not open", async () => {
    const rec: Recorder = { calls: [], starts: [] }
    let protectedNow = true
    const reg = guardedRegistry(rec, () => protectedNow)
    const desc = await reg.create({
      provider: "cloudflare-provisioned",
      targetPort: 18790,
      public: true,
      autostart: true,
    })
    await reg.shutdown()

    protectedNow = false
    const reg2 = guardedRegistry(rec, () => protectedNow)
    const startsBefore = rec.starts.length
    await reg2.restoreOnBoot()
    expect(rec.starts.length).toBe(startsBefore)
    expect(reg2.get(desc.id)).toMatchObject({ status: "error", lastError: /refusing a public tunnel/ })
  })
})
