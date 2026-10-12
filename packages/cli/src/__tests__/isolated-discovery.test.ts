import { describe, it, expect, vi } from "vitest"
import { createIsolatedDiscovery, discoveryWorkerPath, runDiscoveryWorker } from "../registry/isolated-discovery.js"
import { fileURLToPath } from "node:url"

describe("isolated adapter discovery", () => {
  it("resolves the built worker from bundled and TypeScript source entry points", () => {
    const expected = fileURLToPath(new URL("../../dist/adapter-discovery-worker.mjs", import.meta.url))
    expect(discoveryWorkerPath(new URL("../../dist/cli.mjs", import.meta.url).href)).toBe(expected)
    expect(discoveryWorkerPath(new URL("../../dist/index.mjs", import.meta.url).href)).toBe(expected)
    expect(discoveryWorkerPath(new URL("../registry/isolated-discovery.ts", import.meta.url).href)).toBe(expected)
  })

  it("forks and receives metadata when the caller runs from TypeScript source", async () => {
    const listing = await runDiscoveryWorker({ kind: "adapters" })
    expect(Array.isArray(listing)).toBe(true)
    expect(listing).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "claude-code" })]))
  }, 30_000)

  it("coalesces polling, expires metadata, and invalidates after installs", async () => {
    let now = 0
    const run = vi.fn(async () => [{ slug: "claude-code" }])
    const discovery = createIsolatedDiscovery(run, () => now)
    await Promise.all([discovery.adapters(), discovery.adapters()])
    await discovery.adapters()
    expect(run).toHaveBeenCalledTimes(1)
    now = 60_001
    await discovery.adapters()
    expect(run).toHaveBeenCalledTimes(2)
    discovery.invalidate()
    await discovery.adapters()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("serializes distinct requests to bound transient worker memory", async () => {
    let finish!: (result: unknown) => void
    const run = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue([])
    const discovery = createIsolatedDiscovery(run)
    const adapters = discovery.adapters()
    const capabilities = discovery.capabilities()
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    finish([])
    await Promise.all([adapters, capabilities])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("retries failed discovery instead of retaining the failure", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("rebuilding")).mockResolvedValue([])
    const discovery = createIsolatedDiscovery(run)
    await expect(discovery.adapters()).rejects.toThrow("rebuilding")
    await expect(discovery.adapters()).resolves.toEqual([])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("keeps the queue bound across invalidation while old probes are outstanding", async () => {
    let finish!: (result: unknown) => void
    const run = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue([])
    const discovery = createIsolatedDiscovery(run)
    const probes = Array.from({ length: 32 }, (_, i) => discovery.capabilities({ adapter: `adapter-${i}` }))
    await Promise.resolve()
    discovery.invalidate()
    await expect(discovery.adapters()).rejects.toThrow("queue is full")
    finish([])
    await Promise.all(probes)
    await expect(discovery.adapters()).resolves.toEqual([])
    expect(run).toHaveBeenCalledTimes(33)
  })

  it("does not cache an obsolete result that finishes after invalidation", async () => {
    let finish!: (result: unknown) => void
    const run = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue([])
    const discovery = createIsolatedDiscovery(run)
    const previous = discovery.adapters()
    await Promise.resolve()
    discovery.invalidate()
    finish([])
    await previous
    await discovery.adapters()
    expect(run).toHaveBeenCalledTimes(2)
  })
})
