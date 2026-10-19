/**
 * `createDeviceSandboxProvider` (DEVICES-PLAN PR-D) — `boot()` refuses
 * (with a clear message) when `target` doesn't match a known paired host,
 * and otherwise starts the loopback bridge and returns its `mcpUrl`.
 * `startDeviceSandboxBridge` itself is exercised in
 * `device-sandbox-bridge.test.ts`; this file only covers the provider's own
 * decision points (the host-known gate, `stop()` closing only the local
 * bridge — never the remote).
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import type { HostRegistry, HostRecord } from "../host-registry.js"
import {
  createDeviceSandboxProvider,
  DeviceOfflineError,
  isDeviceOfflineError,
} from "../sandbox-providers/device.js"

function fakeHostRegistry(
  hosts: Partial<HostRecord>[],
  liveness: { online?: boolean; forwardHttp?: HostRegistry["forwardHttp"] } = {},
): HostRegistry {
  return {
    list: vi.fn(async () => hosts as HostRecord[]),
    isOnline: vi.fn(() => liveness.online ?? true),
    forwardHttp: vi.fn(
      liveness.forwardHttp ??
        (async () => {
          throw new Error("not used in this test")
        }),
    ),
    forwardHttpStream: vi.fn(async () => {
      throw new Error("not used in this test")
    }),
  } as unknown as HostRegistry
}

describe("createDeviceSandboxProvider", () => {
  const bootedStops: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const stop of bootedStops.splice(0)) await stop().catch(() => {})
  })

  it("boot() throws a clear error naming the device when no host matches", async () => {
    const hostRegistry = fakeHostRegistry([{ fingerprint: "abc123", name: "other-device" }])
    const provider = createDeviceSandboxProvider("work-mac", hostRegistry)

    await expect(provider.boot({ provider: "device:work-mac", config: {} }, { env: {} })).rejects.toThrow(
      /no paired host device matches "work-mac"/,
    )
  })

  it("boot() matches by name OR by fingerprint", async () => {
    const hostRegistry = fakeHostRegistry([{ fingerprint: "abc123", name: "work-mac" }])
    const provider = createDeviceSandboxProvider("work-mac", hostRegistry)
    const booted = await provider.boot({ provider: "device:work-mac", config: {} }, { env: {} })
    bootedStops.push(booted.stop)
    expect(booted.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(booted.sandboxId).toMatch(/^device-work-mac-/)

    const provider2 = createDeviceSandboxProvider("abc123", fakeHostRegistry([{ fingerprint: "abc123", name: "work-mac" }]))
    const booted2 = await provider2.boot({ provider: "device:abc123", config: {} }, { env: {} })
    bootedStops.push(booted2.stop)
    expect(booted2.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  })

  it("boot() skips the liveness probe for a device already known online", async () => {
    const hostRegistry = fakeHostRegistry([{ fingerprint: "abc123", name: "work-mac" }], { online: true })
    const booted = await createDeviceSandboxProvider("work-mac", hostRegistry).boot(
      { provider: "device:work-mac", config: {} },
      { env: {} },
    )
    bootedStops.push(booted.stop)
    expect(hostRegistry.forwardHttp).not.toHaveBeenCalled()
  })

  it("boot() probes /health on a device not known online and proceeds when it answers", async () => {
    const forwardHttp = vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() }))
    const hostRegistry = fakeHostRegistry([{ fingerprint: "abc123", name: "work-mac" }], {
      online: false,
      forwardHttp,
    })
    const booted = await createDeviceSandboxProvider("work-mac", hostRegistry).boot(
      { provider: "device:work-mac", config: {} },
      { env: {} },
    )
    bootedStops.push(booted.stop)
    expect(forwardHttp).toHaveBeenCalledWith("abc123", { method: "GET", path: "/health" })
  })

  it("boot() throws a typed device_offline error when the probe fails", async () => {
    const hostRegistry = fakeHostRegistry(
      [{ fingerprint: "abc123", name: "work-mac", lastSeen: "2026-10-19T08:00:00.000Z" }],
      {
        online: false,
        forwardHttp: async () => {
          throw new Error("rendezvous: peer not connected")
        },
      },
    )
    const err = await createDeviceSandboxProvider("work-mac", hostRegistry)
      .boot({ provider: "device:work-mac", config: {} }, { env: {} })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceOfflineError)
    expect(isDeviceOfflineError(err)).toBe(true)
    expect((err as DeviceOfflineError).code).toBe("device_offline")
    expect((err as Error).message).toMatch(/"work-mac" is offline.*last seen 2026-10-19T08:00:00.000Z.*peer not connected/)
  })

  it("boot() calls a device offline when the probe never answers", async () => {
    const hostRegistry = fakeHostRegistry([{ fingerprint: "abc123", name: "work-mac" }], {
      online: false,
      forwardHttp: () => new Promise(() => {}),
    })
    await expect(
      createDeviceSandboxProvider("work-mac", hostRegistry, { probeTimeoutMs: 20 }).boot(
        { provider: "device:work-mac", config: {} },
        { env: {} },
      ),
    ).rejects.toThrow(/offline.*no answer within 20 ms/)
  })

  it("boot() calls a device offline when /health answers a 5xx", async () => {
    const hostRegistry = fakeHostRegistry([{ fingerprint: "abc123", name: "work-mac" }], {
      online: false,
      forwardHttp: async () => ({ status: 502, headers: {}, body: new Uint8Array() }),
    })
    await expect(
      createDeviceSandboxProvider("work-mac", hostRegistry).boot(
        { provider: "device:work-mac", config: {} },
        { env: {} },
      ),
    ).rejects.toSatisfy(isDeviceOfflineError)
  })

  it("stop() only closes the local bridge — never calls back into hostRegistry", async () => {
    const hostRegistry = fakeHostRegistry([{ fingerprint: "abc123", name: "work-mac" }])
    const provider = createDeviceSandboxProvider("work-mac", hostRegistry)
    const booted = await provider.boot({ provider: "device:work-mac", config: {} }, { env: {} })
    await booted.stop()
    // forwardHttpStream was never invoked by boot/stop themselves (only a
    // live request through the bridge would call it).
    expect(hostRegistry.forwardHttpStream).not.toHaveBeenCalled()
    // A second stop() (defensive) must not throw.
    await expect(booted.stop()).resolves.toBeUndefined()
  })
})
