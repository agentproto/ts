/**
 * readDistillSources — the shared source scan (M3). Locks the two semantics the
 * Bureau client and server MUST agree on: provenance id comes from FRONTMATTER
 * `id` (not the filename), and the distill body is the FRONTMATTER-STRIPPED
 * content. Also covers the skip rules (no id / empty body) and the `max` cap.
 */

import { describe, it, expect } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { readDistillSources } from "../read-sources.js"

describe("readDistillSources", () => {
  it("derives id from frontmatter, strips frontmatter from the body", async () => {
    const fs = new MemFs({
      "sources/web/some-file.md":
        "---\nid: fm-id-42\ntitle: A Source\ntags: [ai, safety]\n---\n\nThe body only.\n",
    })
    const out = await readDistillSources(fs)
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe("fm-id-42") // frontmatter id, NOT "some-file"
    expect(out[0]!.title).toBe("A Source")
    expect(out[0]!.tags).toEqual(["ai", "safety"])
    expect(out[0]!.body).toBe("The body only.") // frontmatter stripped
  })

  it("titles default to the id when frontmatter has no title", async () => {
    const fs = new MemFs({ "sources/a.md": "---\nid: only-id\n---\n\nBody.\n" })
    const out = await readDistillSources(fs)
    expect(out[0]!.title).toBe("only-id")
  })

  it("skips sources with no frontmatter id or an empty body", async () => {
    const fs = new MemFs({
      "sources/no-id.md": "---\ntitle: No id here\n---\n\nHas body but no id.\n",
      "sources/empty.md": "---\nid: has-id\n---\n\n   \n",
      "sources/good.md": "---\nid: good\n---\n\nReal body.\n",
    })
    const out = await readDistillSources(fs)
    expect(out.map(s => s.id)).toEqual(["good"])
  })

  it("honours the max cap and ignores non-.md files", async () => {
    const fs = new MemFs({
      "sources/a.md": "---\nid: a\n---\n\nA.\n",
      "sources/b.md": "---\nid: b\n---\n\nB.\n",
      "sources/notes.txt": "id: c",
    })
    const out = await readDistillSources(fs, { max: 1 })
    expect(out).toHaveLength(1)
  })

  it("returns [] when there is no sources/ directory", async () => {
    const fs = new MemFs({ "entries/x.md": "---\nsources:\n  - a\n---\n\nx\n" })
    expect(await readDistillSources(fs)).toEqual([])
  })
})
