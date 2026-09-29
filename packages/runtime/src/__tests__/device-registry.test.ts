/**
 * Unit tests for `createDeviceRegistry` (DEVICES-PLAN PR-A) — the computed
 * "device" view over a `PairingRegistry`. Uses a fake registry (no real
 * pairing/rendezvous machinery) so these stay pure mapping/passthrough tests.
 */

import { describe, it, expect, vi } from "vitest"
import { createDeviceRegistry } from "../device-registry.js"
import type { PairingRecord, PairingRegistry } from "../pairing-registry.js"
import type { HostRecord, HostRegistry } from "../host-registry.js"

function fakeRegistry(
  records: PairingRecord[],
  online: Set<string> = new Set(),
  opts: { renameMatches?: boolean; revokeMatches?: boolean } = {},
): PairingRegistry {
  return {
    createOffer: vi.fn(),
    list: async () => records.map(r => ({ ...r })),
    rename: vi.fn(async () => opts.renameMatches ?? true),
    revoke: vi.fn(async () => opts.revokeMatches ?? true),
    isOnline: fp => online.has(fp),
    startAutoconnect: vi.fn(),
    shutdown: vi.fn(),
  }
}

function hostRecord(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    fingerprint: "hfp1",
    name: "office-mac",
    daemonX25519Pub: "pk",
    daemonEd25519Pub: "sk",
    rendezvousUrl: "wss://rdv.example/v1",
    pairRoot: "should-never-appear-on-a-device",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastSeen: "2026-02-02T00:00:00.000Z",
    ...overrides,
  }
}

function fakeHostRegistry(
  records: HostRecord[],
  online: Set<string> = new Set(),
  opts: { renameMatches?: boolean; revokeMatches?: boolean } = {},
): HostRegistry {
  return {
    add: vi.fn(async () => ({ fingerprint: "hfp1", name: "office-mac", rendezvousUrl: "wss://rdv.example/v1" })),
    list: async () => records.map(r => ({ ...r })),
    rename: vi.fn(async () => opts.renameMatches ?? true),
    revoke: vi.fn(async () => opts.revokeMatches ?? true),
    isOnline: fp => online.has(fp),
    forwardHttp: vi.fn(),
    forwardHttpStream: vi.fn(),
    getSessionsSnapshot: vi.fn(() => undefined),
    snapshotNow: vi.fn(async () => false),
    markEnded: vi.fn(async () => false),
    sweep: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
  }
}

function record(overrides: Partial<PairingRecord> = {}): PairingRecord {
  return {
    clientPub: "pub",
    name: "jeremy@laptop",
    fingerprint: "fp1",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-02T00:00:00.000Z",
    pairRoot: "should-never-appear-on-a-device",
    rendezvousUrl: "wss://rdv.example/v1",
    ...overrides,
  }
}

describe("createDeviceRegistry", () => {
  it("maps a pairing record to a device: role client, kind cli, online false", async () => {
    const registry = fakeRegistry([record()])
    const devices = await createDeviceRegistry(registry).list()
    expect(devices).toEqual([
      {
        fingerprint: "fp1",
        name: "jeremy@laptop",
        role: "client",
        kind: "cli",
        rendezvous: "wss://rdv.example/v1",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-02T00:00:00.000Z",
        online: false,
      },
    ])
  })

  it("never leaks pairRoot or clientPub", async () => {
    const registry = fakeRegistry([record()])
    const [device] = await createDeviceRegistry(registry).list()
    expect(device).not.toHaveProperty("pairRoot")
    expect(device).not.toHaveProperty("clientPub")
    expect(JSON.stringify(device)).not.toContain("should-never-appear-on-a-device")
  })

  it("infers kind: browser for the web pair client's default name, cli otherwise", async () => {
    const registry = fakeRegistry([
      record({ fingerprint: "fp1", name: "browser@phone.local" }),
      record({ fingerprint: "fp2", name: "browser" }),
      record({ fingerprint: "fp3", name: "jeremy@laptop" }),
      record({ fingerprint: "fp4", name: "browserish-but-not" }),
    ])
    const devices = await createDeviceRegistry(registry).list()
    expect(devices.map(d => d.kind)).toEqual(["browser", "browser", "cli", "cli"])
  })

  it("reflects isOnline per fingerprint", async () => {
    const registry = fakeRegistry([record({ fingerprint: "fp1" }), record({ fingerprint: "fp2" })], new Set(["fp1"]))
    const devices = await createDeviceRegistry(registry).list()
    expect(devices.find(d => d.fingerprint === "fp1")?.online).toBe(true)
    expect(devices.find(d => d.fingerprint === "fp2")?.online).toBe(false)
  })

  it("passes a legacy pairing through as legacy: true", async () => {
    const registry = fakeRegistry([record({ legacy: true })])
    const [device] = await createDeviceRegistry(registry).list()
    expect(device?.legacy).toBe(true)
  })

  it("a non-legacy pairing has no legacy key at all", async () => {
    const registry = fakeRegistry([record()])
    const [device] = await createDeviceRegistry(registry).list()
    expect(device).not.toHaveProperty("legacy")
  })

  it("rename and revoke pass through to the underlying registry", async () => {
    const registry = fakeRegistry([record()])
    const devices = createDeviceRegistry(registry)
    expect(await devices.rename("fp1", "new-name")).toBe(true)
    expect(registry.rename).toHaveBeenCalledWith("fp1", "new-name")
    expect(await devices.revoke("fp1")).toBe(true)
    expect(registry.revoke).toHaveBeenCalledWith("fp1")
  })

  it("passes a host-scoped pairing through as scope: host", async () => {
    const registry = fakeRegistry([record({ scope: "host" })])
    const [device] = await createDeviceRegistry(registry).list()
    expect(device?.scope).toBe("host")
  })

  it("a plain pairing has no scope key at all", async () => {
    const registry = fakeRegistry([record()])
    const [device] = await createDeviceRegistry(registry).list()
    expect(device).not.toHaveProperty("scope")
  })

  describe("with a HostRegistry wired (PR-C)", () => {
    it("merges hosts into list() as role: host, kind: daemon, scope: host", async () => {
      const registry = fakeRegistry([record()])
      const hosts = fakeHostRegistry([hostRecord()])
      const devices = await createDeviceRegistry(registry, hosts).list()
      expect(devices).toHaveLength(2)
      const host = devices.find(d => d.role === "host")
      expect(host).toEqual({
        fingerprint: "hfp1",
        name: "office-mac",
        role: "host",
        kind: "daemon",
        rendezvous: "wss://rdv.example/v1",
        createdAt: "2026-02-01T00:00:00.000Z",
        lastSeen: "2026-02-02T00:00:00.000Z",
        online: false,
        scope: "host",
      })
    })

    it("never leaks a host's pairRoot", async () => {
      const registry = fakeRegistry([])
      const hosts = fakeHostRegistry([hostRecord()])
      const [device] = await createDeviceRegistry(registry, hosts).list()
      expect(JSON.stringify(device)).not.toContain("should-never-appear-on-a-device")
    })

    it("reflects a host's isOnline", async () => {
      const registry = fakeRegistry([])
      const hosts = fakeHostRegistry([hostRecord()], new Set(["hfp1"]))
      const [device] = await createDeviceRegistry(registry, hosts).list()
      expect(device?.online).toBe(true)
    })

    it("rename tries the pairing registry first, then the host registry", async () => {
      const registry = fakeRegistry([record()], undefined, { renameMatches: false })
      const hosts = fakeHostRegistry([hostRecord()])
      const devices = createDeviceRegistry(registry, hosts)
      expect(await devices.rename("hfp1", "new-name")).toBe(true)
      expect(registry.rename).toHaveBeenCalledWith("hfp1", "new-name")
      expect(hosts.rename).toHaveBeenCalledWith("hfp1", "new-name")
    })

    it("rename returns false when neither registry matches", async () => {
      const registry = fakeRegistry([record()], undefined, { renameMatches: false })
      const hosts = fakeHostRegistry([hostRecord()], undefined, { renameMatches: false })
      expect(await createDeviceRegistry(registry, hosts).rename("nope", "x")).toBe(false)
    })

    it("revoke tries the pairing registry first, then the host registry", async () => {
      const registry = fakeRegistry([record()], undefined, { revokeMatches: false })
      const hosts = fakeHostRegistry([hostRecord()])
      const devices = createDeviceRegistry(registry, hosts)
      expect(await devices.revoke("hfp1")).toBe(true)
      expect(registry.revoke).toHaveBeenCalledWith("hfp1")
      expect(hosts.revoke).toHaveBeenCalledWith("hfp1")
    })

    it("add() delegates to the host registry", async () => {
      const registry = fakeRegistry([])
      const hosts = fakeHostRegistry([])
      const devices = createDeviceRegistry(registry, hosts)
      const result = await devices.add("agentproto://pair?v=2&…&scope=host", "office-mac")
      expect(hosts.add).toHaveBeenCalledWith("agentproto://pair?v=2&…&scope=host", "office-mac")
      expect(result).toEqual({ fingerprint: "hfp1", name: "office-mac", rendezvousUrl: "wss://rdv.example/v1" })
    })

    it("surfaces a host's self-reported provider/sandboxId/labels (SANDBOX-VISIBILITY-JOIN)", async () => {
      const registry = fakeRegistry([])
      const hosts = fakeHostRegistry([
        hostRecord({ provider: "e2b", sandboxId: "sbx_abc123", labels: { pr: "1492" } }),
      ])
      const [device] = await createDeviceRegistry(registry, hosts).list()
      expect(device).toMatchObject({ provider: "e2b", sandboxId: "sbx_abc123", labels: { pr: "1492" } })
    })

    it("a host with no self-reported metadata has none of those keys", async () => {
      const registry = fakeRegistry([])
      const hosts = fakeHostRegistry([hostRecord()])
      const [device] = await createDeviceRegistry(registry, hosts).list()
      expect(device).not.toHaveProperty("provider")
      expect(device).not.toHaveProperty("sandboxId")
      expect(device).not.toHaveProperty("labels")
    })

    it("surfaces a host's lastProbeAt/lastError, and omits them when absent", async () => {
      const hosts = fakeHostRegistry([
        hostRecord({ lastProbeAt: "2026-02-03T00:00:00.000Z", lastError: "handshake timed out" }),
        hostRecord({ fingerprint: "hfp2", name: "ok-host" }),
      ])
      const [down, ok] = await createDeviceRegistry(fakeRegistry([]), hosts).list()
      expect(down).toMatchObject({ lastProbeAt: "2026-02-03T00:00:00.000Z", lastError: "handshake timed out" })
      expect(ok).not.toHaveProperty("lastError")
      expect(ok).not.toHaveProperty("lastProbeAt")
    })

    it("hides ended hosts by default and shows them, marked, with includeEnded", async () => {
      const hosts = fakeHostRegistry([
        hostRecord({ fingerprint: "live", name: "ci-live" }),
        hostRecord({ fingerprint: "gone", name: "ci-gone", ended: true, endedAt: "2026-02-02T02:00:00.000Z", endReason: "ttl" }),
      ])
      const registry = createDeviceRegistry(fakeRegistry([record()]), hosts)
      expect((await registry.list()).map(d => d.name).sort()).toEqual(["ci-live", "jeremy@laptop"])
      const all = await registry.list({ includeEnded: true })
      expect(all.map(d => d.name).sort()).toEqual(["ci-gone", "ci-live", "jeremy@laptop"])
      expect(all.find(d => d.name === "ci-gone")).toMatchObject({ ended: true, endedAt: "2026-02-02T02:00:00.000Z" })
      expect(all.find(d => d.name === "ci-live")).not.toHaveProperty("ended")
      // A paired client device is never hidden.
      expect((await registry.list()).some(d => d.role === "client")).toBe(true)
    })

    it("surfaces stale on a manually added host that is unreachable past the TTL", async () => {
      const hosts = fakeHostRegistry([hostRecord({ stale: true })])
      const [device] = await createDeviceRegistry(fakeRegistry([]), hosts).list()
      expect(device).toMatchObject({ stale: true })
      expect(device).not.toHaveProperty("ended")
    })

    it("forwardHttp() delegates to the host registry", async () => {
      const registry = fakeRegistry([])
      const hosts = fakeHostRegistry([hostRecord()])
      ;(hosts.forwardHttp as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 200,
        headers: {},
        body: new Uint8Array(),
      })
      const devices = createDeviceRegistry(registry, hosts)
      const res = await devices.forwardHttp("hfp1", { method: "GET", path: "/sessions" })
      expect(hosts.forwardHttp).toHaveBeenCalledWith("hfp1", { method: "GET", path: "/sessions" })
      expect(res.status).toBe(200)
    })

    it("forwardHttp() falls back to a cached snapshot for a GET /sessions* path when the live forward fails", async () => {
      const registry = fakeRegistry([])
      const hosts = fakeHostRegistry([hostRecord()])
      ;(hosts.forwardHttp as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("could not reach host"))
      ;(hosts.getSessionsSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
        status: 200,
        headers: {},
        body: new TextEncoder().encode('{"sessions":[]}'),
        stale: true,
        capturedAt: "2026-01-01T00:00:00.000Z",
      })
      const devices = createDeviceRegistry(registry, hosts)
      const res = await devices.forwardHttp("hfp1", { method: "GET", path: "/sessions" })
      expect(hosts.getSessionsSnapshot).toHaveBeenCalledWith("hfp1", "/sessions")
      expect(res).toMatchObject({ status: 200, stale: true, capturedAt: "2026-01-01T00:00:00.000Z" })
    })

    it("forwardHttp() rethrows when the live forward fails AND there's no cached snapshot", async () => {
      const registry = fakeRegistry([])
      const hosts = fakeHostRegistry([hostRecord()])
      ;(hosts.forwardHttp as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("could not reach host"))
      const devices = createDeviceRegistry(registry, hosts)
      await expect(devices.forwardHttp("hfp1", { method: "GET", path: "/sessions" })).rejects.toThrow(
        /could not reach host/,
      )
    })

    it("forwardHttp() never falls back for a non-/sessions path (e.g. exec) — stale data there would be actively wrong", async () => {
      const registry = fakeRegistry([])
      const hosts = fakeHostRegistry([hostRecord()])
      ;(hosts.forwardHttp as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("could not reach host"))
      const devices = createDeviceRegistry(registry, hosts)
      await expect(devices.forwardHttp("hfp1", { method: "POST", path: "/exec" })).rejects.toThrow(
        /could not reach host/,
      )
      expect(hosts.getSessionsSnapshot).not.toHaveBeenCalled()
    })
  })

  it("add() rejects when no HostRegistry was wired", async () => {
    const registry = fakeRegistry([])
    const devices = createDeviceRegistry(registry)
    await expect(devices.add("agentproto://pair?v=2&…")).rejects.toThrow(/no host registry/)
  })

  it("forwardHttp() rejects when no HostRegistry was wired", async () => {
    const registry = fakeRegistry([])
    const devices = createDeviceRegistry(registry)
    await expect(devices.forwardHttp("fp1", { method: "GET", path: "/sessions" })).rejects.toThrow(
      /no host registry/,
    )
  })
})
