import { createRequire } from "node:module"
import { promises as fs } from "node:fs"
import { describe, expect, it } from "vitest"
import { _resetLastKnownGoodForTests, resolveAdapter } from "../registry/resolve.js"

// Kept in a separate test module: earlier listInstalledAdapters calls import
// the real pi adapter, and Vitest can reuse that module after its dist changes.
describe("resolveAdapter — transient import failure", () => {
  it("reports an installed but broken adapter without suggesting a reinstall", async () => {
    _resetLastKnownGoodForTests()
    const path = createRequire(import.meta.url).resolve("@agentproto/adapter-pi")
    const original = await fs.readFile(path)
    try {
      await fs.writeFile(path, "{")
      try {
        await resolveAdapter("pi")
        expect.fail("resolveAdapter('pi') should have thrown")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).toMatch(/resolves on disk but could not be imported/)
        expect(message).not.toMatch(/agentproto install/i)
        expect(message).not.toMatch(/npm i -g/i)
      }
    } finally {
      await fs.writeFile(path, original)
    }
  })
})
