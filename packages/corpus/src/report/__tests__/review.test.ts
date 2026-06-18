import { describe, it, expect } from "vitest"
import { reviewChapter, buildReviewPrompt } from "../review.js"
import { applyEdits } from "../apply-edits.js"
import { MemFs } from "../../knowledge/mem-fs.js"
import type { ReportModelPort } from "../model.js"

const ctx = {
  chapter: { id: "ch01", title: "1. One" },
  chapterText: "## 1. One\n\nThe market grew 200% in 2021 [1].",
  bibliography: "1. Source A — https://a\n2. Source B — https://b",
  bibMax: 2,
}

describe("buildReviewPrompt", () => {
  it("frames the valid citation range and demands JSON edits", () => {
    const p = buildReviewPrompt({ ...ctx, analysisContext: "Growth was 20%." })
    expect(p.prompt).toContain("[1]..[2]")
    expect(p.prompt).toContain("Per-facet analysis")
    expect(p.system).toContain("exact-match")
  })
})

describe("reviewChapter", () => {
  it("parses model JSON edits into a ChapterEditSet", async () => {
    const model: ReportModelPort = {
      complete: async () => ({
        result: JSON.stringify({
          edits: [{ find: "200%", replace: "20%", reason: "overstated vs analysis" }],
        }),
      }),
    }
    const res = await reviewChapter(ctx, model)
    expect(res.id).toBe("ch01")
    expect(res.edits).toEqual([
      { find: "200%", replace: "20%", reason: "overstated vs analysis" },
    ])
  })

  it("tolerates a malformed completion → no edits (chapter left untouched)", async () => {
    const model: ReportModelPort = {
      complete: async () => ({ result: "sorry, I cannot do that" }),
    }
    const res = await reviewChapter(ctx, model)
    expect(res.edits).toEqual([])
  })

  it("review → applyEdits round-trip lands the exact-match fix", async () => {
    const model: ReportModelPort = {
      complete: async () => ({
        result: JSON.stringify({ edits: [{ find: "200%", replace: "20%", reason: "fix" }] }),
      }),
    }
    const reviewed = await reviewChapter(ctx, model)
    const report = new MemFs({ "chapters/ch01.md": ctx.chapterText })
    const res = await applyEdits({ results: [reviewed], bibMax: 2, report })
    expect(res.stats.applied).toBe(1)
    const m = Object.fromEntries(res.files.map((f) => [f.path, f.content]))
    expect(m["chapters/ch01.md"]).toContain("grew 20% in 2021 [1]")
  })
})
