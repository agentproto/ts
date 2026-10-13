/**
 * Probe-cache semantics: bounded, TTL-expiring, concurrency-coalescing results
 * shared by the sentinel / tunnel / sandbox registries, plus the discovery
 * cache's identical behavior over the package list. The real-ESM behavior of
 * the default preflight and importer (bundled Node, async hooks, conditional
 * exports) is covered separately in `provider-probes-node.test.ts`.
 */

import { describe, expect, it } from "vitest"

import {
  createAdapterDiscoveryCache,
  createProviderProbeCache,
  missingSyncDefault,
  PROBE_TTL_MS,
  type ProviderModule,
} from "../provider-probes"

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("createProviderProbeCache", () => {
  it("caches a successful import namespace instead of re-importing", async () => {
    let calls = 0
    const cache = createProviderProbeCache({
      importModule: async (specifier) => {
        calls++
        return { specifier, calls }
      },
    })

    const first = await cache.probe("@agentproto/adapter-alpha")
    const second = await cache.probe("@agentproto/adapter-alpha")

    expect(first).toEqual({ specifier: "@agentproto/adapter-alpha", calls: 1 })
    expect(second).toBe(first)
    expect(calls).toBe(1)
    expect(cache.size).toBe(1)
  })

  it("caches a failed import as null until invalidated", async () => {
    let calls = 0
    const cache = createProviderProbeCache({
      importModule: async () => {
        calls++
        throw new Error("boom")
      },
    })

    expect(await cache.probe("@agentproto/adapter-broken")).toBeNull()
    expect(await cache.probe("@agentproto/adapter-broken")).toBeNull()
    expect(calls).toBe(1)

    cache.invalidate("@agentproto/adapter-broken")
    expect(await cache.probe("@agentproto/adapter-broken")).toBeNull()
    expect(calls).toBe(2)
  })

  it("never reaches the importer when the sync preflight proves the package missing", async () => {
    let importerCalls = 0
    const cache = createProviderProbeCache({
      missingSync: (specifier) => specifier === "@agentproto/adapter-absent",
      importModule: async () => {
        importerCalls++
        return {}
      },
    })

    expect(await cache.probe("@agentproto/adapter-absent")).toBeNull()
    expect(await cache.probe("@agentproto/adapter-absent")).toBeNull()
    expect(importerCalls).toBe(0)
  })

  it("coalesces concurrent probes of one specifier into a single import", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = createProviderProbeCache({
      importModule: async (specifier) => {
        calls++
        await gate
        return { specifier }
      },
    })

    const probes = Promise.all(
      Array.from({ length: 5 }, () => cache.probe("@agentproto/adapter-alpha")),
    )
    release?.()
    const results = await probes

    expect(calls).toBe(1)
    for (const result of results) {
      expect(result).toEqual({ specifier: "@agentproto/adapter-alpha" })
    }
  })

  it("coalesces concurrent failed probes into a single import attempt", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = createProviderProbeCache({
      importModule: async () => {
        calls++
        await gate
        throw new Error("boom")
      },
    })

    const probes = Promise.all(
      Array.from({ length: 4 }, () => cache.probe("@agentproto/adapter-gone")),
    )
    release?.()
    expect(await probes).toEqual([null, null, null, null])
    expect(calls).toBe(1)
  })

  it("lets a missing provider recover after the TTL lapses", async () => {
    let clock = 1_000
    let calls = 0
    const cache = createProviderProbeCache({
      now: () => clock,
      ttlMs: 60_000,
      importModule: async () => {
        calls++
        if (calls === 1) throw new Error("not installed yet")
        return { installed: true }
      },
    })

    expect(await cache.probe("@agentproto/adapter-late")).toBeNull()

    clock += 59_999
    expect(await cache.probe("@agentproto/adapter-late")).toBeNull()
    expect(calls).toBe(1)

    clock += 1
    expect(await cache.probe("@agentproto/adapter-late")).toEqual({
      installed: true,
    })
    expect(calls).toBe(2)
  })

  it("does not write an in-flight probe's stale result back after invalidation", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = createProviderProbeCache({
      importModule: async () => {
        await gate
        return { stale: true }
      },
    })

    const inFlight = cache.probe("@agentproto/adapter-raced")
    await tick()
    cache.invalidate("@agentproto/adapter-raced")
    release?.()

    expect(await inFlight).toEqual({ stale: true })
    // The pre-invalidation result must not be served from the cache.
    expect(cache.size).toBe(0)
  })

  it("bounds the cache by LRU recency", async () => {
    const imports: string[] = []
    const cache = createProviderProbeCache({
      maxEntries: 2,
      importModule: async (specifier) => {
        imports.push(specifier)
        return { specifier }
      },
    })

    await cache.probe("pkg-a")
    await cache.probe("pkg-b")
    // Touch pkg-a so pkg-b becomes the least-recently used entry.
    await cache.probe("pkg-a")
    await cache.probe("pkg-c")

    expect(cache.size).toBe(2)
    // pkg-a survived the bound and is still served from the cache.
    await cache.probe("pkg-a")
    expect(imports).toEqual(["pkg-a", "pkg-b", "pkg-c"])
    // pkg-b was evicted (least-recently used), so a second probe re-imports
    // it — that second import is the proof of eviction, not just the size.
    expect(await cache.probe("pkg-b")).toEqual({ specifier: "pkg-b" })
    expect(imports).toEqual(["pkg-a", "pkg-b", "pkg-c", "pkg-b"])
  })

  it("drops every entry on invalidate()", async () => {
    let calls = 0
    const cache = createProviderProbeCache({
      importModule: async (specifier) => {
        calls++
        return { specifier }
      },
    })

    await cache.probe("pkg-a")
    await cache.probe("pkg-b")
    expect(cache.size).toBe(2)

    cache.invalidate()
    expect(cache.size).toBe(0)

    await cache.probe("pkg-a")
    expect(calls).toBe(3)
  })

  it("passes through a real dynamic import of a builtin under the default importer", async () => {
    const cache = createProviderProbeCache()
    const ns = await cache.probe("node:path")
    expect(typeof ns?.basename).toBe("function")
    expect(await cache.probe("node:path")).toBe(ns)
  })

  it("exports the daemon's 60s probe window", () => {
    expect(PROBE_TTL_MS).toBe(60_000)
  })
})

describe("missingSyncDefault", () => {
  it("answers false for a specifier that is provably present (or undecidable here)", () => {
    // Under real Node this resolves; under vite/vitest `import.meta.resolve`
    // is absent and the check degrades to "not provably missing". Either way
    // a builtin is never classified missing.
    expect(missingSyncDefault("node:path")).toBe(false)
  })

  it("answers false rather than guessing when import.meta.resolve is unavailable", () => {
    // vite rewrites import.meta without resolve; the guard must degrade to
    // the normal import path instead of treating everything as missing.
    if (typeof (import.meta as { resolve?: unknown }).resolve !== "function") {
      expect(missingSyncDefault("@agentproto/definitely-not-installed")).toBe(
        false,
      )
    }
  })
})

describe("createAdapterDiscoveryCache", () => {
  it("caches the discovered list and coalesces concurrent walks", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = createAdapterDiscoveryCache({
      discover: async () => {
        calls++
        await gate
        return [
          { slug: "alpha", packageName: "@agentproto/adapter-alpha" },
          { slug: "beta", packageName: "@agentproto/adapter-beta" },
        ]
      },
    })

    const walks = Promise.all([
      cache.discover({ start: "/ws" }),
      cache.discover({ start: "/ws" }),
      cache.discover({ start: "/ws" }),
    ])
    release?.()
    const [a, b, c] = await walks

    expect(calls).toBe(1)
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(a).toEqual([
      { slug: "alpha", packageName: "@agentproto/adapter-alpha" },
      { slug: "beta", packageName: "@agentproto/adapter-beta" },
    ])
  })

  it("keys the cache per start root", async () => {
    const starts: string[] = []
    const cache = createAdapterDiscoveryCache({
      discover: async (opts) => {
        starts.push(opts?.start ?? "")
        return [{ slug: "alpha", packageName: "@agentproto/adapter-alpha" }]
      },
    })

    await cache.discover({ start: "/ws-a" })
    await cache.discover({ start: "/ws-b" })
    await cache.discover({ start: "/ws-a" })

    expect(starts).toEqual(["/ws-a", "/ws-b"])
    expect(cache.size).toBe(2)
  })

  it("re-walks after the TTL lapses or invalidate()", async () => {
    let clock = 1_000
    let calls = 0
    const cache = createAdapterDiscoveryCache({
      now: () => clock,
      ttlMs: 60_000,
      discover: async () => {
        calls++
        return [{ slug: `walk-${calls}`, packageName: `pkg-${calls}` }]
      },
    })

    expect(await cache.discover({ start: "/ws" })).toEqual([
      { slug: "walk-1", packageName: "pkg-1" },
    ])
    clock += 60_000
    expect(await cache.discover({ start: "/ws" })).toEqual([
      { slug: "walk-2", packageName: "pkg-2" },
    ])

    cache.invalidate()
    expect(cache.size).toBe(0)
    expect(await cache.discover({ start: "/ws" })).toEqual([
      { slug: "walk-3", packageName: "pkg-3" },
    ])
  })

  it("bounds distinct start roots by recency", async () => {
    const cache = createAdapterDiscoveryCache({
      maxEntries: 2,
      discover: async () => [],
    })

    await cache.discover({ start: "/ws-a" })
    await cache.discover({ start: "/ws-b" })
    await cache.discover({ start: "/ws-a" })
    await cache.discover({ start: "/ws-c" })

    expect(cache.size).toBe(2)
  })
})
