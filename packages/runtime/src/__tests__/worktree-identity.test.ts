/**
 * Fixtures build git's on-disk layout directly rather than shelling out to
 * `git worktree add` — that layout IS what `resolveWorktreeIdentity` reads
 * (gitrepository-layout(5)), so reproducing it keeps the test hermetic and
 * free of a git binary. Everything lives under one tmpdir whose ancestors
 * carry no `.git`, and every case terminates at a `.git` the fixture itself
 * planted, so no assertion depends on where the checkout running the suite
 * happens to sit.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { resolveWorktreeIdentity } from "../worktree-identity.js"

describe("resolveWorktreeIdentity", () => {
  let base: string

  /** A linked worktree: an admin dir under the main checkout's
   *  `.git/worktrees/<name>` (carrying git's `gitdir` back-pointer) plus the
   *  tree itself, whose `.git` is a file pointing at that admin dir. */
  function makeWorktree(
    name: string,
    options: { marker?: string; relativeLink?: boolean; commondir?: string } = {},
  ): { tree: string; admin: string } {
    const admin = join(base, "repo", ".git", "worktrees", name)
    const tree = join(base, "trees", name)
    mkdirSync(admin, { recursive: true })
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(admin, "gitdir"), `${join(tree, ".git")}\n`)
    const target = options.relativeLink ? relative(tree, admin) : admin
    writeFileSync(join(tree, ".git"), `gitdir: ${target}\n`)
    if (options.marker !== undefined) {
      writeFileSync(join(admin, "agentproto-worktree.json"), options.marker)
    }
    // Only written when the test cares — pre-existing fixtures omit it, so
    // their assertions stay exactly as they were (no `mainRepoPath`).
    if (options.commondir !== undefined) {
      writeFileSync(join(admin, "commondir"), `${options.commondir}\n`)
    }
    return { tree, admin }
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "worktree-identity-test-"))
    // The main checkout the worktrees link back to: `.git` as a DIRECTORY.
    mkdirSync(join(base, "repo", ".git"), { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it("reports path and id for a provisioned worktree", () => {
    const { tree } = makeWorktree("marked", {
      marker: JSON.stringify({ worktreeId: "wt_f6bbf517", createdAt: "2026-07-16T22:40:52.442Z" }),
    })

    expect(resolveWorktreeIdentity(tree)).toEqual({
      worktreePath: tree,
      worktreeId: "wt_f6bbf517",
    })
  })

  it("reports the worktree ROOT for a session spawned in a subdirectory", () => {
    const { tree } = makeWorktree("marked", {
      marker: JSON.stringify({ worktreeId: "wt_deadbeef", createdAt: "2026-07-16T22:40:52.442Z" }),
    })
    const deep = join(tree, "packages", "runtime", "src")
    mkdirSync(deep, { recursive: true })

    expect(resolveWorktreeIdentity(deep)).toEqual({
      worktreePath: tree,
      worktreeId: "wt_deadbeef",
    })
  })

  // A bare `git worktree add` writes no marker — the path is still knowable,
  // the generation isn't. The field must be absent, not null/empty.
  it("omits the id for a worktree with no provision marker", () => {
    const { tree } = makeWorktree("bare")

    const identity = resolveWorktreeIdentity(tree)

    expect(identity).toEqual({ worktreePath: tree })
    expect(identity && "worktreeId" in identity).toBe(false)
  })

  it("resolves a relative gitdir link against the worktree root", () => {
    const { tree } = makeWorktree("relative", {
      relativeLink: true,
      marker: JSON.stringify({ worktreeId: "wt_relative", createdAt: "2026-07-16T22:40:52.442Z" }),
    })

    expect(resolveWorktreeIdentity(tree)).toEqual({
      worktreePath: tree,
      worktreeId: "wt_relative",
    })
  })

  it("keeps the path when the marker is unreadable, rather than throwing", () => {
    const { tree } = makeWorktree("corrupt", { marker: "{ not json" })

    expect(resolveWorktreeIdentity(tree)).toEqual({ worktreePath: tree })
  })

  it("returns undefined for a plain checkout and its subdirectories", () => {
    const src = join(base, "repo", "src")
    mkdirSync(src, { recursive: true })

    expect(resolveWorktreeIdentity(join(base, "repo"))).toBeUndefined()
    expect(resolveWorktreeIdentity(src)).toBeUndefined()
  })

  // A submodule's `.git` is a `gitdir:` file too — only a linked worktree's
  // admin dir carries the `gitdir` back-pointer, which is what tells them
  // apart. Without that check every submodule would report as a worktree.
  it("returns undefined for a submodule checkout", () => {
    const moduleDir = join(base, "repo", ".git", "modules", "vendor")
    const submodule = join(base, "repo", "vendor")
    mkdirSync(moduleDir, { recursive: true })
    mkdirSync(submodule, { recursive: true })
    writeFileSync(join(submodule, ".git"), `gitdir: ${moduleDir}\n`)

    expect(resolveWorktreeIdentity(submodule)).toBeUndefined()
  })

  it("does not throw for a cwd that no longer exists", () => {
    expect(resolveWorktreeIdentity(join(base, "repo", "gone", "deeper"))).toBeUndefined()
  })

  it("reports mainRepoPath for a linked worktree carrying a commondir file", () => {
    const { tree } = makeWorktree("marked", {
      marker: JSON.stringify({ worktreeId: "wt_f6bbf517", createdAt: "2026-07-16T22:40:52.442Z" }),
      commondir: "../..",
    })

    expect(resolveWorktreeIdentity(tree)).toEqual({
      worktreePath: tree,
      worktreeId: "wt_f6bbf517",
      mainRepoPath: join(base, "repo"),
    })
  })

  it("resolves an absolute commondir just as well as a relative one", () => {
    const { tree } = makeWorktree("abscommondir", {
      commondir: join(base, "repo", ".git"),
    })

    expect(resolveWorktreeIdentity(tree)).toEqual({
      worktreePath: tree,
      mainRepoPath: join(base, "repo"),
    })
  })

  it("omits mainRepoPath (without throwing) when commondir is missing", () => {
    const { tree } = makeWorktree("nocommondir")

    const identity = resolveWorktreeIdentity(tree)

    expect(identity).toEqual({ worktreePath: tree })
    expect(identity && "mainRepoPath" in identity).toBe(false)
  })

  it("omits mainRepoPath when commondir is empty", () => {
    const { tree, admin } = makeWorktree("emptycommondir")
    writeFileSync(join(admin, "commondir"), "")

    const identity = resolveWorktreeIdentity(tree)

    expect(identity).toEqual({ worktreePath: tree })
    expect(identity && "mainRepoPath" in identity).toBe(false)
  })

  it("a plain checkout / a dir outside any repo still reports no mainRepoPath", () => {
    expect(resolveWorktreeIdentity(join(base, "repo"))).toBeUndefined()
    expect(resolveWorktreeIdentity(base)).toBeUndefined()
  })
})
