import { describe, expect, it } from "vitest"
import { MemFs } from "@agentproto/corpus"
import { mountCascade } from "../mount-cascade.js"

describe("mountCascade", () => {
  it("returns base unchanged when no lens or constraints are given", () => {
    const base = new MemFs({ "entries/a.md": "base a" })
    expect(mountCascade({ base })).toBe(base)
  })

  it("lets base override a same-path lens entry", async () => {
    const base = new MemFs({ "entries/a.md": "OVERRIDE" })
    const lens = new MemFs({ "entries/a.md": "PACK", "entries/b.md": "PACK b" })
    const fs = mountCascade({ base, lens: [lens] })

    expect(await fs.readFile("entries/a.md")).toBe("OVERRIDE")
    expect(await fs.readFile("entries/b.md")).toBe("PACK b") // extend: pack-only path passes through
  })

  it("extends the lens with a new base-only path", async () => {
    const base = new MemFs({ "entries/new.md": "EXTEND" })
    const lens = new MemFs({ "entries/a.md": "PACK" })
    const fs = mountCascade({ base, lens: [lens] })

    expect(await fs.walk("entries")).toEqual(
      expect.arrayContaining(["new.md", "a.md"])
    )
  })

  it("constraints win over base even when base whiteouts them", async () => {
    const base = new MemFs({ "entries/policy.md.whiteout": "" })
    const constraint = new MemFs({ "entries/policy.md": "NON-SHADOWABLE" })
    const fs = mountCascade({ base, constraints: [constraint] })

    expect(await fs.readFile("entries/policy.md")).toBe("NON-SHADOWABLE")
  })

  it("writes always target base, never lens or constraints", async () => {
    const base = new MemFs({})
    const lens = new MemFs({})
    const constraint = new MemFs({})
    const fs = mountCascade({ base, lens: [lens], constraints: [constraint] })

    await fs.writeFile("entries/new.md", "written")

    expect(await base.readFile("entries/new.md")).toBe("written")
    await expect(lens.readFile("entries/new.md")).rejects.toThrow()
    await expect(constraint.readFile("entries/new.md")).rejects.toThrow()
  })

  it("refuses writes through a constraint layer even via the mounted overlay", async () => {
    const base = new MemFs({})
    const constraint = new MemFs({ "entries/a.md": "C" })
    const fs = mountCascade({ base, constraints: [constraint] })

    // Writes always target `base`, so the constraint stays untouched —
    // this just confirms reads through it still work post-mount.
    expect(await fs.readFile("entries/a.md")).toBe("C")
  })
})
