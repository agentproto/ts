import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BUNDLES_PATH,
  BundleValidationError,
  createBundle,
  danglingImports,
  deleteBundle,
  getBundle,
  listBundles,
  loadBundles,
  updateBundle,
} from "../bundles.js"
import { addImport, saveImportedMcps, type ImportedMcpsConfig } from "../mcp-imports.js"
import type { DiscoveredMcp } from "../mcp-discovery.js"

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-bundles-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

function fakeSnapshot(id: string): DiscoveredMcp {
  return {
    id,
    source: "claude-code",
    scope: "project",
    name: id,
    type: "stdio",
    command: "some-command",
  } as DiscoveredMcp
}

async function importFixture(id: string, alias?: string): Promise<void> {
  const config: ImportedMcpsConfig = { version: 1, imports: [] }
  const next = addImport(config, { snapshot: fakeSnapshot(id), ...(alias ? { alias } : {}) })
  await saveImportedMcps(next)
}

describe("bundle store", () => {
  it("starts empty and writes a private, versioned file", async () => {
    await expect(listBundles()).resolves.toEqual([])

    await importFixture("chrome-devtools")
    const bundle = await createBundle({
      id: "research",
      label: "Research",
      mcpImports: ["chrome-devtools"],
      skills: ["dataviz"],
    })
    expect(bundle).toMatchObject({ id: "research", label: "Research" })

    await expect(getBundle("research")).resolves.toMatchObject({ id: "research" })
    const raw = await readFile(BUNDLES_PATH(), "utf8")
    expect(JSON.parse(raw)).toMatchObject({ version: 1 })
    expect((await stat(BUNDLES_PATH())).mode & 0o777).toBe(0o600)
  })

  it("rejects an unsafe id", async () => {
    await expect(
      createBundle({ id: "Not Safe", label: "Bad", mcpImports: [], skills: [] }),
    ).rejects.toThrow()
  })

  it("bundle_create rejects an unknown mcpImports id, listing valid ones", async () => {
    await importFixture("chrome-devtools")
    await expect(
      createBundle({ id: "research", label: "Research", mcpImports: ["ghost-mcp"], skills: [] }),
    ).rejects.toThrow(BundleValidationError)
    await expect(
      createBundle({ id: "research", label: "Research", mcpImports: ["ghost-mcp"], skills: [] }),
    ).rejects.toThrow(/chrome-devtools/)
  })

  it("bundle_create rejects a duplicate id — use update instead", async () => {
    await createBundle({ id: "research", label: "Research", mcpImports: [], skills: [] })
    await expect(
      createBundle({ id: "research", label: "Again", mcpImports: [], skills: [] }),
    ).rejects.toThrow(/already exists/)
  })

  it("bundle_update merges onto the existing bundle and re-validates mcpImports", async () => {
    await importFixture("chrome-devtools")
    await createBundle({ id: "research", label: "Research", mcpImports: [], skills: [] })

    const updated = await updateBundle("research", { mcpImports: ["chrome-devtools"], includeDaemon: true })
    expect(updated).toMatchObject({
      id: "research",
      label: "Research", // unset fields survive the merge
      mcpImports: ["chrome-devtools"],
      includeDaemon: true,
    })

    await expect(
      updateBundle("research", { mcpImports: ["ghost-mcp"] }),
    ).rejects.toThrow(BundleValidationError)
  })

  it("bundle_update rejects an id that doesn't exist", async () => {
    await expect(
      updateBundle("nope", { label: "x" }),
    ).rejects.toThrow(/not found/)
  })

  it("deletes only an existing bundle", async () => {
    await createBundle({ id: "research", label: "Research", mcpImports: [], skills: [] })
    await expect(deleteBundle("research")).resolves.toBe(true)
    await expect(deleteBundle("research")).resolves.toBe(false)
  })

  it("danglingImports flags an mcpImports id no longer in the live imported-MCP set", async () => {
    await importFixture("chrome-devtools")
    const bundle = await createBundle({
      id: "research",
      label: "Research",
      mcpImports: ["chrome-devtools"],
      skills: [],
    })
    expect(danglingImports(bundle, new Set(["chrome-devtools"]))).toEqual([])
    expect(danglingImports(bundle, new Set())).toEqual(["chrome-devtools"])
  })

  it("a malformed file on disk is treated as empty, never crashing the daemon", async () => {
    await rm(BUNDLES_PATH(), { force: true })
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    await mkdir(dirname(BUNDLES_PATH()), { recursive: true })
    await writeFile(BUNDLES_PATH(), "{ not json", "utf8")
    await expect(listBundles()).resolves.toEqual([])
    await expect(loadBundles()).resolves.toEqual({ version: 1, bundles: [] })
  })
})

describe('bundle mcpImports "*" wildcard', () => {
  it("is accepted without validation, is never dangling, and round-trips", async () => {
    // No imports exist at all — "*" must still save.
    const b = await createBundle({ id: "everything", label: "All", mcpImports: "*", skills: [] })
    expect(b.mcpImports).toBe("*")
    expect((await getBundle("everything"))?.mcpImports).toBe("*")
    expect(danglingImports(b, new Set())).toEqual([])
    const updated = await updateBundle("everything", { label: "All 2" })
    expect(updated.mcpImports).toBe("*")
  })

  it("a list can be widened to \"*\" via update, and other strings are rejected", async () => {
    await importFixture("x")
    await createBundle({ id: "b1", label: "B", mcpImports: ["x"], skills: [] })
    await expect(updateBundle("b1", { mcpImports: "*" })).resolves.toMatchObject({ mcpImports: "*" })
    await expect(updateBundle("b1", { mcpImports: "all" as never })).rejects.toThrow()
  })
})
