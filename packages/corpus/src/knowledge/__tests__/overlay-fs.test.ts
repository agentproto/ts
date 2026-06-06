import { describe, it, expect } from "vitest"
import matter from "gray-matter"
import { OverlayFs, ReadOnlyFs } from "../overlay-fs.js"
import { resolveKnowledge } from "../resolve.js"
import type { FsPort, FsStat } from "../../ports/fs.port.js"

/** Minimal in-memory FsPort over a flat path→content map. */
function memFs(files: Record<string, string>): FsPort & { files: Record<string, string> } {
  return {
    files,
    exists: async (p: string) => p in files,
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`)
      return files[p]!
    },
    writeFile: async (p: string, c: string) => {
      files[p] = c
    },
    appendFile: async (p: string, c: string) => {
      files[p] = (files[p] ?? "") + c
    },
    readdir: async (p: string) => {
      const prefix = p.endsWith("/") ? p : `${p}/`
      const names = new Set<string>()
      for (const k of Object.keys(files)) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]!)
      }
      return [...names]
    },
    walk: async (p: string) => {
      const prefix = p.endsWith("/") ? p : `${p}/`
      return Object.keys(files)
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length))
    },
    stat: async (p: string): Promise<FsStat | null> =>
      p in files ? { kind: "file", bytes: files[p]!.length } : null,
    lock: async () => ({ release: async () => {} }),
  }
}

function entry(slug: string, kind: string, tags: string[], body: string): string {
  return matter.stringify(body, {
    schema: "knowledge.entry/v1",
    slug,
    kind,
    title: slug,
    sources: ["src"],
    confidence: 0.9,
    tags,
    metadata: { corpus: { status: "active" } },
  })
}

describe("OverlayFs", () => {
  it("guild layer shadows the pack at the same path (override)", async () => {
    const pack = memFs({
      "entries/principles/a.md": entry("a", "principle", ["screening"], "PACK body"),
    })
    const guild = memFs({
      "entries/principles/a.md": entry("a", "principle", ["screening"], "GUILD body"),
    })
    const overlay = new OverlayFs([guild, pack])

    expect(await overlay.readFile("entries/principles/a.md")).toContain("GUILD body")
    // walk yields the path ONCE despite both layers having it.
    expect((await overlay.walk("entries")).filter(r => r === "principles/a.md")).toHaveLength(1)
  })

  it("pack-only path passes through (floor) and guild-only path is additive (extend)", async () => {
    const pack = memFs({
      "entries/principles/floor.md": entry("floor", "principle", ["x"], "from pack"),
    })
    const guild = memFs({
      "entries/principles/extra.md": entry("extra", "principle", ["x"], "from guild"),
    })
    const overlay = new OverlayFs([guild, pack])

    const resolved = await resolveKnowledge({ fs: overlay, query: { tags: ["x"] } })
    const slugs = resolved.map(r => r.slug).sort()
    expect(slugs).toEqual(["extra", "floor"]) // floor from pack + extra from guild
  })

  it("resolveKnowledge over an override returns the guild body, not the pack's", async () => {
    const pack = memFs({
      "entries/p/a.md": entry("a", "principle", ["screening"], "Match keywords literally."),
    })
    const guild = memFs({
      "entries/p/a.md": entry("a", "principle", ["screening"], "Go beyond keywords — require context."),
    })
    const overlay = new OverlayFs([guild, pack])

    const [hit] = await resolveKnowledge({ fs: overlay, query: { tags: ["screening"] } })
    expect(hit!.slug).toBe("a")
    expect(hit!.body).toContain("Go beyond keywords")
  })

  it("guild disables a pack entry by shadowing it with status:archived (tombstone)", async () => {
    const pack = memFs({
      "entries/p/a.md": entry("a", "principle", ["screening"], "pack guidance"),
      "entries/p/b.md": entry("b", "principle", ["screening"], "other pack guidance"),
    })
    // guild tombstones "a" at the same path; "b" left untouched.
    const archived = matter.stringify("(disabled by guild)", {
      schema: "knowledge.entry/v1",
      slug: "a",
      kind: "principle",
      title: "a",
      sources: ["src"],
      confidence: 0.9,
      tags: ["screening"],
      metadata: { corpus: { status: "archived" } },
    })
    const guild = memFs({ "entries/p/a.md": archived })
    const overlay = new OverlayFs([guild, pack])

    const resolved = await resolveKnowledge({ fs: overlay, query: { tags: ["screening"] } })
    const slugs = resolved.map(r => r.slug)
    expect(slugs).toContain("b") // untouched pack entry still resolves
    expect(slugs).not.toContain("a") // tombstoned → hidden, pack's "a" shadowed away
  })

  it("writes target the top layer; the pack stays pristine", async () => {
    const pack = memFs({ "entries/p/a.md": entry("a", "principle", ["x"], "pack") })
    const guild = memFs({})
    const overlay = new OverlayFs([guild, pack])

    await overlay.writeFile("entries/p/b.md", "new")
    expect("entries/p/b.md" in guild.files).toBe(true)
    expect("entries/p/b.md" in pack.files).toBe(false)
  })
})

describe("OverlayFs whiteout", () => {
  it("a higher .whiteout marker REMOVES a lower entry (not just shadows it)", async () => {
    const pack = memFs({
      "entries/p/a.md": entry("a", "principle", ["x"], "pack a"),
      "entries/p/b.md": entry("b", "principle", ["x"], "pack b"),
    })
    // guild drops "a" with a marker, leaves "b".
    const guild = memFs({ "entries/p/a.md.whiteout": "" })
    const overlay = new OverlayFs([guild, pack], { whiteout: true })

    expect(await overlay.exists("entries/p/a.md")).toBe(false)
    await expect(overlay.readFile("entries/p/a.md")).rejects.toThrow()
    expect(await overlay.stat("entries/p/a.md")).toBeNull()

    const resolved = await resolveKnowledge({ fs: overlay, query: { tags: ["x"] } })
    const slugs = resolved.map(r => r.slug)
    expect(slugs).toContain("b")
    expect(slugs).not.toContain("a")
  })

  it("hides marker files themselves from readdir and walk", async () => {
    const pack = memFs({ "entries/p/a.md": entry("a", "principle", ["x"], "pack a") })
    const guild = memFs({ "entries/p/a.md.whiteout": "" })
    const overlay = new OverlayFs([guild, pack], { whiteout: true })

    expect(await overlay.readdir("entries/p")).not.toContain("a.md.whiteout")
    expect(await overlay.readdir("entries/p")).not.toContain("a.md")
    expect(await overlay.walk("entries")).not.toContain("p/a.md.whiteout")
    expect(await overlay.walk("entries")).not.toContain("p/a.md")
  })

  it("a higher real entry overrides a lower tombstone (top-down resolution)", async () => {
    const pack = memFs({ "entries/p/a.md": entry("a", "principle", ["x"], "pack a") })
    const mid = memFs({ "entries/p/a.md.whiteout": "" })
    const guild = memFs({ "entries/p/a.md": entry("a", "principle", ["x"], "guild a") })
    const overlay = new OverlayFs([guild, mid, pack], { whiteout: true })

    expect(await overlay.exists("entries/p/a.md")).toBe(true)
    expect(await overlay.readFile("entries/p/a.md")).toContain("guild a")
  })

  it("a tombstone only suppresses LOWER layers, never a higher one", async () => {
    // marker sits in the lowest layer; the real entry above survives.
    const low = memFs({ "entries/p/a.md.whiteout": "" })
    const high = memFs({ "entries/p/a.md": entry("a", "principle", ["x"], "high a") })
    const overlay = new OverlayFs([high, low], { whiteout: true })

    expect(await overlay.exists("entries/p/a.md")).toBe(true)
    expect(await overlay.readFile("entries/p/a.md")).toContain("high a")
  })

  it("whiteout OFF (default) ignores markers — byte-for-byte legacy behavior", async () => {
    const pack = memFs({ "entries/p/a.md": entry("a", "principle", ["x"], "pack a") })
    const guild = memFs({ "entries/p/a.md.whiteout": "" })
    const overlay = new OverlayFs([guild, pack]) // no options → whiteout off

    expect(await overlay.exists("entries/p/a.md")).toBe(true)
    expect(await overlay.readFile("entries/p/a.md")).toContain("pack a")
    // the marker is just an ordinary file in this mode
    expect(await overlay.exists("entries/p/a.md.whiteout")).toBe(true)
  })
})

describe("ReadOnlyFs", () => {
  it("passes reads through and rejects mutations", async () => {
    const inner = memFs({ "entries/p/a.md": entry("a", "principle", ["x"], "body") })
    const ro = new ReadOnlyFs(inner)
    expect(await ro.exists("entries/p/a.md")).toBe(true)
    await expect(ro.writeFile("entries/p/a.md", "x")).rejects.toThrow(/immutable/)
    await expect(ro.appendFile("entries/p/a.md", "x")).rejects.toThrow(/immutable/)
  })
})
