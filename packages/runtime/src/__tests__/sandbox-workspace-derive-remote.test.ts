import { describe, it, expect, vi } from "vitest"
import {
  deriveWorkspaceRemote,
  normalizeGitRemoteUrl,
  resolveSandboxWorkspaceSource,
  type GitRunner,
} from "../sandbox-workspace-derive-remote.js"

describe("normalizeGitRemoteUrl", () => {
  it.each([
    ["git@github.com:acme/repo.git", "https://github.com/acme/repo.git"],
    ["github.com:acme/repo", "https://github.com/acme/repo"],
    ["ssh://git@github.com/acme/repo.git", "https://github.com/acme/repo.git"],
    ["ssh://git@git.example.com:2222/acme/repo.git", "https://git.example.com/acme/repo.git"],
    ["git+ssh://git@host.dev/o/r.git", "https://host.dev/o/r.git"],
    ["git://host.dev/o/r.git", "https://host.dev/o/r.git"],
    ["https://github.com/acme/repo.git", "https://github.com/acme/repo.git"],
    ["  https://github.com/acme/repo.git\n", "https://github.com/acme/repo.git"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeGitRemoteUrl(raw)).toBe(expected)
  })

  it("strips credentials embedded in an https origin", () => {
    const out = normalizeGitRemoteUrl("https://user:ghp_secret@github.com/acme/repo.git")
    expect(out).toBe("https://github.com/acme/repo.git")
    expect(out).not.toContain("ghp_secret")
  })

  it.each([
    "/Users/op/repos/thing",
    "../thing",
    "file:///srv/git/thing.git",
    "http://insecure.example.com/o/r.git",
    "C:\\repos\\thing",
    "",
    "   ",
  ])("rejects %j (no https equivalent)", raw => {
    expect(normalizeGitRemoteUrl(raw)).toBeUndefined()
  })
})

interface FakeRepo {
  inside?: boolean
  remotes?: Record<string, string>
  originHead?: string
  currentBranch?: string
  /** Branches that exist on origin (answered by ls-remote). */
  onOrigin?: string[]
  /** Branches with a local origin tracking ref. */
  tracked?: string[]
}

function fakeGit(repo: FakeRepo): { git: GitRunner; calls: string[][]; isolated: string[][] } {
  const calls: string[][] = []
  const isolated: string[][] = []
  const git: GitRunner = async (args, opts) => {
    calls.push(args)
    if (opts.isolated) isolated.push(args)
    const key = args.join(" ")
    if (key === "rev-parse --is-inside-work-tree") {
      return repo.inside === false ? { ok: false, stdout: "" } : { ok: true, stdout: "true\n" }
    }
    if (args[0] === "remote" && args[1] === "get-url") {
      const url = repo.remotes?.[args[2]!]
      return url ? { ok: true, stdout: `${url}\n` } : { ok: false, stdout: "" }
    }
    if (key === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
      return repo.originHead ? { ok: true, stdout: `origin/${repo.originHead}\n` } : { ok: false, stdout: "" }
    }
    if (key === "rev-parse --abbrev-ref HEAD") {
      return repo.currentBranch ? { ok: true, stdout: `${repo.currentBranch}\n` } : { ok: false, stdout: "" }
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      const name = args[3]!.replace("refs/remotes/origin/", "")
      return repo.tracked?.includes(name) ? { ok: true, stdout: "sha\n" } : { ok: false, stdout: "" }
    }
    if (args.includes("ls-remote") && args.includes("--heads")) {
      return repo.onOrigin?.includes(args[args.length - 1]!) ? { ok: true, stdout: "sha\n" } : { ok: false, stdout: "" }
    }
    return { ok: false, stdout: "" }
  }
  return { git, calls, isolated }
}

const workspace = { slug: "acme", path: "/Users/op/acme" }

describe("deriveWorkspaceRemote", () => {
  it("derives a public repo anonymously, read-only, with origin's default branch", async () => {
    const { git } = fakeGit({
      remotes: { origin: "git@github.com:acme/repo.git" },
      originHead: "trunk",
      currentBranch: "feature-x",
    })
    const isPubliclyCloneable = vi.fn(async () => true)
    const result = await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.remote).toEqual({
      url: "https://github.com/acme/repo.git",
      defaultBranch: "trunk",
      derived: true,
    })
    expect(result.remote.credentialRef).toBeUndefined()
    expect(isPubliclyCloneable).toHaveBeenCalledWith("https://github.com/acme/repo.git")
    expect(result.notice).toContain("read-only")
    expect(result.notice).toContain("NOT from your local checkout")
    expect(result.notice).toContain("agentproto workspace remote set acme")
  })

  it("never attaches a credential, even when a keychain slot exists for the workspace", async () => {
    const { git } = fakeGit({ remotes: { origin: "git@github.com:acme/repo.git" }, originHead: "main" })
    const result = await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable: async () => true })
    expect(result.ok && result.remote).not.toHaveProperty("credentialRef")
  })

  it("falls back to the current branch when origin/HEAD is unset and the branch exists on origin", async () => {
    const { git } = fakeGit({
      remotes: { origin: "https://github.com/acme/repo.git" },
      currentBranch: "develop",
      onOrigin: ["develop"],
    })
    const result = await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable: async () => true })
    expect(result.ok && result.remote.defaultBranch).toBe("develop")
  })

  it("accepts the current branch from the local origin tracking ref without any network call", async () => {
    const { git, calls } = fakeGit({
      remotes: { origin: "https://github.com/acme/repo.git" },
      currentBranch: "develop",
      tracked: ["develop"],
    })
    const result = await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable: async () => true })
    expect(result.ok && result.remote.defaultBranch).toBe("develop")
    expect(calls.some(c => c.includes("ls-remote"))).toBe(false)
  })

  it("ignores an unpushed current branch and uses the default branch", async () => {
    const { git } = fakeGit({
      remotes: { origin: "https://github.com/acme/repo.git" },
      currentBranch: "local-only",
      onOrigin: ["main"],
    })
    const result = await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable: async () => true })
    expect(result.ok && result.remote.defaultBranch).toBe("main")
  })

  it("checks the branch against the normalized https URL, isolated from user git config, never the raw origin", async () => {
    const { git, calls, isolated } = fakeGit({
      remotes: { origin: "git@github.com:acme/repo.git" },
      currentBranch: "develop",
      onOrigin: ["develop"],
    })
    await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable: async () => true })
    const lsRemote = calls.filter(c => c.includes("ls-remote"))
    expect(lsRemote).toHaveLength(1)
    expect(lsRemote[0]).toContain("https://github.com/acme/repo.git")
    expect(lsRemote[0]).not.toContain("origin")
    expect(isolated).toEqual(lsRemote)
  })

  it("skips a repo that is not publicly cloneable, with a fix in the notice", async () => {
    const { git } = fakeGit({ remotes: { origin: "git@github.com:acme/private.git" }, originHead: "main" })
    const result = await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable: async () => false })
    expect(result).toMatchObject({ ok: false, reason: "not-publicly-cloneable" })
    expect(result.notice).toContain("never carries a credential")
    expect(result.notice).toContain("agentproto workspace remote set acme")
  })

  it("refuses when the repo has no origin, even if another remote exists", async () => {
    const { git, calls } = fakeGit({ remotes: { upstream: "git@github.com:other/repo.git" } })
    const result = await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable: async () => true })
    expect(result).toMatchObject({ ok: false, reason: "no-origin" })
    expect(result.notice).toContain("remote add origin")
    const urlLookups = calls.filter(c => c[0] === "remote" && c[1] === "get-url")
    expect(urlLookups).toEqual([["remote", "get-url", "origin"]])
  })

  it("refuses a directory that is not a git repository", async () => {
    const { git } = fakeGit({ inside: false })
    const result = await deriveWorkspaceRemote(workspace, { git })
    expect(result).toMatchObject({ ok: false, reason: "not-a-git-repo" })
  })

  it("refuses an origin with no https equivalent", async () => {
    const { git } = fakeGit({ remotes: { origin: "/srv/git/local.git" } })
    const result = await deriveWorkspaceRemote(workspace, { git })
    expect(result).toMatchObject({ ok: false, reason: "unsupported-origin" })
  })

  it("never puts the raw origin or an embedded token in a notice", async () => {
    const { git } = fakeGit({
      remotes: { origin: "https://me:ghp_supersecret@github.com/acme/repo.git" },
      originHead: "main",
    })
    const derived = await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable: async () => true })
    expect(JSON.stringify(derived)).not.toContain("ghp_supersecret")
    const refused = await deriveWorkspaceRemote(workspace, { git, isPubliclyCloneable: async () => false })
    expect(JSON.stringify(refused)).not.toContain("ghp_supersecret")
  })
})

describe("resolveSandboxWorkspaceSource", () => {
  it("returns a configured remote untouched, without consulting git", async () => {
    const git = vi.fn<GitRunner>()
    const remote = { url: "https://github.com/acme/configured.git", credentialRef: "agentproto.git.acme" }
    const source = await resolveSandboxWorkspaceSource({ ...workspace, remote }, { git })
    expect(source).toEqual({ kind: "remote", remote, notices: [] })
    expect(git).not.toHaveBeenCalled()
  })

  it("derives from origin when nothing is configured", async () => {
    const { git } = fakeGit({ remotes: { origin: "git@github.com:acme/repo.git" }, originHead: "main" })
    const source = await resolveSandboxWorkspaceSource(workspace, { git, isPubliclyCloneable: async () => true })
    expect(source.kind).toBe("remote")
    expect(source.notices).toHaveLength(1)
    if (source.kind === "remote") expect(source.remote).toMatchObject({ derived: true })
  })

  it("falls back to tar mode, carrying the reason, when nothing can be derived", async () => {
    const { git } = fakeGit({ inside: false })
    const source = await resolveSandboxWorkspaceSource(workspace, { git })
    expect(source.kind).toBe("tar")
    expect(source.notices[0]).toContain("not a git repository")
  })
})
