/**
 * `createReviewPackLoader` — the runtime `PackLoader`: relative path, npm
 * (fake `node_modules`, no network), and git (local bare repo fixture,
 * pinned-sha cache, floating ref rejected).
 */

import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createReviewPackLoader, defaultReviewPackCacheDir } from "../review-pack-loader.js"

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const PACK_SOURCE = [
  "---",
  "kind: review-pack",
  "id: core",
  "version: 1.0.0",
  "checks:",
  "  - {id: correctness, kind: agent, rubric: ./rubrics/correctness.md}",
  "---",
  "",
  "Core pack.",
].join("\n")

const cleanup: string[] = []
let workdir: string

beforeEach(async () => {
  workdir = await realpath(await mkdtemp(join(tmpdir(), "agp-pack-loader-")))
  cleanup.push(workdir)
})
afterEach(async () => {
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true })
})

async function writePackDir(dir: string): Promise<void> {
  await mkdir(join(dir, "rubrics"), { recursive: true })
  await writeFile(join(dir, "REVIEW.md"), PACK_SOURCE)
  await writeFile(join(dir, "rubrics", "correctness.md"), "# rubric\nFind bugs.\n")
}

describe("createReviewPackLoader — relative path", () => {
  it("resolves against the consumer's manifest directory and reads rubrics from the pack root", async () => {
    const repoRoot = join(workdir, "repo")
    const manifestDir = repoRoot
    await mkdir(repoRoot, { recursive: true })
    await writePackDir(join(repoRoot, "packs", "core"))

    const loader = createReviewPackLoader({ repoRoot, manifestDir })
    const source = await loader.load("./packs/core")
    expect(source.refKind).toBe("relative")
    expect(source.manifest.id).toBe("core")
    expect(source.root).toBe(join(repoRoot, "packs", "core"))
    const rubric = await source.readRubric("./rubrics/correctness.md")
    expect(Buffer.from(rubric).toString("utf8")).toContain("Find bugs.")
  })

  it("throws a clear error when the resolved path has no REVIEW.md", async () => {
    const repoRoot = join(workdir, "repo")
    await mkdir(join(repoRoot, "packs", "empty"), { recursive: true })
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    await expect(loader.load("./packs/empty")).rejects.toThrow(/no REVIEW\.md/)
  })
})

describe("createReviewPackLoader — npm", () => {
  it("resolves a package name from the reviewed repo's node_modules, no network", async () => {
    const repoRoot = join(workdir, "repo")
    const pkgDir = join(repoRoot, "node_modules", "@fake-scope", "review-pack-core")
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@fake-scope/review-pack-core", version: "1.0.0" }))
    await writePackDir(pkgDir)
    await mkdir(repoRoot, { recursive: true })
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "consumer" }))

    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    const source = await loader.load("@fake-scope/review-pack-core")
    expect(source.refKind).toBe("npm")
    expect(source.manifest.id).toBe("core")
    expect(source.root).toBe(pkgDir)
  })

  it("errors clearly when the package isn't in node_modules", async () => {
    const repoRoot = join(workdir, "repo")
    await mkdir(repoRoot, { recursive: true })
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "consumer" }))
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    await expect(loader.load("@fake-scope/does-not-exist")).rejects.toThrow(/not resolvable/)
  })
})

describe("createReviewPackLoader — git", () => {
  async function makeBareFixture(): Promise<{ url: string; sha: string; branch: string }> {
    const work = join(workdir, "git-work")
    await mkdir(work, { recursive: true })
    sh(work, "init", "-q", "-b", "main")
    sh(work, "config", "user.email", "t@example.com")
    sh(work, "config", "user.name", "t")
    sh(work, "config", "commit.gpgsign", "false")
    await writePackDir(work)
    sh(work, "add", "-A")
    sh(work, "commit", "-qm", "pack v1")
    const sha = sh(work, "rev-parse", "HEAD")

    const bare = join(workdir, "git-bare.git")
    sh(workdir, "clone", "-q", "--bare", work, bare)
    return { url: bare, sha, branch: "main" }
  }

  it("clones a full-sha-pinned ref into the cache dir and reuses it on a second resolve", async () => {
    const fixture = await makeBareFixture()
    const cacheDir = join(workdir, "cache")
    const repoRoot = join(workdir, "repo")
    await mkdir(repoRoot, { recursive: true })
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot, cacheDir })

    const ref = `git+file://${fixture.url}#${fixture.sha}`
    const first = await loader.load(ref)
    expect(first.refKind).toBe("git")
    expect(first.manifest.id).toBe("core")
    expect(first.root).toBe(join(cacheDir, fixture.sha))

    // Second resolve reuses the cache: works even if the origin is now gone.
    await rm(fixture.url, { recursive: true, force: true })
    const second = await loader.load(ref)
    expect(second.root).toBe(first.root)
  })

  it("rejects a floating ref (branch, not a full 40-hex sha)", async () => {
    const fixture = await makeBareFixture()
    const repoRoot = join(workdir, "repo")
    await mkdir(repoRoot, { recursive: true })
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot, cacheDir: join(workdir, "cache") })
    await expect(loader.load(`git+file://${fixture.url}#${fixture.branch}`)).rejects.toThrow(/pinned to a full 40-hex commit sha/)
  })
})

describe("defaultReviewPackCacheDir", () => {
  it("lives under ~/.agentproto/review-packs", () => {
    expect(defaultReviewPackCacheDir()).toMatch(/\.agentproto[/\\]review-packs$/)
  })
})
