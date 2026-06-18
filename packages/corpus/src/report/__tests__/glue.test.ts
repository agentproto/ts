import { describe, it, expect } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { assembleChapters } from "../assemble.js"
import { stitchReport } from "../stitch.js"
import { applyEdits } from "../apply-edits.js"
import { reportConfigSchema } from "../types.js"

describe("assembleChapters", () => {
  it("strips preamble, normalizes [a→b]→[b], flags out-of-range cites", () => {
    const res = assembleChapters({
      bibMax: 5,
      chapters: [
        {
          ch: "ch01",
          draft:
            "I'll write this now.\n\n## 1. Title\n\nBody cites [2] and [3→4].\n\n\n\nTail.",
        },
        { ch: "ch02", draft: "## 2. Other\n\nBad cite [9]." },
      ],
    })
    const m = Object.fromEntries(res.files.map((f) => [f.path, f.content]))
    expect(m["chapters/ch01.md"]).toBe(
      "## 1. Title\n\nBody cites [2] and [4].\n\nTail.\n"
    )
    expect(res.stats.preamblesStripped).toBe(1)
    expect(res.stats.outOfRange).toEqual([{ ch: "ch02", cites: [9] }])
  })
})

describe("stitchReport", () => {
  it("stitches front + parts + annexes + Sources from the bibliography", async () => {
    const report = new MemFs({
      "chapters/_front.md": "# Title\n\n## Executive summary\n\nIntro.",
      "chapters/ch01.md": "## 1. One\n\nAlpha.",
      "chapters/ch02.md": "## 2. Two\n\nBeta.",
      "chapters/_annexes.md": "# Annexes\n\nExtra.",
      "views/_bibliography.md":
        "# Bibliography (global citation index)\n\n1. Alpha — https://a\n",
    })
    const config = reportConfigSchema.parse({
      frontFile: "chapters/_front.md",
      annexesFile: "chapters/_annexes.md",
      parts: [{ heading: "# Part I", chapters: ["ch01", "ch02"] }],
      chapters: [
        { id: "ch01", title: "1. One" },
        { id: "ch02", title: "2. Two" },
      ],
    })
    const { content } = await stitchReport({ config, report })
    expect(content).toContain("# Title")
    expect(content).toContain("# Part I")
    expect(content.indexOf("## 1. One")).toBeLessThan(content.indexOf("## 2. Two"))
    expect(content).toContain("# Annexes")
    expect(content).toContain("## Sources\n\n1. Alpha — https://a")
    expect(content).not.toContain("# Bibliography") // header stripped
  })
})

describe("applyEdits", () => {
  it("applies exact-once edits, skips ambiguous/out-of-range, post-checks", async () => {
    const report = new MemFs({
      "chapters/ch01.md": "## 1. Title\n\nThe quick brown fox. Repeat word word.",
    })
    const res = await applyEdits({
      bibMax: 5,
      report,
      results: [
        {
          id: "ch01",
          edits: [
            { find: "quick brown fox", replace: "lazy dog [2]", reason: "swap" },
            { find: "word", replace: "X", reason: "ambiguous (2×)" },
            { find: "Repeat", replace: "Echo [9]", reason: "oor cite" },
          ],
        },
      ],
    })
    expect(res.stats.applied).toBe(1)
    expect(res.stats.filesChanged).toBe(1)
    const m = Object.fromEntries(res.files.map((f) => [f.path, f.content]))
    expect(m["chapters/ch01.md"]).toContain("lazy dog [2]")
    expect(m["chapters/ch01.md"]).toContain("word word") // ambiguous untouched
    expect(res.report).toContain("SKIP (find matches 2× — ambiguous)")
    expect(res.report).toContain("out-of-range cite 9")
  })

  it("reverts a chapter whose post-check fails (no write)", async () => {
    const report = new MemFs({ "chapters/ch01.md": "## 1. Title\n\nBody." })
    const res = await applyEdits({
      bibMax: 5,
      report,
      results: [
        // Removing the leading "## " heading must trip the post-check.
        { id: "ch01", edits: [{ find: "## 1. Title", replace: "Plain", reason: "x" }] },
      ],
    })
    expect(res.files).toHaveLength(0)
    expect(res.report).toContain("POST-CHECK FAILED")
  })
})
