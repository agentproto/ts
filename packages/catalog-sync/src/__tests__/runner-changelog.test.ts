import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { CATALOG_CHANGELOG_PATH, runGenerators } from "../runner.js"
import { defineGenerator, type GeneratedFiles, type GeneratorContext } from "../types.js"

// A repo-relative path INSIDE catalog-sync's own scratch dir, never a real
// model-catalog file. NOT `.test-tmp/` — that directory is owned by
// runner.test.ts, whose afterEach does a recursive rmSync on it; vitest runs
// test FILES concurrently in separate workers, so sharing a directory here
// races runner.test.ts's cleanup against this file's own writes (only
// reproduces under the full parallel suite, not this file in isolation).
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, "..", "..")
const OUT_DIR = join(PKG_DIR, ".test-tmp-changelog")
const REL_OUT = "packages/catalog-sync/.test-tmp-changelog/changelog-mock.generated.ts"
const ABS_OUT = join(OUT_DIR, "changelog-mock.generated.ts")

/** Renders the same `Record<string, X>` shape the real generators emit, so `diffModelIds` can see it. */
function renderMock(ids: string[]): string {
  const lines = ["export const ROUTES: Record<string, X> = {"]
  for (const id of ids) lines.push(`  ${JSON.stringify(id)}: {\n    inputPer1M: 1,\n  },`)
  lines.push("}", "")
  return lines.join("\n")
}

function mockGen(ids: string[]): ReturnType<typeof defineGenerator> {
  return defineGenerator({
    name: "mock:changelog",
    modality: "llm",
    sources: [],
    async generate(_ctx: GeneratorContext): Promise<GeneratedFiles> {
      return { [REL_OUT]: renderMock(ids) }
    },
  })
}

// NOTE: every case here runs with write:false. CATALOG_CHANGELOG_PATH is a
// fixed real repo file (packages/model-catalog/CATALOG-CHANGELOG.md) — the
// runner reads it (harmless) but a write:true call WOULD persist to it, so
// these tests only ever inspect the in-memory result.
describe("runGenerators — CATALOG-CHANGELOG.md wiring (write:false only, never touches the real file)", () => {
  beforeEach(() => {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(ABS_OUT, renderMock(["vendor/a", "vendor/b"]), "utf8")
  })
  afterEach(() => {
    rmSync(OUT_DIR, { recursive: true, force: true })
  })

  it("reports the changelog path as changed, with the added/removed ids, when a generator's id set drifts", async () => {
    const result = await runGenerators([mockGen(["vendor/a", "vendor/c"])], {
      refresh: false,
      write: false,
    })
    expect(result.changed).toContain(CATALOG_CHANGELOG_PATH)
    const section = result.files[CATALOG_CHANGELOG_PATH]!
    expect(section).toContain("mock:changelog")
    expect(section).toContain("vendor/c")
    expect(section).toContain("vendor/b")
  })

  it("does NOT touch the changelog path when the generator's id set is unchanged", async () => {
    const result = await runGenerators([mockGen(["vendor/a", "vendor/b"])], {
      refresh: false,
      write: false,
    })
    expect(result.changed).not.toContain(CATALOG_CHANGELOG_PATH)
    expect(result.files[CATALOG_CHANGELOG_PATH]).toBeUndefined()
  })

  it("does NOT touch the changelog path for a generator whose output has no Record id keys", async () => {
    // Seed "before" with the SAME no-id shape (overriding beforeEach's
    // vendor/a+vendor/b seed) — otherwise switching from that seed to a
    // no-id-keys file would itself look like "2 removed", which is a
    // different (and correct) case, not what this test is checking.
    const noIdsContent = "export const MOCK = 42 as const\n"
    writeFileSync(ABS_OUT, noIdsContent, "utf8")
    const gen = defineGenerator({
      name: "mock:no-ids",
      modality: "llm",
      sources: [],
      async generate(): Promise<GeneratedFiles> {
        return { [REL_OUT]: noIdsContent }
      },
    })
    const result = await runGenerators([gen], { refresh: false, write: false })
    expect(result.changed).not.toContain(CATALOG_CHANGELOG_PATH)
  })
})
