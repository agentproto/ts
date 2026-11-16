import { createRequire } from "node:module"
import { promises as fs } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

// Use a fresh process: other tests import the real adapter before corrupting
// its dist, and the Node module cache can otherwise hide the broken file.
describe("resolveAdapter — transient import failure", () => {
  it("reports an installed but broken adapter without suggesting a reinstall", { timeout: 30_000 }, async () => {
    const path = createRequire(import.meta.url).resolve("@agentproto/adapter-pi")
    const original = await fs.readFile(path)
    try {
      await fs.writeFile(path, "{")
      const source = new URL("../registry/resolve.ts", import.meta.url).href
      const script = `import { resolveAdapter } from ${JSON.stringify(source)};
        try { await resolveAdapter("pi"); process.exitCode = 1 }
        catch (error) { console.log(error instanceof Error ? error.message : String(error)) }`
      const require = createRequire(import.meta.url)
      const loader = createRequire(require.resolve("tsup/package.json")).resolve("tsx")
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", script])
      expect(stdout).toMatch(/resolves on disk but could not be imported/)
      expect(stdout).not.toMatch(/agentproto install/i)
      expect(stdout).not.toMatch(/npm i -g/i)
    } finally {
      await fs.writeFile(path, original)
    }
  })
})
