import { describe, it, expect } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { ReadOnlyFs } from "../../knowledge/overlay-fs.js"
import { buildPacks } from "../packs.js"
import { reportConfigSchema } from "../types.js"

/** A tiny fused dataset: 2 sources (one per facet) + 3 entries. */
const dataset = () =>
  new MemFs({
    "sources/web/s1.md": [
      "---",
      "id: src-alpha",
      "title: Alpha Source",
      "tags: [enforcement]",
      "metadata: { corpus: { originalUrl: 'https://a.example' } }",
      "---",
      "Alpha body.",
    ].join("\n"),
    "sources/web/s2.md": [
      "---",
      "id: src-beta",
      "title: Beta Source",
      "tags: [conduct]",
      "metadata: { corpus: { originalUrl: 'https://b.example' } }",
      "---",
      "Beta body.",
    ].join("\n"),
    "entries/principles/e1.md": [
      "---",
      "kind: principle",
      "title: Glovo exclusivity finding",
      "tags: [enforcement]",
      "sources: [src-alpha]",
      "confidence: 0.9",
      "---",
      "Morocco fined Glovo for exclusivity. Extra sentence.",
    ].join("\n"),
    "entries/patterns/e2.md": [
      "---",
      "kind: pattern",
      "title: Self preferencing pattern",
      "tags: [conduct]",
      "sources: [src-beta]",
      "confidence: 0.8",
      "---",
      "Platforms self-prefer their own services.",
    ].join("\n"),
    "entries/principles/e3.md": [
      "---",
      "kind: principle",
      "title: Unrelated topic",
      "tags: [enforcement]",
      "sources: []",
      "confidence: 0.5",
      "---",
      "Nothing relevant here.",
    ].join("\n"),
  })

const config = reportConfigSchema.parse({
  title: "Test report",
  chapters: [
    { id: "ch01", title: "1. Enforcement", facets: ["enforcement"], kw: ["glovo"], cap: 10 },
    { id: "ch02", title: "2. Conduct", facets: ["conduct"] },
  ],
})

const fileMap = (files: readonly { path: string; content: string }[]) =>
  Object.fromEntries(files.map((f) => [f.path, f.content]))

describe("buildPacks", () => {
  it("numbers the global bibliography by facet order then title", async () => {
    const res = await buildPacks({ dataset: dataset(), config })
    expect(res.bibliography).toBe(2)
    const bib = JSON.parse(fileMap(res.files)["views/_bibliography.json"]!)
    expect(bib.sources.map((s: { id: string; n: number }) => [s.id, s.n])).toEqual([
      ["src-alpha", 1], // enforcement facet sorts first
      ["src-beta", 2],
    ])
    expect(bib.sources[0].url).toBe("https://a.example")
  })

  it("routes entries by facet + keyword gate and cites by global [n]", async () => {
    const res = await buildPacks({ dataset: dataset(), config })
    const files = fileMap(res.files)
    const ch01 = files["views/ch01.md"]!
    // e1 matches facet + kw "glovo"; cited [1] (src-alpha)
    expect(ch01).toContain("**[principle]** Glovo exclusivity finding")
    expect(ch01).toContain("[1]")
    expect(ch01).toContain("Morocco fined Glovo for exclusivity.") // first-sentence gist
    // e3 shares the facet but fails the kw gate → excluded
    expect(ch01).not.toContain("Unrelated topic")

    const ch02 = files["views/ch02.md"]!
    expect(ch02).toContain("**[pattern]** Self preferencing pattern")
    expect(ch02).toContain("[2]") // src-beta
    expect(res.chapters).toEqual([
      { id: "ch01", title: "1. Enforcement", entryCount: 1 },
      { id: "ch02", title: "2. Conduct", entryCount: 1 },
    ])
  })

  it("honors the viewsDir parameter in paths and the 'also read' pointer", async () => {
    const res = await buildPacks({ dataset: dataset(), config, viewsDir: "packs" })
    const files = fileMap(res.files)
    expect(files["packs/_bibliography.md"]).toBeDefined()
    expect(files["packs/ch01.md"]).toContain("packs/_bibliography.md")
  })

  it("never writes the dataset — succeeds through a ReadOnlyFs mount", async () => {
    // ReadOnlyFs throws on any write/append/lock. If buildPacks tried to
    // mutate the dataset, this would reject — proving invariant 1.
    const sealed = new ReadOnlyFs(dataset())
    await expect(buildPacks({ dataset: sealed, config })).resolves.toBeDefined()
  })
})
