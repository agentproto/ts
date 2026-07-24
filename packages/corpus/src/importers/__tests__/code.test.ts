/**
 * CodeImporter — code tree → knowledge.source/v1 notes (notes-only seam).
 *
 * Exercises the importer directly (enumerate) and end-to-end through the
 * ImporterRunner against a fake FsPort (MemoryFs). Also asserts the code-brain
 * SEAM: the emitted notes carry ZERO symbol/caller/callee graph and no
 * cross-source ref edges — plain corpus notes only.
 */

import { describe, expect, it } from "vitest"
import { CodeImporter, ImporterRunner } from "../../index.js"
import type { ClockPort } from "../../ports/clock.port.js"
import type { IdentityPort } from "../../ports/identity.port.js"
import type { ImportedSource } from "../types.js"
import { MemoryFs } from "../../__tests__/_helpers/memory-fs.js"

const fixedClock: ClockPort = {
  now: () => new Date("2026-07-24T12:00:00.000Z"),
  nowMs: () => Date.parse("2026-07-24T12:00:00.000Z"),
}
const stubIdentity: IdentityPort = {
  resolve: async () => ({
    principal: "ws://operators/importer",
    identityTree: ["ws://operators/importer"],
  }),
}

function freshWorkspace(): MemoryFs {
  return new MemoryFs({
    "KNOWLEDGE.md": [
      "---",
      "schema: knowledge.workspace/v1",
      "name: t",
      "title: T",
      "description: t",
      'version: "1.0.0"',
      "---",
    ].join("\n"),
  })
}

async function collect(
  importer: CodeImporter,
  config: Readonly<Record<string, unknown>>
): Promise<ImportedSource[]> {
  const out: ImportedSource[] = []
  for await (const s of importer.enumerate({ importerId: "code", config })) {
    out.push(s)
  }
  return out
}

describe("CodeImporter — enumerate", () => {
  it("yields one note per matching file (default include **/*.ts)", async () => {
    const fs = freshWorkspace()
    await fs.writeFile("src/a.ts", "export function alpha() { return 1 }\n")
    await fs.writeFile("src/nested/b.ts", "export const beta = 2\n")
    await fs.writeFile("src/readme.md", "# not code\n")

    const importer = new CodeImporter({ fs })
    const yielded = await collect(importer, { rootPath: "src" })

    expect(yielded.map((s) => s.title).sort()).toEqual(["a.ts", "nested/b.ts"])
    // Slug is derived from the root-relative path (extension kept for uniqueness).
    expect(yielded.map((s) => s.slug).sort()).toEqual([
      "a-ts",
      "nested-b-ts",
    ])
    // Each carries a sha256 content hash of the FILE bytes.
    for (const s of yielded) expect(s.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it("surfaces exported symbol names in the note + metadata (surface scan, not a graph)", async () => {
    const fs = freshWorkspace()
    await fs.writeFile(
      "src/mod.ts",
      [
        "export function foo() {}",
        "export class Bar {}",
        "export const baz = 1",
        "export type Qux = string",
        "export { foo as renamed }",
      ].join("\n")
    )
    const importer = new CodeImporter({ fs })
    const [note] = await collect(importer, { rootPath: "src" })

    expect(note!.body).toContain("**Exported symbols:**")
    expect(note!.body).toContain("`foo`")
    expect(note!.body).toContain("`Bar`")
    expect(note!.corpusMetadata!.exportedSymbols).toEqual(
      expect.arrayContaining(["foo", "Bar", "baz", "Qux", "renamed"])
    )
  })

  it("respects include globs and maxFiles", async () => {
    const fs = freshWorkspace()
    await fs.writeFile("src/a.ts", "export const a = 1\n")
    await fs.writeFile("src/b.js", "export const b = 2\n")
    await fs.writeFile("src/c.py", "x = 3\n")

    const importer = new CodeImporter({ fs })
    const js = await collect(importer, {
      rootPath: "src",
      include: ["**/*.js", "**/*.py"],
    })
    expect(js.map((s) => s.title).sort()).toEqual(["b.js", "c.py"])

    const capped = await collect(importer, {
      rootPath: "src",
      include: ["**/*"],
      maxFiles: 1,
    })
    expect(capped.length).toBe(1)
  })

  it('granularity "module" yields one note per directory', async () => {
    const fs = freshWorkspace()
    await fs.writeFile("src/x/one.ts", "export const one = 1\n")
    await fs.writeFile("src/x/two.ts", "export const two = 2\n")
    await fs.writeFile("src/y/three.ts", "export const three = 3\n")

    const importer = new CodeImporter({ fs })
    const modules = await collect(importer, {
      rootPath: "src",
      granularity: "module",
    })
    expect(modules.map((s) => s.title).sort()).toEqual(["x", "y"])
    const x = modules.find((s) => s.title === "x")!
    expect(x.body).toContain("`x/one.ts`")
    expect(x.body).toContain("`x/two.ts`")
    expect(x.corpusMetadata!.fileCount).toBe(2)
  })

  it("keeps the code-brain SEAM: notes only — no graph edges, no ref edges", async () => {
    const fs = freshWorkspace()
    await fs.writeFile("src/a.ts", "export const a = 1\n")
    const importer = new CodeImporter({ fs })
    const [note] = await collect(importer, { rootPath: "src" })

    // Notes-only: metadata carries provenance + a shallow name list, but NO
    // symbol graph (positions/signatures), NO caller/callee edges, and NO
    // AIP-27 cross-source ref edges (Jeremy decision #2 — deferred).
    const meta = note!.corpusMetadata!
    expect(meta.provenanceKind).toBe("imported-from-code")
    for (const forbidden of [
      "refs",
      "callers",
      "callees",
      "callGraph",
      "symbolGraph",
      "edges",
    ]) {
      expect(meta).not.toHaveProperty(forbidden)
    }
    // The only symbol data present is a flat list of exported *names* — no
    // structured graph payload.
    const symbols = meta.exportedSymbols
    expect(Array.isArray(symbols)).toBe(true)
    if (Array.isArray(symbols)) {
      for (const s of symbols) expect(typeof s).toBe("string")
    }
  })

  it("throws an explicit error when rootPath is missing", async () => {
    const fs = freshWorkspace()
    const importer = new CodeImporter({ fs })
    await expect(collect(importer, {})).rejects.toThrow(/rootPath/)
  })
})

describe("CodeImporter + ImporterRunner (end-to-end)", () => {
  it("archives notes as knowledge.source/v1 + appends candidates", async () => {
    const fs = freshWorkspace()
    await fs.writeFile("src/a.ts", "export const a = 1\n")
    await fs.writeFile("src/b.ts", "export const b = 2\n")

    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    const report = await runner.run(new CodeImporter({ fs }), {
      importerId: "code",
      batchId: "2026-07-24",
      config: { rootPath: "src", tags: ["engineering"], language: "en" },
    })

    expect(report.archivedSlugs.length).toBe(2)
    expect(report.candidateIds.length).toBe(2)
    expect(report.warnings.length).toBe(0)

    const archived = await fs.readFile("sources/code/2026-07-24/a-ts.md")
    expect(archived).toMatch(/schema: knowledge\.source\/v1/)
    expect(archived).toMatch(/content_hash: ['"]?sha256:[a-f0-9]+/)
    expect(archived).toMatch(/provenanceKind: imported-from-code/)
    expect(archived).toMatch(/tags:/)
    expect(archived).toMatch(/language: en/)
  })

  it("dedups across reruns by content_hash (unchanged bytes → duplicate)", async () => {
    const fs = freshWorkspace()
    await fs.writeFile("src/a.ts", "export const a = 1\n")
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    const first = await runner.run(new CodeImporter({ fs }), {
      importerId: "code",
      batchId: "b1",
      config: { rootPath: "src" },
    })
    expect(first.archivedSlugs.length).toBe(1)

    const second = await runner.run(new CodeImporter({ fs }), {
      importerId: "code",
      batchId: "b2",
      config: { rootPath: "src" },
    })
    expect(second.archivedSlugs.length).toBe(0)
    expect(second.duplicateSlugs.length).toBe(1)
  })

  it("re-imports a unit when its source bytes change", async () => {
    const fs = freshWorkspace()
    await fs.writeFile("src/a.ts", "export const a = 1\n")
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    await runner.run(new CodeImporter({ fs }), {
      importerId: "code",
      batchId: "b1",
      config: { rootPath: "src" },
    })
    // Change the bytes → new content_hash → not a duplicate.
    await fs.writeFile("src/a.ts", "export const a = 999\n")
    const second = await runner.run(new CodeImporter({ fs }), {
      importerId: "code",
      batchId: "b2",
      config: { rootPath: "src" },
    })
    expect(second.archivedSlugs.length).toBe(1)
    expect(second.duplicateSlugs.length).toBe(0)
  })
})
