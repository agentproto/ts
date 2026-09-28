/**
 * Unit tests for SentinelStore.
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSentinelStore, SentinelTargetNotImplementedError } from "../sentinel-store.js"
import { singleMatch, type SentinelSpec } from "../sentinel-providers/types.js"

const testSpec: SentinelSpec = {
  match: singleMatch("github:agentproto/ts#1"),
  until: { kind: "never" },
  target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
}

describe("SentinelStore", () => {
  it("creates a sentinel with a sen_ id and active status", () => {
    const store = createSentinelStore({ persist: false })
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake" },
      spec: testSpec,
    })
    expect(sentinel.id).toMatch(/^sen_/)
    expect(sentinel.status).toBe("active")
    expect(sentinel.eventCount).toBe(0)
    expect(sentinel.seen).toEqual([])
    expect(sentinel.terminalSubjects).toEqual([])
    expect(store.get(sentinel.id)).toEqual(sentinel)
  })

  it("rejects a routine or webhook target at create time (frozen shape, not implemented)", () => {
    const store = createSentinelStore({ persist: false })
    expect(() =>
      store.create({
        provider: "fake",
        handle: { provider: "fake" },
        spec: { ...testSpec, target: { kind: "routine", routineId: "rt_1" } },
      }),
    ).toThrow(SentinelTargetNotImplementedError)
    expect(() =>
      store.create({
        provider: "fake",
        handle: { provider: "fake" },
        spec: { ...testSpec, target: { kind: "webhook", url: "https://example.com/hook", secret: "s3cr3t" } },
      }),
    ).toThrow(/not implemented/)
    expect(store.list()).toEqual([])
  })

  it("lists sentinels", () => {
    const store = createSentinelStore({ persist: false })
    store.create({ provider: "fake", handle: { provider: "fake" }, spec: testSpec })
    store.create({ provider: "fake", handle: { provider: "fake" }, spec: testSpec })
    expect(store.list()).toHaveLength(2)
  })

  it("updates a sentinel by shallow patch", () => {
    const store = createSentinelStore({ persist: false })
    const sentinel = store.create({ provider: "fake", handle: { provider: "fake" }, spec: testSpec })
    const updated = store.update(sentinel.id, { status: "paused", eventCount: 3 })
    expect(updated?.status).toBe("paused")
    expect(updated?.eventCount).toBe(3)
    expect(updated?.spec).toEqual(testSpec) // untouched fields survive the patch
    expect(store.update("sen_missing", { status: "paused" })).toBeUndefined()
  })

  it("removes a sentinel", () => {
    const store = createSentinelStore({ persist: false })
    const sentinel = store.create({ provider: "fake", handle: { provider: "fake" }, spec: testSpec })
    expect(store.remove(sentinel.id)).toBe(true)
    expect(store.get(sentinel.id)).toBeUndefined()
    expect(store.remove(sentinel.id)).toBe(false)
  })

  it("markSeen dedupes and bounds the window to 1000 ids", () => {
    const store = createSentinelStore({ persist: false })
    const sentinel = store.create({ provider: "fake", handle: { provider: "fake" }, spec: testSpec })
    expect(store.markSeen(sentinel.id, "evt_1")).toBe(true)
    expect(store.markSeen(sentinel.id, "evt_1")).toBe(false)
    expect(store.markSeen(sentinel.id, "evt_2")).toBe(true)

    for (let i = 0; i < 1000; i++) store.markSeen(sentinel.id, `evt_bulk_${i}`)
    const seen = store.get(sentinel.id)!.seen
    expect(seen.length).toBe(1000)
    // The earliest ids were evicted (FIFO) — only the most recent window survives.
    expect(seen).not.toContain("evt_1")
    expect(seen).toContain("evt_bulk_999")
  })

  it("isSeen is a read-only check that never marks — markSeen after it still returns true (new)", () => {
    const store = createSentinelStore({ persist: false })
    const sentinel = store.create({ provider: "fake", handle: { provider: "fake" }, spec: testSpec })
    expect(store.isSeen(sentinel.id, "evt_1")).toBe(false)
    // Calling isSeen repeatedly must not itself mark the id seen.
    expect(store.isSeen(sentinel.id, "evt_1")).toBe(false)
    expect(store.markSeen(sentinel.id, "evt_1")).toBe(true)
    expect(store.isSeen(sentinel.id, "evt_1")).toBe(true)
    // Once genuinely marked, a second markSeen correctly reports "not new".
    expect(store.markSeen(sentinel.id, "evt_1")).toBe(false)
  })

  it("isSeen on an unknown sentinel id returns false without throwing", () => {
    const store = createSentinelStore({ persist: false })
    expect(store.isSeen("sen_missing", "evt_1")).toBe(false)
  })

  it("markSeen on an unknown sentinel id returns true (treat-as-unseen) without throwing", () => {
    const store = createSentinelStore({ persist: false })
    expect(store.markSeen("sen_missing", "evt_1")).toBe(true)
  })

  it("persists atomically (tmp+rename) with mode 0600 and reloads across instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-store-"))
    const filePath = join(dir, "sentinels.json")
    try {
      const store1 = createSentinelStore({ filePath, persist: true, debounceMs: 0 })
      const sentinel = store1.create({ provider: "fake", handle: { provider: "fake" }, spec: testSpec })
      store1.flushSync()

      const raw = readFileSync(filePath, "utf8")
      expect(JSON.parse(raw)[sentinel.id].id).toBe(sentinel.id)
      const mode = statSync(filePath).mode & 0o777
      expect(mode).toBe(0o600)

      const store2 = createSentinelStore({ filePath, persist: true })
      expect(store2.get(sentinel.id)).toEqual(sentinel)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("degrades to an empty store on a corrupt file rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-store-corrupt-"))
    const filePath = join(dir, "sentinels.json")
    try {
      writeFileSync(filePath, "{not valid json")
      const store = createSentinelStore({ filePath, persist: true })
      expect(store.list()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
