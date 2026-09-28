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
import { createDeviceSandboxProvider } from "../sandbox-providers/device.js"

function fakeHostRegistry(hosts: Partial<HostRecord>[]): HostRegistry {
  return {
    list: vi.fn(async () => hosts as HostRecord[]),
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
