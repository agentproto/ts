import { describe, expect, it, vi } from "vitest"
import { readAll } from "../index"
import { initStore } from "../node"
import { testDir } from "./helpers"

const hooks = vi.hoisted(() => ({ failNext: false }))
vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>()
  return {
    ...m,
    appendFile: async (p: never, d: unknown, ...rest: never[]) => {
      if (hooks.failNext) {
        hooks.failNext = false
        // A partial append: half the bytes land, then the write fails.
        await m.appendFile(p, String(d).slice(0, Math.floor(String(d).length / 2)))
        throw new Error("disk full")
      }
      return (m.appendFile as (...a: unknown[]) => Promise<void>)(p, d, ...rest)
    },
  }
})

describe("disk store append errors", () => {
  it("closes a torn tail before a retry through the same handle", async () => {
    const d = await testDir()
    try {
      const store = await initStore(d.path)
      await store.createRun("r1", { sources: [{ connector: "x", queries: [] }], workers: 1 } as never)
      const at = "2026-11-28T10:00:00.000Z"
      await store.appendEvent("r1", { at, type: "first" })
      hooks.failNext = true
      await expect(store.appendEvent("r1", { at, type: "torn" })).rejects.toThrow("disk full")
      await store.appendEvent("r1", { at, type: "retry" })
      const out = await readAll(store.events("r1"))
      expect(out.records.map((e) => e.type)).toEqual(["first", "retry"])
      expect(out.skipped).toBe(1)
    } finally {
      await d.cleanup()
    }
  })
})
