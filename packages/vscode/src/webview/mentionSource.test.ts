import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { listRepoFiles } from "./mentionSource.js"

const execFileAsync = promisify(execFile)

let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe("listRepoFiles", () => {
  it("honors .gitignore in a git repo (DECISIONS #2) — needs no commit or identity", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-mention-git-"))
    // `git init` + files is enough: `ls-files --others --exclude-standard`
    // lists untracked-non-ignored files without a commit or user.email.
    await execFileAsync("git", ["-C", dir, "init"])
    await writeFile(join(dir, "keep.ts"), "x")
    await writeFile(join(dir, ".gitignore"), "ignored.log\nsecret/\n")
    await writeFile(join(dir, "ignored.log"), "x")
    await mkdir(join(dir, "secret"), { recursive: true })
    await writeFile(join(dir, "secret", "token.txt"), "x")

    const files = await listRepoFiles(dir)

    expect(files).toContain("keep.ts")
    expect(files).toContain(".gitignore")
    expect(files).not.toContain("ignored.log")
    expect(files.some(f => f.startsWith("secret/"))).toBe(false)
  })

  it("lists project files and excludes noise dirs outside a git repo (the walk fallback)", async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-mention-plain-"))
    await writeFile(join(dir, "a.ts"), "x")
    await mkdir(join(dir, "sub"), { recursive: true })
    await writeFile(join(dir, "sub", "b.ts"), "x")
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(dir, "node_modules", "pkg", "index.js"), "x")
    // A .gitignore keeps node_modules out whether the walk runs (the intended
    // path — an os.tmpdir() dir isn't a repo) or, in the rare case the tmpdir
    // happens to sit inside one, git's own --exclude-standard.
    await writeFile(join(dir, ".gitignore"), "node_modules/\n")

    const files = await listRepoFiles(dir)

    expect(files).toContain("a.ts")
    expect(files).toContain(join("sub", "b.ts"))
    expect(files.some(f => f.includes("node_modules"))).toBe(false)
  })
})
