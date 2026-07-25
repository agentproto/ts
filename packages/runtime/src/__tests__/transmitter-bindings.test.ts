import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTransmitterBindingStore } from "../transmitter-bindings.js"

describe("TransmitterBindingStore", () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), "transmitter-bindings-test-"))
    filePath = join(dir, "transmitter-bindings.json")
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it("upsert -> get round trip", () => {
    const store = createTransmitterBindingStore({ filePath, debounceMs: 100 })

    const binding = store.upsert({
      alias: "agentpush",
      source: "+33612345678",
      contactRef: "contact-1",
      sessionId: "sess-1",
      mode: "route",
    })

    expect(binding.sessionId).toBe("sess-1")
    expect(store.get("agentpush", "+33612345678", "contact-1")).toEqual(binding)
    expect(store.get("agentpush", "+33612345678", "unknown")).toBeUndefined()
  })

  it("remove deletes a binding and returns false for unknown keys", () => {
    const store = createTransmitterBindingStore({ filePath, debounceMs: 100 })
    store.upsert({
      alias: "agentpush",
      source: "+33612345678",
      contactRef: "contact-1",
      sessionId: "sess-1",
      mode: "route",
    })

    expect(store.remove("agentpush", "+33612345678", "contact-1")).toBe(true)
    expect(store.get("agentpush", "+33612345678", "contact-1")).toBeUndefined()
    expect(store.remove("agentpush", "+33612345678", "contact-1")).toBe(false)
  })

  it("list returns all bindings", () => {
    const store = createTransmitterBindingStore({ filePath, debounceMs: 100 })
    store.upsert({
      alias: "agentpush",
      source: "s1",
      contactRef: "c1",
      sessionId: "sess-1",
      mode: "route",
    })
    store.upsert({
      alias: "agentpush",
      source: "s2",
      contactRef: "c2",
      sessionId: "sess-2",
      mode: "route-or-spawn",
    })

    const list = store.list()
    expect(list).toHaveLength(2)
    expect(list.map(b => b.sessionId).sort()).toEqual(["sess-1", "sess-2"])
  })

  it("lastSeenTs auto-stamps on upsert when not explicitly passed", () => {
    const nowMs = vi.fn(() => 12_345)
    const store = createTransmitterBindingStore({ filePath, debounceMs: 100, nowMs })

    const binding = store.upsert({
      alias: "agentpush",
      source: "s1",
      contactRef: "c1",
      sessionId: "sess-1",
      mode: "route",
    })

    expect(binding.lastSeenTs).toBe(12_345)
    expect(nowMs).toHaveBeenCalled()
  })

  it("lastSeenTs is preserved when explicitly passed", () => {
    const nowMs = vi.fn(() => 12_345)
    const store = createTransmitterBindingStore({ filePath, debounceMs: 100, nowMs })

    const binding = store.upsert({
      alias: "agentpush",
      source: "s1",
      contactRef: "c1",
      sessionId: "sess-1",
      mode: "route",
      lastSeenTs: 999,
    })

    expect(binding.lastSeenTs).toBe(999)
  })

  it("persists to disk (debounced) and a second instance reads it back", async () => {
    // Real timers here: the debounced write goes through actual fs I/O,
    // which fake timers do not advance.
    vi.useRealTimers()

    const storeA = createTransmitterBindingStore({ filePath, debounceMs: 10 })
    storeA.upsert({
      alias: "agentpush",
      source: "+33612345678",
      contactRef: "contact-1",
      sessionId: "sess-1",
      mode: "route-or-spawn",
      lastSeenTs: 42,
    })

    // Let the debounced write settle.
    await new Promise(r => setTimeout(r, 100))

    const storeB = createTransmitterBindingStore({ filePath, debounceMs: 10 })
    const binding = storeB.get("agentpush", "+33612345678", "contact-1")
    expect(binding).toEqual({
      alias: "agentpush",
      source: "+33612345678",
      contactRef: "contact-1",
      sessionId: "sess-1",
      mode: "route-or-spawn",
      lastSeenTs: 42,
    })
  })

  it("starts empty and logs a warning when the file is corrupt, never throws", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    writeFileSync(filePath, "{ not json")

    const store = createTransmitterBindingStore({ filePath, debounceMs: 100 })

    expect(store.list()).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("starts empty without warning when the file is missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const store = createTransmitterBindingStore({ filePath, debounceMs: 100 })

    expect(store.list()).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
