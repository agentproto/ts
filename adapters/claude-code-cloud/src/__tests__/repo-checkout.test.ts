import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CLOUD_GIT_TOKEN_ENV,
  CLOUD_REPO_BRANCH_ENV,
  CLOUD_REPO_DIR_ENV,
  CLOUD_REPO_URL_ENV,
  cloudRepoSourceFromEnv,
  materializeRepoCheckout,
} from "../repo-checkout.js"
import { validateRepoSource, type GitRunner } from "../repo-source.js"
import { cloudChildEnv } from "../cli.js"

describe("cloudRepoSourceFromEnv", () => {
  it("returns null when no repo is declared", () => {
    expect(cloudRepoSourceFromEnv({})).toBeNull()
  })

  it("reads url + dir, defaulting the branch to main", () => {
    expect(
      cloudRepoSourceFromEnv({
        [CLOUD_REPO_URL_ENV]: "https://github.com/acme/repo",
        [CLOUD_REPO_DIR_ENV]: "/cfg/repo",
      }),
    ).toEqual({ url: "https://github.com/acme/repo", branch: "main", dir: "/cfg/repo" })
    expect(
      cloudRepoSourceFromEnv({
        [CLOUD_REPO_URL_ENV]: "https://github.com/acme/repo",
        [CLOUD_REPO_DIR_ENV]: "/cfg/repo",
        [CLOUD_REPO_BRANCH_ENV]: "develop",
      })?.branch,
    ).toBe("develop")
  })

  it("fails closed on a half-declared source", () => {
    expect(() =>
      cloudRepoSourceFromEnv({ [CLOUD_REPO_URL_ENV]: "https://github.com/acme/repo" }),
    ).toThrow(/must be set together/)
    expect(() => cloudRepoSourceFromEnv({ [CLOUD_REPO_DIR_ENV]: "/cfg/repo" })).toThrow(
      /must be set together/,
    )
  })
})

describe("materializeRepoCheckout — token hygiene", () => {
  it("passes the token only through a credential helper that names the env var", async () => {
    const seen: string[][] = []
    const git: GitRunner = async args => {
      seen.push(args)
      return { code: 0, stdout: "", stderr: "" }
    }
    const dir = join(await mkdtemp(join(tmpdir(), "cc-cloud-hyg-")), "repo")
    await materializeRepoCheckout(
      { url: "https://github.com/acme/repo", branch: "main", dir },
      { git, hasToken: true },
    )
    const clone = seen.find(a => a.includes("clone"))!
    expect(clone).toContain("https://github.com/acme/repo")
    expect(clone.join(" ")).toContain(`$${CLOUD_GIT_TOKEN_ENV}`)
    // No literal token can be in argv: the helper reads it from env by name.
    expect(clone.join(" ")).not.toMatch(/password=[^$]/)
  })

  it("never hands the git token to the vendor CLI children", () => {
    expect(cloudChildEnv({ PATH: "/usr/bin", [CLOUD_GIT_TOKEN_ENV]: "ghp_secret" })).toEqual({
      PATH: "/usr/bin",
    })
  })
})

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim()
}

describe("materializeRepoCheckout — real git", () => {
  let root: string
  let remote: string
  let work: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-cloud-repo-"))
    remote = join(root, "remote.git")
    work = join(root, "work")
    sh(root, "init", "--bare", "--initial-branch=main", remote)
    sh(root, "clone", remote, work)
    await writeFile(join(work, "README.md"), "v1\n")
    sh(work, "add", ".")
    sh(work, "commit", "-m", "v1")
    sh(work, "push", "origin", "HEAD:main")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("clones the declared branch into a checkout the repo-source gate accepts", async () => {
    const dir = join(root, "cfg", "repo")
    const out = await materializeRepoCheckout({ url: remote, branch: "main", dir }, { hasToken: false })
    expect(out).toBe(dir)
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("v1\n")
    await expect(validateRepoSource(dir)).resolves.toBeUndefined()
    // The token helper is per-command only — nothing persisted in the clone.
    expect(await readFile(join(dir, ".git", "config"), "utf8")).not.toContain("credential")
  })

  it("on re-materialize, fetches the new tip and discards local edits", async () => {
    const dir = join(root, "cfg", "repo")
    await materializeRepoCheckout({ url: remote, branch: "main", dir }, { hasToken: false })
    await writeFile(join(dir, "README.md"), "dirty\n")
    await writeFile(join(dir, "stray.txt"), "x\n")

    await writeFile(join(work, "README.md"), "v2\n")
    sh(work, "commit", "-am", "v2")
    sh(work, "push", "origin", "HEAD:main")

    await materializeRepoCheckout({ url: remote, branch: "main", dir }, { hasToken: false })
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("v2\n")
    expect(sh(dir, "status", "--porcelain")).toBe("")
    expect(sh(dir, "rev-parse", "HEAD")).toBe(sh(work, "rev-parse", "HEAD"))
    await expect(validateRepoSource(dir)).resolves.toBeUndefined()
  })

  it("refuses to reuse a dir that is a checkout of a different remote", async () => {
    const dir = join(root, "cfg", "repo")
    await materializeRepoCheckout({ url: remote, branch: "main", dir }, { hasToken: false })
    await expect(
      materializeRepoCheckout(
        { url: "https://github.com/acme/other", branch: "main", dir },
        { hasToken: false },
      ),
    ).rejects.toThrow(/not the declared remote/)
  })

  it("reports a missing branch as a clone failure", async () => {
    const dir = join(root, "cfg", "repo")
    await expect(
      materializeRepoCheckout({ url: remote, branch: "nope", dir }, { hasToken: false }),
    ).rejects.toThrow(/could not clone/)
  })
})
