import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, realpath, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execGit } from "../exec.js"
import {
  computeProvenance,
  readSessionsRegistry,
  sessionInWorktree,
  readWorktreeMarker,
  writeWorktreeMarker,
} from "../provenance.js"

async function makeSessionsFile(dir: string, sessions: readonly unknown[]): Promise<string> {
  const path = join(dir, "sessions.json")
  await writeFile(path, JSON.stringify({ sessions }))
  return path
}

describe("sessionInWorktree — containment, not equality (PLAN.md §1.5)", () => {
  it("matches an exact cwd", () => {
    expect(sessionInWorktree({ id: "s", startedAt: "t", status: "running", cwd: "/a/b" }, "/a/b")).toBe(true)
  })
  it("matches a subdirectory cwd", () => {
    expect(sessionInWorktree({ id: "s", startedAt: "t", status: "running", cwd: "/a/b/pkg" }, "/a/b")).toBe(true)
  })
  it("does NOT match a sibling path that merely shares the prefix string", () => {
    // /a/b-other starts with "/a/b" as a raw string but is not under "/a/b".
    expect(sessionInWorktree({ id: "s", startedAt: "t", status: "running", cwd: "/a/b-other" }, "/a/b")).toBe(false)
  })
  it("does not match a session with no recorded cwd", () => {
    expect(sessionInWorktree({ id: "s", startedAt: "t", status: "running" }, "/a/b")).toBe(false)
  })
})

describe("readSessionsRegistry", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  it("returns [] for a missing file — no daemon has ever run is not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-prov-"))
    cleanupPaths.push(dir)
    expect(await readSessionsRegistry(join(dir, "nope.json"))).toEqual([])
  })

  it("returns null for a corrupt file — distinguishable from 'no history'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-prov-"))
    cleanupPaths.push(dir)
    const path = join(dir, "sessions.json")
    await writeFile(path, "not json")
    expect(await readSessionsRegistry(path)).toBeNull()
  })

  it("parses well-formed entries and skips malformed ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-prov-"))
    cleanupPaths.push(dir)
    const path = await makeSessionsFile(dir, [
      { id: "sess_1", startedAt: "2026-01-01T00:00:00.000Z", status: "running", cwd: "/x" },
      { id: "sess_2" }, // missing startedAt/status — dropped
      "not an object", // dropped
    ])
    const sessions = await readSessionsRegistry(path)
    expect(sessions).toEqual([
      { id: "sess_1", startedAt: "2026-01-01T00:00:00.000Z", status: "running", cwd: "/x" },
    ])
  })

  it("parses optional provenance fields and mirrors auth.mode -> authMode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-prov-"))
    cleanupPaths.push(dir)
    const path = await makeSessionsFile(dir, [
      {
        id: "sess_full",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "running",
        cwd: "/x",
        adapterSlug: "claude-code",
        model: "claude-opus-4-8",
        costUsd: 0.1234,
        tokensIn: 12345,
        tokensOut: 67890,
      },
      {
        id: "sess_auth_mirror",
        startedAt: "2026-01-02T00:00:00.000Z",
        status: "running",
        cwd: "/y",
        auth: { mode: "subscription", fingerprint: "fp" },
      },
    ])
    const sessions = await readSessionsRegistry(path)
    expect(sessions).toEqual([
      {
        id: "sess_full",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "running",
        cwd: "/x",
        adapterSlug: "claude-code",
        model: "claude-opus-4-8",
        costUsd: 0.1234,
        tokensIn: 12345,
        tokensOut: 67890,
      },
      {
        id: "sess_auth_mirror",
        startedAt: "2026-01-02T00:00:00.000Z",
        status: "running",
        cwd: "/y",
        authMode: "subscription",
      },
    ])
  })

  it("omitting optional provenance fields still parses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-prov-"))
    cleanupPaths.push(dir)
    const path = await makeSessionsFile(dir, [
      { id: "sess_minimal", startedAt: "2026-01-01T00:00:00.000Z", status: "running", cwd: "/x" },
    ])
    const sessions = await readSessionsRegistry(path)
    expect(sessions).toEqual([
      { id: "sess_minimal", startedAt: "2026-01-01T00:00:00.000Z", status: "running", cwd: "/x" },
    ])
  })
})

describe("computeProvenance", () => {
  const cleanupPaths: string[] = []
  afterEach(async () => {
    while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
  })

  it("best-effort confidence with no marker — matches sessions by containment, sorted oldest-first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-prov-"))
    cleanupPaths.push(dir)
    const worktreePath = join(dir, "worktree")
    await mkdir(worktreePath)
    const sessionsPath = await makeSessionsFile(dir, [
      { id: "s2", startedAt: "2026-01-02T00:00:00.000Z", status: "exited", cwd: worktreePath },
      { id: "s1", startedAt: "2026-01-01T00:00:00.000Z", status: "exited", cwd: join(worktreePath, "pkg") },
      { id: "s3", startedAt: "2026-01-03T00:00:00.000Z", status: "exited", cwd: "/somewhere/else" },
    ])
    const provenance = await computeProvenance(worktreePath, worktreePath, { sessionsPath })
    expect(provenance.confidence).toBe("best-effort")
    expect(provenance.sessions.map((s) => s.id)).toEqual(["s1", "s2"])
  })

  it("exact confidence + createdAt floor when the PR-B gitdir marker is present", async () => {
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-prov-repo-")))
    cleanupPaths.push(repoRoot)
    await execGit(repoRoot, ["init", "-b", "main"])
    await execGit(repoRoot, ["config", "user.email", "t@e.com"])
    await execGit(repoRoot, ["config", "user.name", "T"])
    await writeFile(join(repoRoot, "README.md"), "hi\n")
    await execGit(repoRoot, ["add", "README.md"])
    await execGit(repoRoot, ["commit", "-m", "init"])

    const marker = { worktreeId: "wt_1", createdAt: "2026-01-02T00:00:00.000Z" }
    await writeFile(join(repoRoot, ".git", "agentproto-worktree.json"), JSON.stringify(marker))

    const dir = await mkdtemp(join(tmpdir(), "wt-prov-"))
    cleanupPaths.push(dir)
    const sessionsPath = await makeSessionsFile(dir, [
      { id: "before", startedAt: "2026-01-01T00:00:00.000Z", status: "exited", cwd: repoRoot },
      { id: "after", startedAt: "2026-01-03T00:00:00.000Z", status: "exited", cwd: repoRoot },
    ])
    const provenance = await computeProvenance(repoRoot, repoRoot, { sessionsPath })
    expect(provenance.confidence).toBe("exact")
    expect(provenance.sessions.map((s) => s.id)).toEqual(["after"])
  })

  it("readWorktreeMarker returns null when absent (every worktree today, pre-PR-B)", async () => {
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-prov-repo-")))
    cleanupPaths.push(repoRoot)
    await execGit(repoRoot, ["init", "-b", "main"])
    expect(await readWorktreeMarker(repoRoot, repoRoot)).toBeNull()
  })

  it("writeWorktreeMarker + readWorktreeMarker round-trip through the private gitdir, not .git/config", async () => {
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "wt-prov-repo-")))
    cleanupPaths.push(repoRoot)
    await execGit(repoRoot, ["init", "-b", "main"])
    await execGit(repoRoot, ["config", "user.email", "t@e.com"])
    await execGit(repoRoot, ["config", "user.name", "T"])
    await writeFile(join(repoRoot, "README.md"), "hi\n")
    await execGit(repoRoot, ["add", "README.md"])
    await execGit(repoRoot, ["commit", "-m", "init"])

    const marker = { worktreeId: "wt_abc12345", createdAt: "2026-07-15T00:00:00.000Z" }
    await writeWorktreeMarker(repoRoot, repoRoot, marker)

    expect(await readWorktreeMarker(repoRoot, repoRoot)).toEqual(marker)
    // Written into the gitdir, not the shared `.git/config` the PLAN rejects.
    const raw = await readFile(join(repoRoot, ".git", "agentproto-worktree.json"), "utf8")
    expect(JSON.parse(raw)).toEqual(marker)
  })
})

describe("readSessionsRegistry — the partitioned registry (AIP-46 §State partitioning)", () => {
  const realHome = process.env.HOME
  const homes: string[] = []

  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    while (homes.length) await rm(homes.pop()!, { recursive: true, force: true })
  })

  async function isolatedHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "agentproto-prov-"))
    homes.push(home)
    process.env.HOME = home
    return home
  }

  const session = (id: string, cwd: string) => ({
    id,
    startedAt: "2026-07-01T00:00:00.000Z",
    status: "exited",
    cwd,
  })

  async function writeBucket(home: string, slug: string, sessions: unknown[]): Promise<void> {
    const dir = join(home, ".agentproto", "workspaces", slug)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "sessions.json"), JSON.stringify({ sessions }))
  }

  async function writeLegacy(home: string, sessions: unknown[]): Promise<void> {
    await mkdir(join(home, ".agentproto"), { recursive: true })
    await writeFile(join(home, ".agentproto", "sessions.json"), JSON.stringify({ sessions }))
  }

  it("unions every bucket with the legacy snapshot", async () => {
    // The regression this guards: provenance feeds computeWorktreeStatus
    // -> the GC plan -> applyGc, which REMOVES worktrees. Reading only
    // the (now frozen) legacy file would hide every partitioned session,
    // making an actively-used worktree look never-touched and eligible
    // for deletion. Under-reporting here deletes work.
    const home = await isolatedHome()
    await writeBucket(home, "alpha", [session("a1", "/tmp/alpha")])
    await writeBucket(home, "beta", [session("b1", "/tmp/beta")])
    await writeLegacy(home, [session("old-1", "/tmp/legacy")])

    const sessions = await readSessionsRegistry()
    expect(sessions?.map((s) => s.id).sort()).toEqual(["a1", "b1", "old-1"])
  })

  it("dedupes by id, the live bucket row winning over the frozen legacy copy", async () => {
    const home = await isolatedHome()
    await writeBucket(home, "alpha", [session("dup", "/tmp/bucket-copy")])
    await writeLegacy(home, [session("dup", "/tmp/legacy-copy")])

    const sessions = await readSessionsRegistry()
    expect(sessions).toHaveLength(1)
    expect(sessions?.[0]?.cwd).toBe("/tmp/bucket-copy")
  })

  it("reads buckets even with no legacy file at all (a fresh install)", async () => {
    const home = await isolatedHome()
    await writeBucket(home, "alpha", [session("a1", "/tmp/alpha")])

    expect((await readSessionsRegistry())?.map((s) => s.id)).toEqual(["a1"])
  })

  it("one corrupt bucket does not blind the join to the rest", async () => {
    const home = await isolatedHome()
    await writeBucket(home, "alpha", [session("a1", "/tmp/alpha")])
    await mkdir(join(home, ".agentproto", "workspaces", "broken"), { recursive: true })
    await writeFile(join(home, ".agentproto", "workspaces", "broken", "sessions.json"), "{ not json")

    expect((await readSessionsRegistry())?.map((s) => s.id)).toEqual(["a1"])
  })

  it("returns null when every source that exists is unreadable", async () => {
    const home = await isolatedHome()
    await writeLegacy(home, [])
    await writeFile(join(home, ".agentproto", "sessions.json"), "{ not json")

    expect(await readSessionsRegistry()).toBeNull()
  })

  it("empty (not null) when nothing has ever run", async () => {
    await isolatedHome()
    expect(await readSessionsRegistry()).toEqual([])
  })

  it("an explicit path still means that one file, nothing else", async () => {
    const home = await isolatedHome()
    await writeBucket(home, "alpha", [session("a1", "/tmp/alpha")])
    const pinned = await makeSessionsFile(home, [session("pinned", "/tmp/pinned")])

    // The bucket row must NOT bleed into a pinned read — fixtures stay hermetic.
    expect((await readSessionsRegistry(pinned))?.map((s) => s.id)).toEqual(["pinned"])
  })
})

describe("computeProvenance — joins over buckets, not just the legacy file", () => {
  const realHome = process.env.HOME
  const dirs: string[] = []

  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
  })

  it("finds a session recorded in a bucket for an unmarked worktree", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentproto-prov-home-"))
    dirs.push(home)
    process.env.HOME = home

    const worktree = await realpath(await mkdtemp(join(tmpdir(), "agentproto-prov-wt-")))
    dirs.push(worktree)

    const dir = join(home, ".agentproto", "workspaces", "alpha")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "sessions.json"),
      JSON.stringify({
        sessions: [
          { id: "in-bucket", startedAt: "2026-07-01T00:00:00.000Z", status: "exited", cwd: worktree },
        ],
      }),
    )

    // No `sessionsPath` — this is the production call shape, and before
    // the union it would have found nothing here.
    const provenance = await computeProvenance(worktree, worktree)
    expect(provenance.sessions.map((s) => s.id)).toEqual(["in-bucket"])
  })
})
