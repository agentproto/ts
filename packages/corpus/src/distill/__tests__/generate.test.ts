import { describe, it, expect, vi } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { DistillIndex } from "../distill-index.js"
import { distillFromImporter } from "../generate.js"
import type { CorpusImporter, ImportedSource } from "../../importers/types.js"
import type { DistilledItem, DistillPort } from "../types.js"

const clock = {
  now: () => new Date("2026-06-19T00:00:00Z"),
  nowMs: () => new Date("2026-06-19T00:00:00Z").getTime(),
}

function fakeDistiller(items: DistilledItem[]): DistillPort {
  return { distill: vi.fn(async () => items) }
}

/** A one-source importer over a fixed content hash — the dedup key. */
function oneSourceImporter(hash: string): CorpusImporter {
  const source: ImportedSource = {
    slug: "s1",
    title: "Pricing power",
    contentHash: hash,
    body: "Charge for the value delivered, not the cost incurred.",
    authority: "secondary",
  }
  return {
    id: "test",
    label: "Test",
    async *enumerate(): AsyncIterable<ImportedSource> {
      yield source
    },
  }
}

const ITEM: DistilledItem = {
  kind: "principle",
  title: "Price on value, not cost",
  body: "Anchor price to the buyer's outcome.",
}

describe("distillFromImporter + DistillIndex ledger", () => {
  it("distills, writes entries, and records a ledger row", async () => {
    const fs = new MemFs({})
    const index = new DistillIndex({ fs })
    const distiller = fakeDistiller([ITEM])

    const report = await distillFromImporter({
      fs,
      clock,
      distiller,
      importer: oneSourceImporter("sha256:aaa"),
      importerId: "test",
      config: {},
      index,
      engine: "claude-code",
    })

    expect(report.unitsConsidered).toBe(1)
    expect(report.unitsDistilled).toBe(1)
    expect(report.entriesWritten).toBe(1)
    expect(report.unchanged).toBe(0)

    const row = await index.get("s1")
    expect(row).not.toBeNull()
    expect(row!.engine).toBe("claude-code")
    expect(row!.contentHash).toBe("sha256:aaa")
    expect(row!.entryCount).toBe(1)
    expect(row!.distilledAt).toBe("2026-06-19T00:00:00.000Z")
    expect(row!.entryPaths?.[0]).toMatch(/^entries\/principles\//)
  })

  it("skips an unchanged source on re-run (same content hash) — no LLM call", async () => {
    const fs = new MemFs({})
    const index = new DistillIndex({ fs })
    const distiller = fakeDistiller([ITEM])
    const importer = oneSourceImporter("sha256:aaa")
    const base = { fs, clock, distiller, importer, importerId: "test", config: {}, index }

    await distillFromImporter(base)
    const second = await distillFromImporter(base)

    expect(second.unitsConsidered).toBe(1)
    expect(second.unchanged).toBe(1)
    expect(second.entriesWritten).toBe(0)
    expect(distiller.distill).toHaveBeenCalledTimes(1) // not re-distilled
  })

  it("re-distills when the source content hash changes (upsert by sourceId)", async () => {
    const fs = new MemFs({})
    const index = new DistillIndex({ fs })
    const distiller = fakeDistiller([ITEM])

    await distillFromImporter({
      fs, clock, distiller,
      importer: oneSourceImporter("sha256:aaa"),
      importerId: "test", config: {}, index,
    })
    await distillFromImporter({
      fs, clock, distiller,
      importer: oneSourceImporter("sha256:bbb"), // changed content
      importerId: "test", config: {}, index,
    })

    expect(distiller.distill).toHaveBeenCalledTimes(2)
    const rows = await index.load()
    expect(rows).toHaveLength(1) // upsert, not append
    expect(rows[0]!.contentHash).toBe("sha256:bbb")
  })
})
