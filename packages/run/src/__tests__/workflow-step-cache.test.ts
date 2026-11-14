import { describe, it, expect } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileStepCache } from "../workflow-step-cache.js"

describe("createFileStepCache", () => {
  it("set then get returns the entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wfcache-"))
    const cache = createFileStepCache("my-run", { dir })
    await cache.set("key1", { output: { n: 42 }, resolvedInputHash: "abc123" })
    const entry = await cache.get("key1")
    expect(entry).toEqual({ output: { n: 42 }, resolvedInputHash: "abc123" })
  })

  it("get of unknown key returns undefined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wfcache-"))
    const cache = createFileStepCache("my-run", { dir })
    const entry = await cache.get("nonexistent")
    expect(entry).toBeUndefined()
  })

  it("cacheKey with / and spaces round-trips via sanitized filename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wfcache-"))
    const tricky = "run/session with spaces"
    const cache = createFileStepCache(tricky, { dir })
    await cache.set("k", { output: "ok", resolvedInputHash: "h1" })
    const entry = await cache.get("k")
    expect(entry).toEqual({ output: "ok", resolvedInputHash: "h1" })
  })

  it("two different keys in the same cacheKey file coexist after two sets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wfcache-"))
    const cache = createFileStepCache("multi-key", { dir })
    await cache.set("a", { output: "A", resolvedInputHash: "ha" })
    // Recreate a fresh cache reading the same file
    const cache2 = createFileStepCache("multi-key", { dir })
    await cache2.set("b", { output: "B", resolvedInputHash: "hb" })
    // Both keys readable from a third instance
    const cache3 = createFileStepCache("multi-key", { dir })
    expect(await cache3.get("a")).toEqual({ output: "A", resolvedInputHash: "ha" })
    expect(await cache3.get("b")).toEqual({ output: "B", resolvedInputHash: "hb" })
  })
})
