/**
 * Unit tests for `createDeviceRegistry` (DEVICES-PLAN PR-A) — the computed
 * "device" view over a `PairingRegistry`. Uses a fake registry (no real
 * pairing/rendezvous machinery) so these stay pure mapping/passthrough tests.
 */

import { describe, it, expect, vi } from "vitest"
import { createDeviceRegistry } from "../device-registry.js"
import type { PairingRecord, PairingRegistry } from "../pairing-registry.js"

function fakeRegistry(records: PairingRecord[], online: Set<string> = new Set()): PairingRegistry {
  return {
    createOffer: vi.fn(),
    list: async () => records.map(r => ({ ...r })),
    rename: vi.fn(async () => true),
    revoke: vi.fn(async () => true),
    isOnline: fp => online.has(fp),
    startAutoconnect: vi.fn(),
    shutdown: vi.fn(),
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
})
