/**
 * `loadConfig` is called on every spawn and by several per-call resolvers
 * (worktree-isolation, spawn-attach, spawn-dedupe, session-presence, ...), so
 * a schema-invalid file must warn ONCE per (path, content) pair, not once per
 * call — see the `warnedInvalidConfigHashes` memo in `config.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../config.js"

let tmpDir: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentproto-config-warn-"))
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("loadConfig — schema-issue warning is memoized per (path, content)", () => {
  it("warns once across repeated loads of the same invalid content", async () => {
    const target = join(tmpDir, "config.json")
    writeFileSync(target, JSON.stringify({ daemon: { port: "not-a-number" } }))

    await loadConfig(target)
    await loadConfig(target)
    await loadConfig(target)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain("schema issue")
  })

  it("warns again after the file content changes", async () => {
    const target = join(tmpDir, "config.json")
    writeFileSync(target, JSON.stringify({ daemon: { port: "not-a-number" } }))
    await loadConfig(target)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    writeFileSync(target, JSON.stringify({ daemon: { bind: 123 } }))
    await loadConfig(target)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it("does not warn at all for a valid config", async () => {
    const target = join(tmpDir, "config.json")
    writeFileSync(target, JSON.stringify({ daemon: { port: 18790 } }))

    await loadConfig(target)
    await loadConfig(target)

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("warns again for a DIFFERENT path even with identical invalid content", async () => {
    const targetA = join(tmpDir, "a.json")
    const targetB = join(tmpDir, "b.json")
    const raw = JSON.stringify({ daemon: { port: "not-a-number" } })
    writeFileSync(targetA, raw)
    writeFileSync(targetB, raw)

    await loadConfig(targetA)
    await loadConfig(targetB)

    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})
