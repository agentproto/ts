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

  it("without rules, the system prompt is unchanged (backward compatible)", () => {
    const p = buildReviewPrompt(ctx)
    expect(p.system).not.toContain("GLOBAL RULES")
  })

  it("appends rules to the system prompt verbatim — the same contract given to the writer", () => {
    const base = buildReviewPrompt(ctx)
    const withRules = buildReviewPrompt({
      ...ctx,
      rules: "GLOBAL RULES:\n- Use en-dashes.\n- Every figure must carry its source date.",
    })
    // Additive: the base system prompt survives byte-for-byte as a prefix.
    expect(withRules.system!.startsWith(base.system!)).toBe(true)
    expect(withRules.system).toContain(
      "GLOBAL RULES:\n- Use en-dashes.\n- Every figure must carry its source date."
    )
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
