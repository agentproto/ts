/**
 * The runtime is bundled into `cli.mjs`, so the sandbox registry's dynamic
 * `import("@agentproto/sandbox-<slug>")` resolves from the CLI package's own
 * node_modules. A provider that is registered in the runtime but neither
 * declared as a CLI dependency nor kept external in tsup shows up as
 * "supported / not installed" in a daemon built from this package.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>
}
const tsup = readFileSync(join(root, "tsup.config.ts"), "utf8")

describe("bundled sandbox providers are resolvable from the CLI package", () => {
  for (const name of ["sandbox-e2b", "sandbox-box", "sandbox-computer"]) {
    it(`@agentproto/${name} is a dependency and a tsup external`, () => {
      expect(pkg.dependencies[`@agentproto/${name}`]).toBeDefined()
      expect(tsup).toContain(`"@agentproto/${name}",`)
    })
  }
})
