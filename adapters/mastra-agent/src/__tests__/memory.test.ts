import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mastraAgent } from "../index.js"
import { buildSqliteMemory, resolveMemoryDbPath } from "../memory.js"

describe("resolveMemoryDbPath", () => {
  it("honors the AGENTPROTO_MASTRA_MEMORY_DB override", () => {
    expect(
      resolveMemoryDbPath({ AGENTPROTO_MASTRA_MEMORY_DB: "/tmp/custom.db" }),
    ).toBe("/tmp/custom.db")
  })
  it("uses AGENTPROTO_MASTRA_STATE_HOME (confined spawn) instead of $HOME", () => {
    const dir = mkdtempSync(join(tmpdir(), "mastra-state-"))
    try {
      expect(resolveMemoryDbPath({ AGENTPROTO_MASTRA_STATE_HOME: dir })).toBe(join(dir, "memory.db"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it("declares a stateHome so a confined spawn is not sent to $HOME", () => {
    expect(mastraAgent.stateHome).toEqual({
      env: "AGENTPROTO_MASTRA_STATE_HOME",
      defaultDir: ".agentproto/mastra-agent",
    })
  })
  it("falls back to ~/.agentproto/mastra-agent/memory.db", () => {
    const p = resolveMemoryDbPath({})
    expect(p).toMatch(/\.agentproto\/mastra-agent\/memory\.db$/)
  })
})

describe("buildSqliteMemory", () => {
  it("returns undefined when scope is none (memory disabled)", () => {
    expect(buildSqliteMemory({ scope: "none" }, { AGENTPROTO_MASTRA_MEMORY_DB: "/tmp/x.db" }))
      .toBeUndefined()
  })
  it("builds a Memory instance for a normal config", () => {
    const mem = buildSqliteMemory(
      { scope: "per-conversation", retention_turns: 10 },
      { AGENTPROTO_MASTRA_MEMORY_DB: "/tmp/test-mem.db" },
    )
    expect(mem).toBeDefined()
    // Structural: a Mastra Memory exposes a getThreadById method.
    expect(typeof (mem as { getThreadById?: unknown }).getThreadById).toBe("function")
  })
})
