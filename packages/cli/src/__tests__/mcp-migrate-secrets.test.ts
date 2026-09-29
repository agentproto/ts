import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadImportedMcps, saveImportedMcps } from "@agentproto/runtime/mcp-imports"
import { migrateSecrets } from "../commands/mcp.js"

const SECRET = "s3cr3t-literal-DO-NOT-LEAK"

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mcp-migrate-"))
  const path = join(dir, "imported-mcps.json")
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      imports: [
        {
          id: "claude-code:global:up",
          alias: "up",
          addedAt: "2026-01-01T00:00:00.000Z",
          snapshot: {
            id: "claude-code:global:up",
            source: "claude-code",
            scope: "global",
            name: "up",
            type: "http",
            url: "https://up.example/mcp",
            headers: { Authorization: `Bearer ${SECRET}` },
            env: { FROM_ENV: "${X_TOKEN}" },
          },
        },
        {
          id: "claude-code:global:clean",
          alias: "clean",
          addedAt: "2026-01-01T00:00:00.000Z",
          snapshot: { id: "claude-code:global:clean", source: "claude-code", scope: "global", name: "clean", type: "http", url: "https://c.example" },
        },
      ],
    })
  )
  const map = new Map<string, string>()
  let writes = 0
  const deps = {
    load: () => loadImportedMcps(path),
    save: async (c: Parameters<typeof saveImportedMcps>[0]) => {
      writes++
      await saveImportedMcps(c, path)
    },
    storeMcpSecret: async (ref: string, v: string) => void map.set(ref, v),
    resolveMcpSecret: async (ref: string) => map.get(ref),
  }
  return { path, map, deps, writes: () => writes }
}

describe("agentproto mcp migrate-secrets", () => {
  it("dry-run lists key names, touches neither disk nor store", async () => {
    const f = await fixture()
    const before = await readFile(f.path, "utf8")
    const mtime = (await stat(f.path)).mtimeMs
    const r = await migrateSecrets(false, f.deps)
    expect(r.lines).toEqual(["up: headers.Authorization"])
    expect(r.moved).toBe(0)
    expect(r.applied).toBe(false)
    expect(f.map.size).toBe(0)
    expect(f.writes()).toBe(0)
    expect(await readFile(f.path, "utf8")).toBe(before)
    expect((await stat(f.path)).mtimeMs).toBe(mtime)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it("--apply stores, verifies, rewrites once; secret gone from the file", async () => {
    const f = await fixture()
    const r = await migrateSecrets(true, f.deps)
    expect(r.moved).toBe(1)
    expect(f.writes()).toBe(1)
    expect([...f.map.values()]).toEqual([`Bearer ${SECRET}`])
    const raw = await readFile(f.path, "utf8")
    expect(raw).not.toContain(SECRET)
    expect(raw).toContain("${X_TOKEN}")
    expect(JSON.stringify(r)).not.toContain(SECRET)
    // Idempotent: nothing left to move.
    expect((await migrateSecrets(true, f.deps)).moved).toBe(0)
  })

  it("--apply with a failing store leaves the file untouched", async () => {
    const f = await fixture()
    const before = await readFile(f.path, "utf8")
    const r = await migrateSecrets(true, {
      ...f.deps,
      storeMcpSecret: async () => {
        throw new Error("locked")
      },
    })
    expect(r.moved).toBe(0)
    expect(r.warnings.join("")).not.toContain(SECRET)
    expect(await readFile(f.path, "utf8")).toBe(before)
  })
})
