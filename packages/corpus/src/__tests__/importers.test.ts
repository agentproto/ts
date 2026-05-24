/**
 * Importers (local-files + kb-migration) + language filter.
 */

import { describe, expect, it } from "vitest"
import {
  CorpusWorkspaceReader,
  ImporterRunner,
  KbMigrationImporter,
  LocalFilesImporter,
  matchesLanguageFilter,
  readEntryLanguage,
  readOperatorLocale,
  readWorkspaceDefaultLanguage,
  resolveLanguageFilter,
} from "../index.js"
import { CandidatesSidecar } from "../workspace/sidecar.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { IdentityPort } from "../ports/identity.port.js"
import { MemoryFs } from "./_helpers/memory-fs.js"

const fixedClock: ClockPort = {
  now: () => new Date("2026-05-22T15:00:00.000Z"),
  nowMs: () => Date.parse("2026-05-22T15:00:00.000Z"),
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

// ── LocalFilesImporter ──────────────────────────────────────────────

describe("LocalFilesImporter + ImporterRunner", () => {
  it("imports every .md from a configured root, archives + appends candidates", async () => {
    const fs = freshWorkspace()
    await fs.writeFile(
      "import-source/marketing/contrarian-hooks.md",
      "# Contrarian Hooks\n\nOpen with a contradiction."
    )
    await fs.writeFile(
      "import-source/marketing/specificity.md",
      "# Specificity\n\nConcrete > superlative."
    )

    const importer = new LocalFilesImporter({ fs })
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    const report = await runner.run(importer, {
      importerId: "local-files",
      batchId: "2026-05-22",
      config: { rootPath: "import-source/marketing" },
    })

    expect(report.archivedSlugs.length).toBe(2)
    expect(report.candidateIds.length).toBe(2)
    expect(report.duplicateSlugs.length).toBe(0)
    expect(report.warnings.length).toBe(0)

    // Archive paths exist — slug is derived from filename relative to
    // rootPath, so files under `import-source/marketing/` produce
    // slugs without the "marketing-" prefix.
    expect(await fs.exists("sources/local-files/2026-05-22/contrarian-hooks.md")).toBe(true)
    expect(await fs.exists("sources/local-files/2026-05-22/specificity.md")).toBe(true)

    // Each archived source has AIP-10 frontmatter w/ correct schema + hash
    const archived = await fs.readFile(
      "sources/local-files/2026-05-22/contrarian-hooks.md"
    )
    expect(archived).toMatch(/schema: knowledge\.source\/v1/)
    expect(archived).toMatch(/content_hash: ['"]?sha256:[a-f0-9]+/)
    expect(archived).toMatch(/title: Contrarian Hooks/)
  })

  it("dedups across reruns by content_hash", async () => {
    const fs = freshWorkspace()
    await fs.writeFile(
      "import-source/note-alpha.md",
      "# A\n\nBody body body."
    )
    const importer = new LocalFilesImporter({ fs })
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    // First run — archives.
    const first = await runner.run(importer, {
      importerId: "local-files",
      batchId: "batch1",
      config: { rootPath: "import-source" },
    })
    expect(first.archivedSlugs.length).toBe(1)
    // Second run, same body — dedup hit.
    const second = await runner.run(importer, {
      importerId: "local-files",
      batchId: "batch2",
      config: { rootPath: "import-source" },
    })
    expect(second.archivedSlugs.length).toBe(0)
    expect(second.duplicateSlugs.length).toBe(1)
  })

  it("emits corpus.candidate.discovered per archived source", async () => {
    const fs = freshWorkspace()
    await fs.writeFile("import-source/note-alpha.md", "# A\n\nBody.")
    const importer = new LocalFilesImporter({ fs })
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    await runner.run(importer, {
      importerId: "local-files",
      batchId: "b",
      config: { rootPath: "import-source" },
    })
    const log = await fs.readFile("_log.md")
    expect(log).toMatch(/corpus\.candidate\.discovered/)
    expect(log).toMatch(/"importerId":"local-files"/)
    expect(log).toMatch(/"provenanceKind":"imported-from-local-files"/)
  })

  it("propagates language config to every archived source", async () => {
    const fs = freshWorkspace()
    await fs.writeFile("source-fr/note-alpha.md", "# Titre\n\nCorps.")
    const importer = new LocalFilesImporter({ fs })
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    await runner.run(importer, {
      importerId: "local-files",
      batchId: "b",
      config: { rootPath: "source-fr", language: "fr-FR" },
    })
    const archived = await fs.readFile(
      "sources/local-files/b/note-alpha.md"
    )
    expect(archived).toMatch(/language: fr-FR/)
  })

  it("invalid root config throws an explicit error", async () => {
    const fs = freshWorkspace()
    const importer = new LocalFilesImporter({ fs })
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    await expect(
      runner.run(importer, {
        importerId: "local-files",
        config: { /* missing rootPath */ },
      })
    ).rejects.toThrow(/rootPath/)
  })

  it("candidate rows land in _candidates.yaml with the right shape", async () => {
    const fs = freshWorkspace()
    await fs.writeFile("import-source/note-alpha.md", "# A\n\nBody.")
    const importer = new LocalFilesImporter({ fs })
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    await runner.run(importer, {
      importerId: "local-files",
      batchId: "b",
      config: { rootPath: "import-source" },
    })
    const sidecar = new CandidatesSidecar({
      fs,
      path: "collections/corpus-candidate/_candidates.yaml",
    })
    const candidates = await sidecar.load()
    expect(candidates.length).toBe(1)
    expect(candidates[0]!.status).toBe("discovered")
    expect(candidates[0]!.corpusKind).toBe("example")
    expect(candidates[0]!.contentHash).toMatch(/^sha256:/)
  })
})

// ── KbMigrationImporter ────────────────────────────────────────────

describe("KbMigrationImporter", () => {
  it("yields one ImportedSource per source from the stub provider", async () => {
    const provider = {
      async listSources() {
        return [
          {
            id: "s1",
            kind: "text",
            uri: "memory://s1",
            title: "First",
            bytes: 100,
            metadata: { foo: "bar" },
          },
          {
            id: "s2",
            kind: "url",
            uri: "https://example.com/s2",
            title: "Second",
            bytes: 200,
            metadata: {},
          },
        ]
      },
    }
    const importer = new KbMigrationImporter()
    const yielded: Array<{ slug: string; metadata?: Readonly<Record<string, unknown>> }> = []
    for await (const s of importer.enumerate({
      importerId: "kb-migration",
      config: { sourceKbId: "qdrant-marketing", provider },
    })) {
      yielded.push({ slug: s.slug, metadata: s.corpusMetadata })
    }
    expect(yielded.length).toBe(2)
    expect(yielded[0]!.slug).toMatch(/^qdrant-marketing-s1$/)
    expect((yielded[0]!.metadata as { provenanceKind: string }).provenanceKind).toBe(
      "imported-from-kb"
    )
    expect((yielded[0]!.metadata as { sourceKbId: string }).sourceKbId).toBe(
      "qdrant-marketing"
    )
  })

  it("uses fetchBody when supplied", async () => {
    const provider = {
      async listSources() {
        return [
          {
            id: "s1",
            kind: "text",
            uri: "x",
            title: "T",
            bytes: 10,
            metadata: {},
          },
        ]
      },
    }
    const importer = new KbMigrationImporter()
    let fetched: string | null = null
    const iter = importer.enumerate({
      importerId: "kb-migration",
      config: {
        sourceKbId: "kb",
        provider,
        fetchBody: async (id: string) => {
          fetched = id
          return "Body for " + id
        },
      },
    })
    const first = (await iter[Symbol.asyncIterator]().next()).value
    expect(first!.body).toBe("Body for s1")
    expect(fetched).toBe("s1")
  })

  it("end-to-end via runner archives + appends candidates with kb provenance", async () => {
    const fs = freshWorkspace()
    const provider = {
      async listSources() {
        return [
          {
            id: "src-a",
            kind: "text",
            uri: "memory",
            title: "Src A",
            bytes: 50,
            metadata: {},
          },
        ]
      },
    }
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    const report = await runner.run(new KbMigrationImporter(), {
      importerId: "kb-migration",
      batchId: "qdrant-2026",
      config: {
        sourceKbId: "qdrant-marketing",
        provider,
        fetchBody: async () => "imported body content",
      },
    })
    expect(report.archivedSlugs.length).toBe(1)
    const archived = await fs.readFile(
      `sources/kb-migration/qdrant-2026/${report.archivedSlugs[0]}.md`
    )
    expect(archived).toMatch(/provenanceKind: imported-from-kb/)
    expect(archived).toMatch(/sourceKbId: qdrant-marketing/)
  })

  it("refuses without provider", async () => {
    const importer = new KbMigrationImporter()
    const iter = importer.enumerate({
      importerId: "kb-migration",
      config: { sourceKbId: "kb" },
    })
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
      /provider required/
    )
  })
})

// ── Language filter ────────────────────────────────────────────────

describe("language filter", () => {
  it("resolveLanguageFilter expands locale variants", () => {
    const f = resolveLanguageFilter({
      callerLocale: "en-US",
      workspaceDefaultLanguage: "en-US",
    })
    expect(f.allowedLanguages.has("en-us")).toBe(true)
    expect(f.allowedLanguages.has("en")).toBe(true)
  })

  it("allowUnspecified=true when workspace declares a default", () => {
    const f = resolveLanguageFilter({
      callerLocale: "fr",
      workspaceDefaultLanguage: "en-US",
    })
    expect(f.allowUnspecified).toBe(true)
  })

  it("allowUnspecified=true when filter is empty (no constraints)", () => {
    const f = resolveLanguageFilter({})
    expect(f.allowUnspecified).toBe(true)
  })

  it("matchesLanguageFilter: exact match", () => {
    const f = resolveLanguageFilter({ callerLocale: "fr-FR" })
    expect(matchesLanguageFilter("fr-FR", f)).toBe(true)
  })

  it("matchesLanguageFilter: loose match (fr-FR matches fr)", () => {
    const f = resolveLanguageFilter({ callerLocale: "fr" })
    expect(matchesLanguageFilter("fr-FR", f)).toBe(true)
  })

  it("matchesLanguageFilter: cross-language miss", () => {
    const f = resolveLanguageFilter({ callerLocale: "fr" })
    expect(matchesLanguageFilter("de-DE", f)).toBe(false)
  })

  it("matchesLanguageFilter: unspecified entry uses allowUnspecified", () => {
    const fOn = resolveLanguageFilter({
      callerLocale: "fr",
      workspaceDefaultLanguage: "en",
    })
    expect(matchesLanguageFilter(undefined, fOn)).toBe(true)
    const fOff = resolveLanguageFilter({ callerLocale: "fr" })
    // No workspace default declared → allowUnspecified depends:
    // when caller locale is set but workspace default isn't, we
    // can't infer language for unmarked entries — be conservative.
    expect(matchesLanguageFilter(undefined, fOff)).toBe(false)
  })

  it("readers extract language from frontmatter shapes", () => {
    expect(
      readWorkspaceDefaultLanguage({
        metadata: { corpus: { languages: { default: "en-US" } } },
      })
    ).toBe("en-US")
    expect(
      readOperatorLocale({
        metadata: { corpus: { locale: "fr-FR" } },
      })
    ).toBe("fr-FR")
    // Source: top-level (AIP-10 native)
    expect(readEntryLanguage({ language: "en-US" })).toBe("en-US")
    // Entry: corpus namespace fallback
    expect(
      readEntryLanguage({ metadata: { corpus: { language: "fr" } } })
    ).toBe("fr")
    expect(readEntryLanguage({})).toBeUndefined()
  })
})
