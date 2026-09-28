import { mkdtemp, stat, writeFile, chmod } from "node:fs/promises"
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
