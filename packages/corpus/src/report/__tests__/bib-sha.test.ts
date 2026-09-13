import { describe, it, expect } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { ReadOnlyFs } from "../../knowledge/overlay-fs.js"
import {
  bibliographySha,
  bibShaMarker,
  recordedBibSha,
  stripBibShaMarker,
} from "../bib-sha.js"
import { buildPacks } from "../packs.js"
import { assembleChapters } from "../assemble.js"
import { applyEdits } from "../apply-edits.js"
import { stitchReport } from "../stitch.js"
import { collectReportSections } from "../content.js"
import { reportConfigSchema } from "../types.js"

const src = (id: string, title: string, facet: string) =>
  [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    `tags: [${facet}]`,
    `metadata: { corpus: { originalUrl: 'https://${id}.example' } }`,
    "---",
    "Body.",
  ].join("\n")

const entry = (title: string, facet: string, sources: string) =>
  [
    "---",
    "kind: principle",
    `title: ${title}`,
    `tags: [${facet}]`,
    `sources: [${sources}]`,
    "confidence: 0.9",
    "---",
    `${title} body sentence.`,
  ].join("\n")

const config = reportConfigSchema.parse({
  title: "Test report",
  chapters: [{ id: "ch01", title: "1. One", facets: ["enforcement"] }],
})

describe("bibliographySha", () => {
  it("depends only on the n→id mapping, not titles/urls", () => {
    const a = bibliographySha([
      { n: 1, id: "src-a" },
      { n: 2, id: "src-b" },
    ])
    expect(a).toBe(
      bibliographySha([
        { n: 2, id: "src-b" },
        { n: 1, id: "src-a" },
      ])
    )
    expect(a).not.toBe(
      bibliographySha([
        { n: 1, id: "src-b" },
        { n: 2, id: "src-a" },
      ])
    )
    expect(a).not.toBe(
      bibliographySha([
        { n: 1, id: "src-a" },
        { n: 2, id: "src-b" },
        { n: 3, id: "src-c" },
      ])
    )
  })
})

describe("marker helpers", () => {
  it("round-trips through stamp / read / strip", () => {
    const body = `${bibShaMarker("abc123def456")}\n\n## 1. One\n\nCites [1].`
    expect(recordedBibSha(body)).toBe("abc123def456")
    expect(stripBibShaMarker(body)).toBe("## 1. One\n\nCites [1].")
    expect(recordedBibSha("## 1. One\n\nUnstamped.")).toBeNull()
    expect(stripBibShaMarker("## 1. One\n\nUnstamped.")).toBe(
      "## 1. One\n\nUnstamped."
    )
  })
})

describe("buildPacks bib-sha", () => {
  it("embeds the sha in _bibliography.json and returns it; a new source renumbers → new sha", async () => {
    const d1 = new ReadOnlyFs(
      new MemFs({
        "sources/web/s1.md": src("src-b", "Beta", "enforcement"),
        "entries/p/e1.md": entry("Claim one", "enforcement", "src-b"),
      })
    )
    const r1 = await buildPacks({ dataset: d1, config })
    const json1 = JSON.parse(
      r1.files.find((f) => f.path === "views/_bibliography.json")!.content
    ) as { sha: string }
    expect(json1.sha).toBe(r1.bibliographySha)

    // Same dataset again → identical sha (regeneration is deterministic).
    const r1b = await buildPacks({ dataset: d1, config })
    expect(r1b.bibliographySha).toBe(r1.bibliographySha)

    // Adding a source that sorts first renumbers everything → sha changes.
    const d2 = new ReadOnlyFs(
      new MemFs({
        "sources/web/s0.md": src("src-a", "Alpha", "enforcement"),
        "sources/web/s1.md": src("src-b", "Beta", "enforcement"),
        "entries/p/e1.md": entry("Claim one", "enforcement", "src-b"),
      })
    )
    const r2 = await buildPacks({ dataset: d2, config })
    expect(r2.bibliographySha).not.toBe(r1.bibliographySha)
  })
})

describe("assembleChapters bib-sha stamping", () => {
  it("stamps the marker as the first line when bibSha is set; none otherwise", () => {
    const stamped = assembleChapters({
      bibMax: 5,
      bibSha: "abc123def456",
      injectAnchors: true,
      chapters: [{ ch: "ch01", draft: "## 1. One\n\nCites [2]." }],
    })
    expect(stamped.files[0]!.content).toBe(
      '<!-- bib-sha:abc123def456 -->\n\n<a id="ch01"></a>\n\n## 1. One\n\nCites [2].\n'
    )
    const plain = assembleChapters({
      bibMax: 5,
      chapters: [{ ch: "ch01", draft: "## 1. One\n\nCites [2]." }],
    })
    expect(plain.files[0]!.content).toBe("## 1. One\n\nCites [2].\n")
  })
})

describe("mid-run bibliography regeneration", () => {
  const report = (chapterSha: string, bibSha: { n: number; id: string }[]) =>
    new MemFs({
      "chapters/ch01.md": `${bibShaMarker(chapterSha)}\n\n## 1. One\n\nCites [1].`,
      "views/_bibliography.md":
        "# Bibliography (global citation index)\n\n1. Alpha — https://a\n",
      "views/_bibliography.json": JSON.stringify({
        sha: bibliographySha(bibSha),
        sources: bibSha.map((s) => ({ ...s, title: s.id, url: "https://x" })),
      }),
    })
  const goodBib = [{ n: 1, id: "src-a" }]
  const goodSha = bibliographySha(goodBib)
  const renumbered = [
    { n: 1, id: "src-new" },
    { n: 2, id: "src-a" },
  ]

  it("stitch passes when the chapter's recorded sha matches, and strips the marker", async () => {
    const { content } = await stitchReport({ config, report: report(goodSha, goodBib) })
    expect(content).toContain("## 1. One")
    expect(content).not.toContain("bib-sha")
  })

  it("stitch throws when the bibliography was renumbered after the chapter was written", async () => {
    await expect(
      stitchReport({ config, report: report(goodSha, renumbered) })
    ).rejects.toThrow(/renumbered.*ch01.*wrong sources|wrong sources.*ch01/s)
  })

  it("checkBibSha: false overrides (marker still stripped); unstamped chapters never checked", async () => {
    const { content } = await stitchReport({
      config,
      report: report(goodSha, renumbered),
      checkBibSha: false,
    })
    expect(content).not.toContain("bib-sha")

    const legacy = new MemFs({
      "chapters/ch01.md": "## 1. One\n\nCites [1].",
      "views/_bibliography.md": "# Bibliography\n\n1. Alpha — https://a\n",
      "views/_bibliography.json": JSON.stringify({
        sources: renumbered.map((s) => ({ ...s, title: s.id, url: "https://x" })),
      }),
    })
    const sections = await collectReportSections({ config, report: legacy })
    expect(sections.find((s) => s.id === "ch01")!.markdown).toContain("## 1. One")
  })

  it("applyEdits skips a chapter written against a stale bibliography", async () => {
    const res = await applyEdits({
      bibMax: 2,
      bibSha: bibliographySha(renumbered),
      report: report(goodSha, renumbered),
      results: [
        { id: "ch01", edits: [{ find: "Cites [1].", replace: "Cites [2].", reason: "x" }] },
      ],
    })
    expect(res.stats.staleBib).toEqual(["ch01"])
    expect(res.stats.applied).toBe(0)
    expect(res.files).toHaveLength(0)
    expect(res.report).toContain("stale numbering")
  })

  it("applyEdits still applies (and post-checks) a stamped chapter with a matching sha", async () => {
    const res = await applyEdits({
      bibMax: 1,
      bibSha: goodSha,
      report: report(goodSha, goodBib),
      results: [
        { id: "ch01", edits: [{ find: "Cites [1].", replace: "Cites [1]!", reason: "x" }] },
      ],
    })
    expect(res.stats.applied).toBe(1)
    expect(res.files[0]!.content).toContain("Cites [1]!")
    // The marker must not trip the "starts at ##" post-check.
    expect(res.stats.postCheckFailed).toEqual([])
  })
})
