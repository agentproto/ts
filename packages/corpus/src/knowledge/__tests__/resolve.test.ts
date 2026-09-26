import { describe, it, expect } from "vitest"
import matter from "gray-matter"
import { resolveKnowledge } from "../resolve.js"
import { MemFs } from "../mem-fs.js"
import type { FsPort } from "../../ports/fs.port.js"

function entry(o: {
  slug: string
  kind: string
  tags: string[]
  sources: string[]
  confidence: number
  access?: string
  body?: string
}): string {
  return matter.stringify("\n" + (o.body ?? "insight"), {
    schema: "knowledge.entry/v1",
    slug: o.slug,
    kind: o.kind,
    title: o.slug,
    sources: o.sources,
    confidence: o.confidence,
    tags: o.tags,
    metadata: { corpus: { status: "active", ...(o.access ? { access: o.access } : {}) } },
  })
}

// A real in-memory FsPort — MemFs.walk already returns paths relative to the
// walked dir, exactly what resolveKnowledge expects.
function fakeFs(files: Record<string, string>): FsPort {
  return new MemFs(files)
}

const files = {
  "entries/principles/2026/a.md": entry({ slug: "a", kind: "principle", tags: ["screening", "cv"], sources: ["src-amy"], confidence: 0.9 }),
  "entries/patterns/2026/b.md": entry({ slug: "b", kind: "pattern", tags: ["sourcing"], sources: ["src-x"], confidence: 0.8 }),
  "entries/principles/2026/c.md": entry({ slug: "c", kind: "principle", tags: ["screening"], sources: ["src-y"], confidence: 0.95, access: "guild" }),
  "entries/notes/2026/skip.md": "no frontmatter here",
}

describe("resolveKnowledge", () => {
  it("matches by tag overlap, returns provenance, sorts by confidence", async () => {
    const hits = await resolveKnowledge({ fs: fakeFs(files), query: { tags: ["screening"] } })
    expect(hits.map(h => h.slug)).toEqual(["c", "a"]) // 0.95 before 0.9; b (sourcing) excluded
    expect(hits[0]!.sources).toEqual(["src-y"]) // provenance carried
  })

  it("filters by kind", async () => {
    const hits = await resolveKnowledge({ fs: fakeFs(files), query: { kinds: ["pattern"] } })
    expect(hits.map(h => h.slug)).toEqual(["b"])
  })

  it("enforces access scope (hides entries above clearance)", async () => {
    const hits = await resolveKnowledge({
      fs: fakeFs(files),
      query: { tags: ["screening"] },
      allowedAccess: new Set(["public"]), // operator NOT cleared for guild
    })
    // c is access=guild → hidden; a has no access (public) → visible
    expect(hits.map(h => h.slug)).toEqual(["a"])
  })

  it("respects maxResults", async () => {
    const hits = await resolveKnowledge({ fs: fakeFs(files), query: { maxResults: 1 } })
    expect(hits).toHaveLength(1)
  })

  it("extracts resolved source_refs when present, undefined otherwise", async () => {
    const withRefs = matter.stringify("\ninsight", {
      schema: "knowledge.entry/v1",
      slug: "r",
      kind: "principle",
      title: "r",
      sources: ["src-amy"],
      confidence: 0.9,
      tags: ["screening"],
      metadata: {
        corpus: {
          status: "active",
          source_refs: [
            { id: "src-amy", url: "https://example.com/x", title: "X", authority: "secondary" },
          ],
        },
      },
    })
    const hits = await resolveKnowledge({
      fs: fakeFs({
        "entries/principles/2026/r.md": withRefs,
        "entries/principles/2026/a.md": files["entries/principles/2026/a.md"]!, // no source_refs
      }),
      query: { tags: ["screening"] },
    })
    const r = hits.find(h => h.slug === "r")
    expect(r?.sourceRefs).toEqual([
      { id: "src-amy", url: "https://example.com/x", title: "X", authority: "secondary" },
    ])
    expect(hits.find(h => h.slug === "a")?.sourceRefs).toBeUndefined()
  })

  it("carries a source's content address, with or without a url", async () => {
    const sha =
      "37c3bc70c1b26ab7cb25d753fcf3ae770c62e221bd8aa7b9119bcfd595a8b1d4"
    const withSha = matter.stringify("\ninsight", {
      schema: "knowledge.entry/v1",
      slug: "s",
      kind: "principle",
      title: "s",
      sources: ["src-scan"],
      confidence: 0.9,
      tags: ["screening"],
      metadata: {
        corpus: {
          status: "active",
          // No url on purpose: this is the case the field exists for — an
          // origin that is a stored document, not a fetchable page.
          source_refs: [{ id: "src-scan", title: "Scan", sha }],
        },
      },
    })
    const hits = await resolveKnowledge({
      fs: fakeFs({ "entries/principles/2026/s.md": withSha }),
      query: { tags: ["screening"] },
    })
    expect(hits[0]?.sourceRefs).toEqual([
      { id: "src-scan", title: "Scan", sha },
    ])
  })

  it("drops a top-level `source` block — provenance rides on source_refs", async () => {
    // Pins the asymmetry rather than leaving it to be rediscovered: the
    // frontmatter schema is `.loose()`, so an author can put anything at the
    // top level and it parses — but ResolvedEntry is built field by field, so
    // only what the shape declares reaches a consumer. A generator writing
    // `source: { sha }` at the top level ships data no caller can ever read.
    const topLevel = matter.stringify("\ninsight", {
      schema: "knowledge.entry/v1",
      slug: "t",
      kind: "principle",
      title: "t",
      sources: ["src-top"],
      confidence: 0.9,
      tags: ["screening"],
      source: { sha: "deadbeef", filename: "f.pdf" },
      metadata: { corpus: { status: "active" } },
    })
    const hits = await resolveKnowledge({
      fs: fakeFs({ "entries/principles/2026/t.md": topLevel }),
      query: { tags: ["screening"] },
    })
    expect(hits[0]).toBeDefined()
    expect("source" in hits[0]!).toBe(false)
  })
})
