import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Deliverable 1 regression: the kit's .d.ts must compile against a
 * CONSUMER'S own zod copy (zod is a peerDependency). The fixture package
 * under test-fixtures/consumer installs its own zod and annotates a
 * book-shaped kit with the kit's generics — `tsc --noEmit` there fails
 * (TS2741 exactPartial) when the shipped types bind a private nested zod.
 *
 * Skipped when the fixture has not been installed yet:
 *   cd packages/app-config/test-fixtures/consumer && pnpm install --offline
 */
const fixtureDir = join(import.meta.dirname, "..", "..", "test-fixtures", "consumer")
const tscBin = join(fixtureDir, "node_modules", ".bin", "tsc")

describe("consumer fixture (its own zod copy)", () => {
  it.runIf(existsSync(tscBin))("type-checks the kit against a consumer's own zod", () => {
    const result = spawnSync(tscBin, ["--noEmit"], { cwd: fixtureDir, encoding: "utf8" })
    if (result.status !== 0) {
      console.error(`fixture tsc output:\n${result.stdout}${result.stderr}`)
    }
    expect(result.status).toBe(0)
  })

  it.runIf(!existsSync(tscBin))("skips when the fixture is not installed", () => {
    console.warn(`consumer fixture not installed at ${fixtureDir} — run pnpm install --offline there`)
  })
})
