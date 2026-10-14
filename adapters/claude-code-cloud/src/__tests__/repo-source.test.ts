import { describe, expect, it } from "vitest"
import { validateRepoSource, type GitRunner } from "../repo-source.js"

/** Fake git: answers per subcommand from a scripted table. */
function fakeGit(
  answers: Partial<Record<string, { code: number; stdout: string; stderr?: string }>>,
): { git: GitRunner; seen: string[][] } {
  const seen: string[][] = []
  const git: GitRunner = async args => {
    seen.push(args)
    // Key by the first two args where useful ("branch -r", "rev-parse"…)
    const key = args.slice(0, 2).join(" ")
    const answer =
      answers[key] ?? answers[args[0] ?? ""] ?? { code: 1, stdout: "", stderr: "unexpected" }
    return { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "" }
  }
  return { git, seen }
}

const CLEAN_GIT = {
  "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
  "status --porcelain": { code: 0, stdout: "" },
  "remote get-url": { code: 0, stdout: "git@github.com:acme/repo.git\n" },
  "rev-parse HEAD": { code: 0, stdout: "deadbeef\n" },
  "branch -r": { code: 0, stdout: "  origin/main\n" },
}

describe("validateRepoSource", () => {
  it("accepts a clean checkout whose HEAD is on origin", async () => {
    const { git, seen } = fakeGit(CLEAN_GIT)
    await expect(validateRepoSource("/repo", git)).resolves.toBeUndefined()
    expect(seen.length).toBe(5)
  })

  it("refuses a cwd that is not a git checkout", async () => {
    const { git } = fakeGit({
      "rev-parse --is-inside-work-tree": { code: 128, stdout: "", stderr: "not a git repo" },
    })
    await expect(validateRepoSource("/not-a-repo", git)).rejects.toThrow(
      /not a git checkout/,
    )
  })

  it("refuses a dirty working tree", async () => {
    const { git } = fakeGit({
      ...CLEAN_GIT,
      "status --porcelain": { code: 0, stdout: " M src/index.ts\n" },
    })
    await expect(validateRepoSource("/repo", git)).rejects.toThrow(
      /working tree in \/repo is dirty/,
    )
  })

  it("refuses a checkout with no origin remote", async () => {
    const { git } = fakeGit({
      ...CLEAN_GIT,
      "remote get-url": { code: 1, stdout: "", stderr: "no such remote 'origin'" },
    })
    await expect(validateRepoSource("/repo", git)).rejects.toThrow(
      /no origin remote/,
    )
  })

  it("refuses an unpushed HEAD (not reachable from origin)", async () => {
    const { git } = fakeGit({
      ...CLEAN_GIT,
      "branch -r": { code: 0, stdout: "" },
    })
    await expect(validateRepoSource("/repo", git)).rejects.toThrow(
      /not reachable from origin/,
    )
  })
})
