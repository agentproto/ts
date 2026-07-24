/**
 * Unit tests for {@link LocalFs} — the node:fs FsPort backing. Runs against a
 * real temp dir (the class IS the node:fs boundary, so faking fs would test
 * nothing). Pins atomic write, recursive walk with hidden-segment skipping,
 * and the workspace-escape guard on `resolve`.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LocalFs } from "../local-fs.js"

describe("LocalFs", () => {
  let root: string
  let fs: LocalFs

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "knowledge-corpus-"))
    fs = new LocalFs({ root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("writes then reads a file, creating parent dirs", async () => {
    await fs.writeFile("entries/notes/a.md", "hello")
    expect(await fs.exists("entries/notes/a.md")).toBe(true)
    expect(await fs.readFile("entries/notes/a.md")).toBe("hello")
  })

  it("does not leave the temp file behind after an atomic write", async () => {
    await fs.writeFile("entries/a.md", "x")
    const names = await fs.readdir("entries")
    expect(names).toEqual(["a.md"])
  })

  it("appends to an existing (or missing) file", async () => {
    await fs.appendFile("log.md", "one\n")
    await fs.appendFile("log.md", "two\n")
    expect(await fs.readFile("log.md")).toBe("one\ntwo\n")
  })

  it("walks recursively and returns workspace-relative posix paths", async () => {
    await fs.writeFile("entries/a.md", "a")
    await fs.writeFile("entries/sub/b.md", "b")
    const found = await fs.walk("entries")
    expect([...found].sort()).toEqual(["entries/a.md", "entries/sub/b.md"])
  })

  it("skips hidden segments while walking", async () => {
    await fs.writeFile("entries/visible.md", "v")
    await fs.writeFile("entries/.hidden/secret.md", "s")
    const found = await fs.walk("entries")
    expect([...found]).toEqual(["entries/visible.md"])
  })

  it("stat reports kind and size, null for missing", async () => {
    await fs.writeFile("f.md", "abcd")
    const s = await fs.stat("f.md")
    expect(s?.kind).toBe("file")
    expect(s?.bytes).toBe(4)
    expect(await fs.stat("nope.md")).toBeNull()
  })

  it("exposes a no-op advisory lock", async () => {
    const handle = await fs.lock("anything")
    await expect(handle.release()).resolves.toBeUndefined()
  })

  it("neutralizes traversal so a path cannot escape the workspace root", async () => {
    // posix.normalize drops leading `..` above root, clamping the path back
    // inside the workspace. If the guard were absent, this would read the
    // real `/etc/passwd` (which exists); clamped, it resolves to
    // `<root>/etc/passwd` and ENOENTs — proving the read never left root.
    await expect(fs.readFile("../../../../../../etc/passwd")).rejects.toThrow(
      /ENOENT/
    )
  })

  it("normalizes a leading slash to workspace-relative", async () => {
    await fs.writeFile("/rooted.md", "r")
    expect(await fs.readFile("rooted.md")).toBe("r")
  })
})
