import { describe, it, expect, vi } from "vitest"
import matter from "gray-matter"
import { MemFs } from "../../knowledge/mem-fs.js"
import { DistillIndex } from "../distill-index.js"
import { distillFromImporter } from "../generate.js"
import { lensAspect, lensAspectTag, type Lens } from "../lens.js"
import type { CorpusImporter, ImportedSource } from "../../importers/types.js"
import type { DistilledItem, DistillInput, DistillPort } from "../types.js"

const clock = {
  now: () => new Date("2026-06-19T00:00:00Z"),
  nowMs: () => new Date("2026-06-19T00:00:00Z").getTime(),
}

/** Captures the DistillInput it was handed so we can assert lens threading. */
function capturingDistiller(items: DistilledItem[]): DistillPort & {
  inputs: DistillInput[]
} {
  const inputs: DistillInput[] = []
  return {
    inputs,
    distill: vi.fn(async (input: DistillInput) => {
      inputs.push(input)
      return items
    }),
  }
}

function oneSourceImporter(hash: string): CorpusImporter {
  const source: ImportedSource = {
    slug: "s1",
    title: "A founding conversation",
    contentHash: hash,
    body: "We decided to position on safety, and to drop the freemium tier.",
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
  kind: "summary",
  title: "Position on safety; no freemium",
  body: "The product leads with safety and ships without a freemium tier.",
  tags: ["positioning"],
}

const MARKETING: Lens = {
  id: "marketing",
  label: "Marketing knowledge",
  prompt: "Extract positioning, messaging, and go-to-market decisions.",
  kinds: ["summary", "principle"],
  mode: "synthesis",
}

const DIARY: Lens = {
  id: "diary",
  label: "Conversation diary",
  prompt: "Extract a chronological account of what happened and what was decided.",
  mode: "log",
}

describe("lens helpers", () => {
  it("aspect falls back to id; tag is aspect:<value>", () => {
    expect(lensAspect(MARKETING)).toBe("marketing")
    expect(lensAspectTag(MARKETING)).toBe("aspect:marketing")
    expect(lensAspect({ ...MARKETING, aspect: "gtm" })).toBe("gtm")
  })
})

describe("distillFromImporter with a lens", () => {
  it("threads the lens prompt + kinds to the distiller and stamps aspect: on entries", async () => {
    const fs = new MemFs({})
    const distiller = capturingDistiller([ITEM])

    const report = await distillFromImporter({
      fs,
      clock,
      distiller,
      importer: oneSourceImporter("sha256:aaa"),
      importerId: "test",
      config: {},
      lens: MARKETING,
    })

    expect(report.entriesWritten).toBe(1)
    // lens prompt + kinds reached the distiller
    expect(distiller.inputs[0]!.instruction).toBe(MARKETING.prompt)
    expect(distiller.inputs[0]!.kinds).toEqual(["summary", "principle"])

    // the written entry carries the aspect facet tag (colon preserved)
    const path = "entries/summaries/2026/position-on-safety-no-freemium.md"
    const raw = await fs.readFile(path)
    const fm = matter(raw).data as { tags: string[] }
    expect(fm.tags).toContain("aspect:marketing")
    expect(fm.tags).toContain("positioning")
  })

  it("keys the ledger by (source, lens) — two lenses over one source are independent", async () => {
    const fs = new MemFs({})
    const index = new DistillIndex({ fs })
    const importer = () => oneSourceImporter("sha256:aaa")

    await distillFromImporter({
      fs, clock, distiller: capturingDistiller([ITEM]),
      importer: importer(), importerId: "test", config: {}, index,
      lens: MARKETING, engine: "claude-code",
    })
    await distillFromImporter({
      fs, clock, distiller: capturingDistiller([{ ...ITEM, kind: "summary", title: "Timeline of the call" }]),
      importer: importer(), importerId: "test", config: {}, index,
      lens: DIARY, engine: "claude-code",
    })

    const rows = await index.load()
    expect(rows).toHaveLength(2) // one row per (source, lens)
    expect(await index.get("s1", "marketing")).not.toBeNull()
    expect(await index.get("s1", "diary")).not.toBeNull()
    // generic lens-less lookup must NOT match a lensed row
    expect(await index.get("s1")).toBeNull()
  })

  it("re-running ONE lens skips unchanged without short-circuiting the other lens", async () => {
    const fs = new MemFs({})
    const index = new DistillIndex({ fs })
    const importer = () => oneSourceImporter("sha256:aaa")

    // marketing distilled once
    const mkt1 = capturingDistiller([ITEM])
    await distillFromImporter({
      fs, clock, distiller: mkt1, importer: importer(),
      importerId: "test", config: {}, index, lens: MARKETING,
    })
    // diary has never run — must NOT be considered unchanged by marketing's row
    const diary1 = capturingDistiller([{ ...ITEM, title: "Timeline of the call" }])
    const diaryReport = await distillFromImporter({
      fs, clock, distiller: diary1, importer: importer(),
      importerId: "test", config: {}, index, lens: DIARY,
    })
    expect(diaryReport.unchanged).toBe(0)
    expect(diary1.distill).toHaveBeenCalledTimes(1)

    // marketing re-run on the same hash is now unchanged — no LLM
    const mkt2 = capturingDistiller([ITEM])
    const mktReport = await distillFromImporter({
      fs, clock, distiller: mkt2, importer: importer(),
      importerId: "test", config: {}, index, lens: MARKETING,
    })
    expect(mktReport.unchanged).toBe(1)
    expect(mkt2.distill).not.toHaveBeenCalled()
  })
})
