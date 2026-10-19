// resolveAdapter — the error text for a transient failure doesn't send the
// operator to reinstall. Lives in its OWN file deliberately: the main
// resolve.test.ts resolves every built adapter early (listInstalledAdapters
// walks the catalog), and an ESM import is cached for the process once it
// happens. `withMutatedDist("@agentproto/adapter-pi", "truncate", …)` only
// reproduces the "present on disk, import just failed" window in a module
// registry where `@agentproto/adapter-pi` has NOT already been imported —
// which fails deterministically in a fully-built checkout (main resolve.test
// imports pi first) and depends on what got built/sharded in CI. A separate
// file gives this test a fresh module registry per vitest file.
import { describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import {
  resolveAdapter,
  _resetLastKnownGoodForTests,
} from "../registry/resolve.js"

const requireFromHere = createRequire(import.meta.url)

async function withMutatedDist<T>(
  packageName: string,
  mutate: "delete" | "truncate",
  fn: () => Promise<T>
): Promise<T> {
  const distPath = requireFromHere.resolve(packageName)
  const original = await fs.readFile(distPath)
  try {
    if (mutate === "delete") {
      await fs.unlink(distPath)
    } else {
      await fs.writeFile(distPath, "{")
    }
    return await fn()
  } finally {
    await fs.writeFile(distPath, original)
  }
}

describe("resolveAdapter — the error text for a transient failure doesn't send the operator to reinstall", () => {
  it("names 'resolves on disk but could not be imported' instead of 'not installed' when the package IS present but momentarily broken", async () => {
    _resetLastKnownGoodForTests()
    await withMutatedDist("@agentproto/adapter-pi", "truncate", async () => {
      // No prior successful resolve in THIS file (reset above) and the
      // file still exists with garbage content — the narrow window the
      // `AdapterImportFailedError` distinguishes: present, but the
      // import itself just failed.
      try {
        await resolveAdapter("pi")
        expect.fail("resolveAdapter('pi') should have thrown")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).toMatch(/resolves on disk but could not be imported/)
        expect(message).not.toMatch(/agentproto install/i)
        expect(message).not.toMatch(/npm i -g/i)
      }
    })
  })
})
