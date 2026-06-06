import { describe, it, expect } from "vitest"
import matter from "gray-matter"
import { MemFs } from "../../knowledge/mem-fs.js"
import { scanDistilledSourceIds } from "../scan.js"

function entry(sources: string[]): string {
  return matter.stringify("the refined body", {
    schema: "knowledge.entry/v1",
    sources,
  })
}

describe("scanDistilledSourceIds", () => {
  it("collects the `sources:` backlink from every entry", async () => {
    const fs = new MemFs({
      "entries/principles/2026/a.md": entry(["w1", "w2"]),
      "entries/summaries/2026/b.md": entry(["w2", "w3"]),
      "KNOWLEDGE.md": "# not an entry — ignored",
    })
    const ids = await scanDistilledSourceIds(fs)
    expect([...ids].sort()).toEqual(["w1", "w2", "w3"])
  })

  it("returns empty when there is no entries/ directory yet", async () => {
    const fs = new MemFs({ "KNOWLEDGE.md": "# fresh corpus" })
    expect((await scanDistilledSourceIds(fs)).size).toBe(0)
  })

  it("tolerates entries with no sources frontmatter", async () => {
    const fs = new MemFs({
      "entries/principles/2026/a.md": matter.stringify("body", {
        schema: "knowledge.entry/v1",
      }),
    })
    expect((await scanDistilledSourceIds(fs)).size).toBe(0)
  })
})
