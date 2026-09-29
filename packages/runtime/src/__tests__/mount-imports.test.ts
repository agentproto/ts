import { describe, expect, it } from "vitest"
import { mountImports } from "../session-spawn.js"
import type { ImportedMcpsConfig } from "../mcp-imports.js"

const imported = (entries: Array<[string, string]>): ImportedMcpsConfig => ({
  version: 1,
  imports: entries.map(([id, alias]) => ({
    id,
    alias,
    addedAt: "2026-01-01T00:00:00.000Z",
    snapshot: { id, source: "claude-code", scope: "global", name: alias, type: "http", url: "https://x.example" },
  })),
})

const ctx = (over: Partial<Parameters<typeof mountImports>[1]> = {}) => ({
  bundleId: "b",
  mcpMountUrl: "http://127.0.0.1:1/mcp" as string | undefined,
  sessionId: "sess 1",
  imported: imported([["a:1", "Alpha!"], ["b", "beta"]]),
  existing: [],
  ...over,
})

describe("mountImports", () => {
  it("builds slugified http entries with an encoded id and callerSessionId", () => {
    const r = mountImports(["a:1"], ctx())
    expect(r.warnings).toEqual([])
    expect(r.mounts).toEqual([
      { name: "alpha", transport: "http", ref: "http://127.0.0.1:1/mcp/imported/a%3A1?callerSessionId=sess%201" },
    ])
  })

  it("collision with an existing entry: existing wins, warns; also dedupes within one call", () => {
    const r = mountImports(["a:1", "b"], ctx({ existing: [{ name: "alpha", transport: "stdio", ref: "x" }] }))
    expect(r.mounts.map(m => m.name)).toEqual(["beta"])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain("existing one wins")
    const twice = mountImports(["b", "b"], ctx())
    expect(twice.mounts).toHaveLength(1)
    expect(twice.warnings).toHaveLength(1)
  })

  it("no mount URL (sandbox / no daemon URL) mounts nothing, silently", () => {
    expect(mountImports(["a:1"], ctx({ mcpMountUrl: undefined }))).toEqual({ mounts: [], warnings: [] })
    expect(mountImports("*", ctx({ mcpMountUrl: undefined }))).toEqual({ mounts: [], warnings: [] })
  })

  it('"*" expands to the current import set', () => {
    const r = mountImports("*", ctx())
    expect(r.mounts.map(m => m.name)).toEqual(["alpha", "beta"])
    expect(mountImports("*", ctx({ imported: imported([]) }))).toEqual({ mounts: [], warnings: [] })
  })

  it("a dangling id is skipped with a warning while others still mount", () => {
    const r = mountImports(["ghost", "b"], ctx())
    expect(r.mounts.map(m => m.name)).toEqual(["beta"])
    expect(r.warnings[0]).toContain('removed MCP import "ghost"')
  })
})
