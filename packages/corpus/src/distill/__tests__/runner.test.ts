import { describe, it, expect, vi } from "vitest"
import matter from "gray-matter"
import { z } from "zod"
import { DistillRunner } from "../runner.js"
import type { DistillPort, DistilledItem } from "../types.js"
import type { FsPort } from "../../ports/fs.port.js"

function fakeFs(): { fs: FsPort; written: Map<string, string> } {
  const written = new Map<string, string>()
  const fs: FsPort = {
    exists: async p => written.has(p),
    readFile: async p => written.get(p) ?? "",
    writeFile: async (p, c) => {
      written.set(p, c)
    },
    appendFile: async (p, c) => {
      written.set(p, (written.get(p) ?? "") + c)
    },
    readdir: async () => [],
    walk: async () => [],
    stat: async p =>
      written.has(p) ? { kind: "file", bytes: written.get(p)!.length } : null,
    lock: async () => ({ release: async () => {} }),
  }
  return { fs, written }
}

/** The entry frontmatter fields these assertions read. */
const WRITTEN_FM = z
  .object({
    kind: z.string(),
    sources: z.array(z.string()),
    tags: z.array(z.string()),
    metadata: z.object({ corpus: z.object({ access: z.string() }).loose() }).loose(),
  })
  .loose()

const clock = {
  now: () => new Date("2026-06-04T00:00:00Z"),
  nowMs: () => new Date("2026-06-04T00:00:00Z").getTime(),
}

function fakeDistiller(items: DistilledItem[]): DistillPort {
  return { distill: vi.fn(async () => items) }
}

describe("DistillRunner", () => {
  it("writes refined entries with sources[] provenance + inherited access", async () => {
    const { fs, written } = fakeFs()
    const runner = new DistillRunner({
      fs,
      clock,
      distiller: fakeDistiller([
        { kind: "principle", title: "Go beyond keyword matching", body: "Require context.", confidence: 0.9, tags: ["Screening", "CV"] },
        { kind: "pattern", title: "Three-section JD read", body: "Day-in-life, quals, extras." },
      ]),
    })
    const report = await runner.run({
      id: "amy-miller-jd",
      title: "How to read a JD",
      body: "transcript…",
      tags: ["recruiting"],
      access: "guild",
    })

    expect(report.entryPaths).toHaveLength(2)
    const principle = written.get("entries/principles/2026/go-beyond-keyword-matching.md")!
    const fm = WRITTEN_FM.parse(matter(principle).data)
    expect(fm.kind).toBe("principle")
    expect(fm.sources).toEqual(["amy-miller-jd"])           // provenance edge
    expect(fm.metadata.corpus.access).toBe("guild")          // inherited
    expect(fm.tags).toContain("screening")                   // sanitized (was "Screening")
    expect(fm.tags).toContain("recruiting")                  // merged from source
    expect(matter(principle).content).toContain("Require context.")
  })

  it("skips entries whose slug already exists (idempotent re-run)", async () => {
    const { fs } = fakeFs()
    const items: DistilledItem[] = [{ kind: "principle", title: "Same", body: "x" }]
    const runner = new DistillRunner({ fs, clock, distiller: fakeDistiller(items) })
    const first = await runner.run({ id: "s1", title: "t", body: "b" })
    expect(first.entryPaths).toHaveLength(1)
    const second = await runner.run({ id: "s1", title: "t", body: "b" })
    expect(second.entryPaths).toHaveLength(0)
    expect(second.skipped).toContain("same")
  })

  it("drops items with empty title/body", async () => {
    const { fs } = fakeFs()
    const runner = new DistillRunner({
      fs,
      clock,
      distiller: fakeDistiller([{ kind: "summary", title: "  ", body: "x" }]),
    })
    const report = await runner.run({ id: "s", title: "t", body: "b" })
    expect(report.entryPaths).toHaveLength(0)
  })
})
