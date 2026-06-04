import { describe, it, expect, vi } from "vitest"
import matter from "gray-matter"
import { SyncRunner } from "../runner.js"
import { MemFs } from "../../knowledge/mem-fs.js"
import type { SinkPort, SinkItem } from "../types.js"
import type { FsPort } from "../../ports/fs.port.js"

function entryMd(slug: string, kind: string, tags: string[], sources: string[]): string {
  return matter.stringify("\nbody of " + slug, {
    schema: "knowledge.entry/v1",
    slug,
    kind,
    title: slug,
    sources,
    confidence: 0.9,
    tags,
    metadata: { corpus: { status: "active" } },
  })
}

function fakeFs(files: Record<string, string>): FsPort {
  return new MemFs(files)
}

describe("SyncRunner", () => {
  it("pushes each refined entry as a SinkItem (uri + provenance) and tallies", async () => {
    const files = {
      "entries/principles/2026/a.md": entryMd("a", "principle", ["screening"], ["src1"]),
      "entries/patterns/2026/b.md": entryMd("b", "pattern", ["sourcing"], ["src2"]),
    }
    const pushed: SinkItem[] = []
    const sink: SinkPort = {
      push: vi.fn(async (item: SinkItem) => {
        pushed.push(item)
        return { uri: item.uri, ok: true }
      }),
    }
    const report = await new SyncRunner({ fs: fakeFs(files), sink }).run()
    expect(report.pushed).toBe(2)
    expect(report.failed).toBe(0)
    expect(pushed.map(i => i.uri).sort()).toEqual(["corpus://a", "corpus://b"])
    expect(pushed.find(i => i.slug === "a")!.sources).toEqual(["src1"]) // provenance carried
  })

  it("filters by select query (tags) and counts failures", async () => {
    const files = {
      "entries/principles/2026/a.md": entryMd("a", "principle", ["screening"], ["s"]),
      "entries/patterns/2026/b.md": entryMd("b", "pattern", ["sourcing"], ["s"]),
    }
    const sink: SinkPort = {
      push: async (item: SinkItem) => ({ uri: item.uri, ok: false, error: "nope" }),
    }
    const report = await new SyncRunner({
      fs: fakeFs(files),
      sink,
      select: { tags: ["screening"] },
    }).run()
    expect(report.results).toHaveLength(1) // only the screening entry selected
    expect(report.failed).toBe(1)
    expect(report.pushed).toBe(0)
  })
})
