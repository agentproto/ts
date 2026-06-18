import { describe, it, expect } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { ReadOnlyFs } from "../../knowledge/overlay-fs.js"
import { analyzeDataset } from "../analyze.js"
import { writeChapter, buildChapterWritePrompt } from "../write.js"
import { planOutline } from "../plan.js"
import type { ReportModelPort, ReportModelInput } from "../model.js"

/** A model stub that records prompts and replays scripted completions. */
class StubModel implements ReportModelPort {
  readonly calls: ReportModelInput[] = []
  constructor(private readonly reply: (input: ReportModelInput) => string | unknown) {}
  async complete(input: ReportModelInput) {
    this.calls.push(input)
    return { result: this.reply(input) }
  }
}

const datasetWithEntries = () =>
  new MemFs({
    "entries/principles/e1.md": [
      "---",
      "schema: knowledge.entry/v1",
      "kind: principle",
      "title: Exclusivity harms entry",
      "tags: [enforcement]",
      "sources: [src-a]",
      "confidence: 0.9",
      "metadata: { corpus: { status: active } }",
      "---",
      "Exclusivity forecloses rivals.",
    ].join("\n"),
  })

describe("analyzeDataset", () => {
  it("writes one analysis file per non-empty facet, skips empty, never writes dataset", async () => {
    const model = new StubModel(() => "## Key Themes\n\nSynthesized.")
    const res = await analyzeDataset({
      dataset: new ReadOnlyFs(datasetWithEntries()), // read-only guard
      facets: ["enforcement", "ghosttag"],
      model,
    })
    expect(res.analyzed).toBe(1)
    expect(res.skipped).toEqual(["ghosttag"])
    expect(res.files[0]!.path).toBe("sources.enforcement.md")
    expect(res.files[0]!.content).toContain("# Analysis: enforcement")
    expect(res.files[0]!.content).toContain("Synthesized.")
    // the prompt carried the entry body
    expect(model.calls[0]!.prompt).toContain("Exclusivity forecloses rivals.")
  })
})

describe("writeChapter", () => {
  it("builds a cited prompt and returns a {ch, draft}", async () => {
    const ctx = {
      chapter: { id: "ch01", title: "1. Thesis", words: "700-900" },
      title: "Test Report",
      packContent: "- **[principle]** Exclusivity [1]",
      bibliography: "1. Source A — https://a",
    }
    const prompt = buildChapterWritePrompt(ctx)
    expect(prompt.system).toContain("700-900 words")
    expect(prompt.prompt).toContain("Distilled claims")
    expect(prompt.prompt).toContain("## 1. Thesis")

    const model = new StubModel(() => "## 1. Thesis\n\nProse [1].")
    const out = await writeChapter(ctx, model)
    expect(out).toEqual({ ch: "ch01", draft: "## 1. Thesis\n\nProse [1]." })
  })
})

describe("planOutline", () => {
  it("parses a JSON outline (fenced) and validates chapters", async () => {
    const model = new StubModel(
      () =>
        "```json\n" +
        JSON.stringify({
          title: "Auto Plan",
          chapters: [
            { id: "ch01", title: "1. Intro", facets: ["enforcement"], kw: ["glovo"], cap: 20 },
          ],
        }) +
        "\n```"
    )
    const res = await planOutline({
      brief: "Cover competition enforcement.",
      facets: ["enforcement", "conduct"],
      model,
    })
    expect(res.title).toBe("Auto Plan")
    expect(res.chapters).toHaveLength(1)
    expect(res.chapters[0]!.facets).toEqual(["enforcement"])
    expect(model.calls[0]!.prompt).toContain("enforcement, conduct")
  })
})
