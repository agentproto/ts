/**
 * `createReviewPackLoader` — the runtime `PackLoader`: relative path (+ the
 * `allowCommands` trust boundary — realpath inside the repo AND tracked by
 * git, never merely "the ref string looked relative"), npm (fake
 * `node_modules`, no network), and git (a real local git+https fixture,
 * pinned-sha cache, floating ref / non-https transport rejected).
 */

import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createReviewPackLoader, defaultReviewPackCacheDir } from "../review-pack-loader.js"
import { startGitHttpsFixture, type GitHttpsFixture } from "./helpers/git-https-fixture.js"

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

describe("createReviewPackLoader — relative path trust (the allowCommands exemption)", () => {
  async function gitRepo(): Promise<string> {
    const repoRoot = join(workdir, "repo")
    await mkdir(repoRoot, { recursive: true })
    sh(repoRoot, "init", "-q", "-b", "main")
    sh(repoRoot, "config", "user.email", "t@example.com")
    sh(repoRoot, "config", "user.name", "t")
    sh(repoRoot, "config", "commit.gpgsign", "false")
    await writeFile(join(repoRoot, "a.txt"), "a\n")
    sh(repoRoot, "add", "-A")
    sh(repoRoot, "commit", "-qm", "base")
    return repoRoot
  }

  it("a pack tracked by git inside the repo is trusted", async () => {
    const repoRoot = await gitRepo()
    await writePackDir(join(repoRoot, "packs", "core"))
    sh(repoRoot, "add", "-A")
    sh(repoRoot, "commit", "-qm", "add pack")
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    const source = await loader.load("./packs/core")
    expect(source.trusted).toBe(true)
  })

  it("an untracked directory inside the repo is NOT trusted (never committed)", async () => {
    const repoRoot = await gitRepo()
    await writePackDir(join(repoRoot, "packs", "scratch"))
    // Deliberately NOT `git add` — this pack's REVIEW.md is untracked.
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    const source = await loader.load("./packs/scratch")
    expect(source.trusted).toBe(false)
  })

  it("a ./node_modules path inside the repo is NOT trusted (untracked, the common case)", async () => {
    const repoRoot = await gitRepo()
    await writePackDir(join(repoRoot, "node_modules", "evil"))
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    const source = await loader.load("./node_modules/evil")
    expect(source.trusted).toBe(false)
  })

  it("a ../ escape outside the repo is NOT trusted, even though it loads fine", async () => {
    const repoRoot = await gitRepo()
    const outside = join(workdir, "outside-pack")
    await writePackDir(outside)
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    const source = await loader.load("../outside-pack")
    expect(source.manifest.id).toBe("core") // it DOES resolve —
    expect(source.trusted).toBe(false) //  — it's just not exempt from allowCommands
  })

  it("an absolute path outside the repo is NOT trusted", async () => {
    const repoRoot = await gitRepo()
    const outside = join(workdir, "abs-outside-pack")
    await writePackDir(outside)
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    const source = await loader.load(outside)
    expect(source.trusted).toBe(false)
  })

  it("a symlink inside the repo pointing outside it is NOT trusted (realpath sees through it)", async () => {
    const repoRoot = await gitRepo()
    const outside = join(workdir, "symlink-target-pack")
    await writePackDir(outside)
    await symlink(outside, join(repoRoot, "linked-pack"))
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    const source = await loader.load("./linked-pack")
    expect(source.manifest.id).toBe("core")
    expect(source.trusted).toBe(false)
  })

  it("an absolute path that resolves to a TRACKED in-repo location is trusted", async () => {
    const repoRoot = await gitRepo()
    await writePackDir(join(repoRoot, "packs", "core"))
    sh(repoRoot, "add", "-A")
    sh(repoRoot, "commit", "-qm", "add pack")
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot })
    const source = await loader.load(join(repoRoot, "packs", "core"))
    expect(source.trusted).toBe(true)
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
  let fixture: GitHttpsFixture

  async function makeBareFixture(): Promise<{ sha: string; branch: string }> {
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

    const projectRoot = join(workdir, "git-http-root")
    await mkdir(projectRoot, { recursive: true })
    const bare = join(projectRoot, "pack.git")
    sh(workdir, "clone", "-q", "--bare", work, bare)
    fixture = await startGitHttpsFixture(projectRoot)
    return { sha, branch: "main" }
  }

  afterEach(async () => {
    await fixture?.close()
  })

  it("clones a full-sha-pinned git+https:// ref into the cache dir and reuses it on a second resolve", async () => {
    const { sha } = await makeBareFixture()
    const cacheDir = join(workdir, "cache")
    const repoRoot = join(workdir, "repo")
    await mkdir(repoRoot, { recursive: true })
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot, cacheDir, env: fixture.env })

    const ref = `git+${fixture.url}/pack.git#${sha}`
    const first = await loader.load(ref)
    expect(first.refKind).toBe("git")
    expect(first.trusted).toBe(false) // git packs are NEVER exempt from allowCommands
    expect(first.manifest.id).toBe("core")
    expect(first.root).toBe(join(cacheDir, sha))

    // Second resolve reuses the cache: works even once the fixture is closed.
    await fixture.close()
    const second = await loader.load(ref)
    expect(second.root).toBe(first.root)
  })

  it("rejects a floating ref (branch, not a full 40-hex sha)", async () => {
    const { branch } = await makeBareFixture()
    const repoRoot = join(workdir, "repo")
    await mkdir(repoRoot, { recursive: true })
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot, cacheDir: join(workdir, "cache"), env: fixture.env })
    await expect(loader.load(`git+${fixture.url}/pack.git#${branch}`)).rejects.toThrow(/pinned to a full 40-hex commit sha/)
  })

  // Defense in depth: the loader validates the transport itself rather than
  // trusting that `parseReviewManifest` already screened the ref — these
  // calls skip the manifest layer entirely (direct `loader.load`).
  it.each([
    ["ssh transport", () => `git+ssh://git@example.com/org/pack.git#${"a".repeat(40)}`],
    ["file transport", () => `git+file:///tmp/pack#${"a".repeat(40)}`],
    ["ext:: transport (arbitrary local command execution)", () => `git+ext::sh -c 'touch /tmp/pwned'#${"a".repeat(40)}`],
    ["plain http (not https)", () => `git+http://example.com/org/pack.git#${"a".repeat(40)}`],
    ["a leading-dash URL masquerading as a git flag", () => `git+--upload-pack=touch /tmp/pwned#${"a".repeat(40)}`],
  ])("rejects a git ref that isn't git+https:// at the loader level — %s", async (_label, makeRef) => {
    const repoRoot = join(workdir, "repo")
    await mkdir(repoRoot, { recursive: true })
    const loader = createReviewPackLoader({ repoRoot, manifestDir: repoRoot, cacheDir: join(workdir, "cache") })
    await expect(loader.load(makeRef())).rejects.toThrow(/must use git\+https:\/\//)
  })
})

describe("defaultReviewPackCacheDir", () => {
  it("lives under ~/.agentproto/review-packs", () => {
    expect(defaultReviewPackCacheDir()).toMatch(/\.agentproto[/\\]review-packs$/)
  })
})
