import { describe, it, expect } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { stitchReport } from "../stitch.js"
import {
  buildReportContent,
  reportContentToMarkdown,
  collectReportSections,
} from "../content.js"
import { reportConfigSchema } from "../types.js"

const withParts = () => {
  const report = new MemFs({
    "chapters/_front.md": "# The Title\n\n## Executive summary\n\nIntro.",
    "chapters/ch01.md": "## 1. One\n\nAlpha [1].",
    "chapters/ch02.md": "## 2. Two\n\nBeta.",
    "chapters/_annexes.md": "# Annexes\n\nExtra.",
    "views/_bibliography.md":
      "# Bibliography (global citation index)\n\n1. Alpha — https://a\n",
    "views/_bibliography.json": JSON.stringify({
      sources: [{ id: "alpha", title: "Alpha", url: "https://a", n: 1 }],
    }),
  })
  const config = reportConfigSchema.parse({
    cover: { brand: "AGENTIK", subtitle: "A study", tag: "2026" },
    profile: "bible",
    frontFile: "chapters/_front.md",
    annexesFile: "chapters/_annexes.md",
    parts: [{ heading: "# Part I", chapters: ["ch01", "ch02"] }],
    chapters: [
      { id: "ch01", title: "1. One" },
      { id: "ch02", title: "2. Two" },
    ],
  })
  return { report, config }
}

const noParts = () => {
  const report = new MemFs({
    "chapters/intro.md": "## Intro\n\nBody.",
    "chapters/body.md": "## Body\n\nMore.",
    "views/_bibliography.md": "# Bibliography (global citation index)\n\n1. X — https://x\n",
    "views/_bibliography.json": JSON.stringify({
      sources: [{ id: "x", title: "X", url: "https://x", n: 1 }],
    }),
  })
  const config = reportConfigSchema.parse({
    title: "Auto Report",
    chapters: [
      { id: "intro", title: "Intro" },
      { id: "body", title: "Body" },
    ],
  })
  return { report, config }
}

describe("buildReportContent", () => {
  it("collects ordered sections with kinds (front · part · chapters · annexes · sources)", async () => {
    const { report, config } = withParts()
    const content = await buildReportContent({ config, report })
    expect(content.sections.map((s) => s.kind)).toEqual([
      "front",
      "part",
      "chapter",
      "chapter",
      "annexes",
      "sources",
    ])
    expect(content.sections.map((s) => s.id)).toEqual([
      "_front",
      "part-i",
      "ch01",
      "ch02",
      "_annexes",
      "_sources",
    ])
  })

  it("derives title, bibliography, and presentation-free meta", async () => {
    const { report, config } = withParts()
    const content = await buildReportContent({ config, report })
    expect(content.title).toBe("The Title") // no config.title → first H1 of front
    expect(content.bibliography).toEqual({
      mode: "numbered",
      entries: [{ n: 1, id: "alpha", title: "Alpha", url: "https://a" }],
    })
    expect(content.meta).toEqual({
      brand: "AGENTIK",
      subtitle: "A study",
      tag: "2026",
      profile: "bible",
    })
  })

  it("prefers explicit config.title when present", async () => {
    const { report, config } = noParts()
    const content = await buildReportContent({ config, report })
    expect(content.title).toBe("Auto Report")
  })
})

describe("stitch === reportContentToMarkdown ∘ collectReportSections", () => {
  it("markdown medium is byte-identical to stitch (with parts)", async () => {
    const { report, config } = withParts()
    const stitched = await stitchReport({ config, report })
    const sections = await collectReportSections({ config, report })
    expect(reportContentToMarkdown(sections)).toBe(stitched.content)
  })

  it("markdown medium is byte-identical to stitch (auto config, no parts)", async () => {
    const { report, config } = noParts()
    const stitched = await stitchReport({ config, report })
    const built = await buildReportContent({ config, report })
    expect(reportContentToMarkdown(built.sections)).toBe(stitched.content)
  })
})
