/**
 * Tests for `createGithubWorkspaceSync` — use REAL git against a temp dir
 * with a local bare origin (no network), and a stub `PrCreator` for PR
 * assertions. Covers: pull (clone + fetch), commit-with-identity, push
 * (branchPolicy main / per-conversation), PR-open per each `prPolicy`
 * (none / auto / manual), no-op push when clean, multi-attribution
 * (Co-authored-by trailer), merge conflict abort.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { createGithubWorkspaceSync } from "../github-sync.js"
import { createGithubFilesystem } from "../github-fs.js"
import { defineGithubStorage } from "../index.js"
import { hasWorkspaceSync } from "@agentproto/storage"
import type { PrCreator, PrResult } from "../pr.js"
import type { GithubStorageConfig } from "../types.js"

/** Run git in a given cwd. */
function git(args: string[], cwd: string, env?: Record<string, string>): string {
  const res = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${res.stderr ?? res.stdout}`,
    )
  }
  return (res.stdout ?? "").trim()
}

/** Create a bare origin repo with one initial commit on `main`. */
async function makeBareOrigin(
  dir: string,
  name = "origin-repo",
): Promise<string> {
  const originPath = join(dir, name + ".git")
  git(["init", "--bare", "-b", "main", originPath], dir)
  // Seed an initial commit via a temp clone.
  const seedPath = join(dir, name + "-seed")
  await mkdir(seedPath, { recursive: true })
  git(["init", "-b", "main", "."], seedPath)
  git(["config", "user.name", "Seeder"], seedPath)
  git(["config", "user.email", "seeder@example.com"], seedPath)
  await writeFile(join(seedPath, "README.md"), "# initial\n")
  git(["add", "-A"], seedPath)
  git(["commit", "-m", "initial commit"], seedPath)
  git(["remote", "add", "origin", originPath], seedPath)
  git(["push", "-u", "origin", "main"], seedPath)
  return originPath
}

const TOKEN = "test-token-not-real"

/** Stub PrCreator — records calls and returns a fake PR. */
function makeStubPrCreator(): PrCreator & {
  calls: Array<{ head: string; base: string; title: string }>
} {
  const calls: Array<{ head: string; base: string; title: string }> = []
  return {
    calls,
    async openPr(input): Promise<PrResult> {
      calls.push({ head: input.head, base: input.base, title: input.title })
      return { prUrl: `https://github.com/test/pull/${calls.length}`, prNumber: calls.length }
    },
  }
}

/** Failing PrCreator — simulates a token lacking pull-requests:write. */
const failingPrCreator: PrCreator = {
  async openPr(): Promise<PrResult> {
    throw new Error("Resource not accessible by integration (403)")
  },
}

describe("createGithubWorkspaceSync", () => {
  let tmpRoot: string
  let originPath: string
  let workspaceDir: string
  // A local file:// origin that simulates github.com — we use the real
  // repoUrl as a file path since the tests run real git.

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "storage-github-"))
    originPath = await makeBareOrigin(tmpRoot)
    workspaceDir = join(tmpRoot, "workspace")
    await mkdir(workspaceDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const baseConfig: GithubStorageConfig = {
    repoUrl: "", // set per-test to the local origin path
    branchPolicy: "main",
    prPolicy: "none",
  }

  it("pull clones an empty tree from the origin", async () => {
    const config: GithubStorageConfig = { ...baseConfig, repoUrl: originPath }
    const fs = createGithubFilesystem(config, { workspaceDir, token: TOKEN }, {
      prCreator: makeStubPrCreator(),
    })
    const result = await fs.pull(fs)
    expect(result.seeded).toBe(true)
    expect(result.files).toBeGreaterThan(0)
    // The README from the seed commit is present.
    expect(await fs.exists("README.md")).toBe(true)
    expect(await fs.readFile("README.md")).toContain("initial")
  })

  it("pull is a no-op when the tree is already populated (fetch+merge)", async () => {
    const config: GithubStorageConfig = { ...baseConfig, repoUrl: originPath }
    const fs = createGithubFilesystem(config, { workspaceDir, token: TOKEN }, {
      prCreator: makeStubPrCreator(),
    })
    // First pull seeds.
    await fs.pull(fs)
    // Second pull should fetch+merge (ff) and report seeded: false.
    const result = await fs.pull(fs)
    expect(result.seeded).toBe(false)
    expect(result.message).toContain("pulled")
  })

  it("push commits and pushes to main when branchPolicy=main, prPolicy=none", async () => {
    const config: GithubStorageConfig = {
      ...baseConfig,
      repoUrl: originPath,
      branchPolicy: "main",
      prPolicy: "none",
    }
    const fs = createGithubFilesystem(config, { workspaceDir, token: TOKEN }, {
      prCreator: makeStubPrCreator(),
    })
    await fs.pull(fs)
    await fs.writeFile("notes.md", "hello from agent")
    const result = await fs.push(fs, { label: "test-run", summary: "add notes" })
    expect(result.kind).toBe("pushed")
    if (result.kind === "pushed") {
      expect(result.ref).toBe("main")
      expect(result.files).toBeGreaterThan(0)
      expect(result.prUrl).toBeUndefined()
    }
    // Verify the commit landed on the origin.
    const originHead = git(["log", "--oneline", "-1", "main"], originPath)
    expect(originHead).toContain("add notes")
  })

  it("push returns no_changes when the working tree is clean", async () => {
    const config: GithubStorageConfig = { ...baseConfig, repoUrl: originPath }
    const fs = createGithubFilesystem(config, { workspaceDir, token: TOKEN }, {
      prCreator: makeStubPrCreator(),
    })
    await fs.pull(fs)
    const result = await fs.push(fs)
    expect(result.kind).toBe("no_changes")
  })

  it("push creates a per-conversation branch and opens an auto PR", async () => {
    const pr = makeStubPrCreator()
    const config: GithubStorageConfig = {
      ...baseConfig,
      // Canonical HTTPS repo for PR owner/repo parsing; clone from the
      // local bare origin so the test uses real git without network.
      repoUrl: "https://github.com/test/repo",
      cloneUrl: originPath,
      branchPolicy: "per-conversation",
      prPolicy: "auto",
    }
    const fs = createGithubFilesystem(
      config,
      { workspaceDir, token: TOKEN, conversationId: "conv-42" },
      { prCreator: pr },
    )
    await fs.pull(fs)
    await fs.writeFile("doc.md", "per-conversation edit")
    const result = await fs.push(fs, { label: "conv-42", summary: "per-conv" })
    expect(result.kind).toBe("pushed")
    if (result.kind === "pushed") {
      expect(result.ref).toBe("agentproto/conv-42")
      expect(result.prUrl).toContain("github.com/test/pull/")
      expect(result.prNumber).toBe(1)
    }
    expect(pr.calls).toHaveLength(1)
    expect(pr.calls[0]?.head).toBe("agentproto/conv-42")
    expect(pr.calls[0]?.base).toBe("main")
  })

  it("push with prPolicy=manual returns a hint, no auto PR", async () => {
    const pr = makeStubPrCreator()
    const config: GithubStorageConfig = {
      ...baseConfig,
      repoUrl: originPath,
      branchPolicy: "per-conversation",
      prPolicy: "manual",
    }
    const fs = createGithubFilesystem(
      config,
      { workspaceDir, token: TOKEN, conversationId: "conv-99" },
      { prCreator: pr },
    )
    await fs.pull(fs)
    await fs.writeFile("doc.md", "manual pr")
    const result = await fs.push(fs, { label: "conv-99" })
    expect(result.kind).toBe("pushed")
    if (result.kind === "pushed") {
      expect(result.ref).toBe("agentproto/conv-99")
      expect(result.prUrl).toBeUndefined()
      expect(result.errors?.[0]).toContain("pr_policy=manual")
    }
    expect(pr.calls).toHaveLength(0)
  })

  it("push with prPolicy=auto but a failing PR creator still reports the push", async () => {
    const config: GithubStorageConfig = {
      ...baseConfig,
      // Canonical HTTPS repo for PR owner/repo parsing; clone from the
      // local bare origin so the test uses real git without network.
      repoUrl: "https://github.com/test/repo",
      cloneUrl: originPath,
      branchPolicy: "per-conversation",
      prPolicy: "auto",
    }
    const fs = createGithubFilesystem(
      config,
      { workspaceDir, token: TOKEN, conversationId: "conv-fail" },
      { prCreator: failingPrCreator },
    )
    await fs.pull(fs)
    await fs.writeFile("doc.md", "will fail PR")
    const result = await fs.push(fs)
    expect(result.kind).toBe("pushed")
    if (result.kind === "pushed") {
      expect(result.ref).toBe("agentproto/conv-fail")
      expect(result.prUrl).toBeUndefined()
      expect(result.errors?.[0]).toContain("403")
    }
  })

  it("commit uses AIP-23 identity as author and adds Co-authored-by trailers", async () => {
    const config: GithubStorageConfig = {
      ...baseConfig,
      repoUrl: originPath,
      branchPolicy: "main",
      prPolicy: "none",
    }
    const identity = [
      { name: "Primary Bot", email: "primary@example.com" },
      { name: "Second Bot", email: "second@example.com" },
    ]
    const fs = createGithubFilesystem(
      config,
      { workspaceDir, token: TOKEN, identity },
      { prCreator: makeStubPrCreator() },
    )
    await fs.pull(fs)
    await fs.writeFile("trailers.md", "multi-author")
    await fs.push(fs, { summary: "multi-author commit" })
    // Inspect the commit on the origin.
    const body = git(["log", "-1", "--format=%an <%ae>%n%n%b", "main"], originPath)
    expect(body).toContain("Primary Bot <primary@example.com>")
    expect(body).toContain("Co-authored-by: Second Bot <second@example.com>")
  })

  it("commit falls back to a default author when identity is missing", async () => {
    const config: GithubStorageConfig = {
      ...baseConfig,
      repoUrl: originPath,
      branchPolicy: "main",
      prPolicy: "none",
    }
    const fs = createGithubFilesystem(
      config,
      { workspaceDir, token: TOKEN },
      { prCreator: makeStubPrCreator() },
    )
    await fs.pull(fs)
    await fs.writeFile("x.md", "no identity")
    await fs.push(fs)
    const author = git(["log", "-1", "--format=%an", "main"], originPath)
    expect(author).toBe("agentproto")
  })

  it("hasWorkspaceSync is true for the github filesystem", async () => {
    const config: GithubStorageConfig = { ...baseConfig, repoUrl: originPath }
    const fs = createGithubFilesystem(config, { workspaceDir, token: TOKEN })
    expect(hasWorkspaceSync(fs)).toBe(true)
  })

  it("defineGithubStorage produces a handle with factory + capabilities", () => {
    const handle = defineGithubStorage({
      repoUrl: "https://github.com/owner/repo",
      branchPolicy: "per-conversation",
      prPolicy: "auto",
    })
    expect(handle.provider).toBe("github")
    expect(typeof handle.factory).toBe("function")
    expect(handle.capabilities?.transport).toBe("git")
    expect(handle.capabilities?.prPolicy).toBe("auto")
  })

  it("pull reports a failed clone when the origin URL is invalid", async () => {
    const config: GithubStorageConfig = {
      ...baseConfig,
      repoUrl: "/nonexistent/path/repo.git",
    }
    const fs = createGithubFilesystem(config, { workspaceDir, token: TOKEN }, {
      prCreator: makeStubPrCreator(),
    })
    const result = await fs.pull(fs)
    expect(result.seeded).toBe(false)
    expect(result.message).toContain("clone failed")
  })
})
