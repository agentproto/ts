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
})
