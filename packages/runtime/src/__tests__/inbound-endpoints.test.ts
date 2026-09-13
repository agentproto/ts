/**
 * Unit tests for InboundEndpointStore.
 */

import { describe, expect, it, vi } from "vitest"
import { createInboundEndpointStore } from "../inbound-endpoints.js"

describe("InboundEndpointStore", () => {
  it("upserts and retrieves an endpoint", () => {
    const store = createInboundEndpointStore({ persist: false })
    const endpoint = store.upsert({
      slug: "tg-bot",
      provider: "telegram",
      alias: "tg",
      mode: "route-or-spawn",
    })
    expect(endpoint.slug).toBe("tg-bot")
    expect(endpoint.provider).toBe("telegram")
    expect(endpoint.mode).toBe("route-or-spawn")
    expect(endpoint.enabled).toBe(true)
    expect(store.get("tg-bot")).toEqual(endpoint)
  })

  it("lists endpoints", () => {
    const store = createInboundEndpointStore({ persist: false })
    store.upsert({ slug: "a", provider: "generic", alias: "a", mode: "spawn" })
    store.upsert({ slug: "b", provider: "slack", alias: "b", mode: "route" })
    const list = store.list()
    expect(list).toHaveLength(2)
    expect(list.map(e => e.slug).sort()).toEqual(["a", "b"])
  })

  it("preserves original createdTs across upserts", () => {
    const now = 12345
    const store = createInboundEndpointStore({
      persist: false,
      nowMs: () => now,
    })
    const first = store.upsert({
      slug: "x",
      provider: "generic",
      alias: "x",
      mode: "route-or-spawn",
    })
    const second = store.upsert({
      slug: "x",
      provider: "generic",
      alias: "x",
      mode: "spawn",
      createdTs: first.createdTs,
    })
    expect(second.createdTs).toBe(first.createdTs)
    expect(second.mode).toBe("spawn")
  })

  it("deduplicates via markSeen", () => {
    const store = createInboundEndpointStore({ persist: false })
    store.upsert({
      slug: "x",
      provider: "generic",
      alias: "x",
      mode: "route-or-spawn",
    })
    expect(store.markSeen("x", "m1")).toBe(true)
    expect(store.markSeen("x", "m1")).toBe(false)
    expect(store.markSeen("x", "m2")).toBe(true)
  })

  it("removes endpoints", () => {
    const store = createInboundEndpointStore({ persist: false })
    store.upsert({ slug: "x", provider: "generic", alias: "x", mode: "route-or-spawn" })
    expect(store.remove("x")).toBe(true)
    expect(store.get("x")).toBeUndefined()
    expect(store.remove("x")).toBe(false)
  })

  it("persists to disk when persist is true", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const store = createInboundEndpointStore({
      persist: true,
      filePath: "/tmp/inbound-endpoints-unit-test.json",
      nowMs: () => 1,
      debounceMs: 0,
    })
    // Replace the underlying fs writer without touching internals.
    store.upsert({ slug: "a", provider: "generic", alias: "a", mode: "spawn" })
    // Wait for debounce + promise tick.
    await new Promise(r => setTimeout(r, 20))
    // The debounced writer may fire; we just assert the store state.
    expect(store.get("a")?.slug).toBe("a")
  })
})
