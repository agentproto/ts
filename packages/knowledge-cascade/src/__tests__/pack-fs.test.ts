import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { packFs } from "../pack-fs.js"

describe("packFs", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "knowledge-cascade-packfs-"))
    await mkdir(path.join(root, "entries"), { recursive: true })
    await writeFile(path.join(root, "entries", "a.md"), "PACK a")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("reads entries from the mounted directory", async () => {
    const fs = packFs({ root })
    expect(await fs.exists("entries/a.md")).toBe(true)
    expect(await fs.readFile("entries/a.md")).toBe("PACK a")
    expect(await fs.walk("entries")).toEqual(["a.md"])
  })

  it("refuses writes — packs are immutable", async () => {
    const fs = packFs({ root })
    await expect(fs.writeFile("entries/a.md", "mutated")).rejects.toThrow(/immutable/)
    await expect(fs.appendFile("entries/a.md", "!")).rejects.toThrow(/immutable/)
  })

  it("neutralizes traversal so a path cannot escape the pack root", async () => {
    const fs = packFs({ root })
    // posix.normalize drops leading `..` above root, clamping the path back
    // inside the pack — it resolves to `<root>/etc/passwd` and ENOENTs
    // rather than reading the real `/etc/passwd`.
    await expect(fs.readFile("../../../../../../etc/passwd")).rejects.toThrow(
      /ENOENT/
    )
  })
})
