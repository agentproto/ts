import { mkdtemp, stat, writeFile, readFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { registerLocalBrowser, unregisterLocalBrowser } from "../register.js"

const opts = (importsPath: string) => ({
  userDataDir: "/tmp/ud",
  profileDirectory: "Default",
  chromeMcpBin: "/tmp/chrome-devtools-mcp",
  importsPath,
})

describe("imported-mcps.json file mode", () => {
  it("register writes 0600, even over a pre-existing 0644 file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lb-register-"))
    const path = join(dir, "imported-mcps.json")
    await writeFile(path, JSON.stringify({ version: 1, imports: [] }))
    await chmod(path, 0o644)
    await registerLocalBrowser(opts(path))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  it("unregister rewrites 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lb-unregister-"))
    const path = join(dir, "imported-mcps.json")
    await registerLocalBrowser(opts(path))
    await chmod(path, 0o644)
    const r = await unregisterLocalBrowser(path)
    expect(r.removed).toBe(1)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

describe("preserves P1 fields on other entries", () => {
  const other = {
    id: "claude-code:global:guilde",
    alias: "guilde",
    addedAt: "2026-01-01T00:00:00.000Z",
    origin: { kind: "claude-code", scope: "global", name: "guilde" },
    resolve: "live",
    secretRefs: {
      headers: { Authorization: "agentproto/mcp-import/claude-code:global:guilde#header:Authorization" },
    },
    snapshot: {
      id: "claude-code:global:guilde",
      source: "claude-code",
      scope: "global",
      name: "guilde",
      type: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "<secretRef>" },
    },
  }
  it("register keeps origin/resolve/secretRefs of other entries verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lb-p1-"))
    const path = join(dir, "imported-mcps.json")
    await writeFile(path, JSON.stringify({ version: 1, imports: [other] }))
    await registerLocalBrowser(opts(path))
    const after = JSON.parse(await readFile(path, "utf8"))
    expect(after.version).toBe(1)
    expect(after.imports.find((e: { id: string }) => e.id === other.id)).toEqual(other)
    const mine = after.imports.find((e: { id: string }) => e.id.startsWith("plugin:local-browser:"))
    expect(mine.resolve).toBe("snapshot")
    expect(mine.origin.kind).toBe("plugin")
  })
  it("unregister keeps them too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lb-p1u-"))
    const path = join(dir, "imported-mcps.json")
    await writeFile(path, JSON.stringify({ version: 1, imports: [other] }))
    await registerLocalBrowser(opts(path))
    await unregisterLocalBrowser(path)
    const after = JSON.parse(await readFile(path, "utf8"))
    expect(after.imports).toEqual([other])
  })
})
