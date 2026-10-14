import { describe, expect, it } from "vitest"
import {
  cloudChildEnv,
  parseAuthStatus,
  parseCloudStartOutput,
  preflightAuth,
  CLAUDE_CODE_GATEWAY_ENV_UNSET,
  type CloudCliRunner,
  type PtyHandle,
  type RunOpts,
  type RunResult,
} from "../cli.js"
import { validateRepoSource, type GitRunner } from "../repo-source.js"

/** Fake runner: canned `claude auth status` answers; records every call. */
function fakeRunner(
  authStatus: { code: number; stdout: string; stderr?: string },
): { runner: CloudCliRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const runner: CloudCliRunner = {
    async run(cmd, args, _opts: RunOpts): Promise<RunResult> {
      calls.push({ cmd, args })
      return { code: authStatus.code, stdout: authStatus.stdout, stderr: authStatus.stderr ?? "" }
    },
    runPty(): PtyHandle {
      throw new Error("not used in these tests")
    },
  }
  return { runner, calls }
}

describe("cloudChildEnv", () => {
  it("deletes ANTHROPIC_API_KEY and every gateway/redirect toggle", () => {
    const env = cloudChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-secret",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
      CLAUDE_CODE_USE_MANTLE: "1",
      CLAUDE_CODE_USE_GATEWAY: "1",
      KEEP_ME: "yes",
    })
    expect(env).toEqual({ PATH: "/usr/bin", KEEP_ME: "yes" })
    for (const key of CLAUDE_CODE_GATEWAY_ENV_UNSET) {
      expect(env).not.toHaveProperty(key)
    }
  })
})

describe("preflightAuth", () => {
  it("refuses an api_key-authenticated CLI with the login hint", async () => {
    const { runner, calls } = fakeRunner({
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key" }),
    })
    await expect(
      preflightAuth(runner, { cwd: "/repo", env: {} }),
    ).rejects.toThrow(/authenticated by API key[\s\S]*run `claude auth login`/)
    expect(calls).toEqual([
      { cmd: "claude", args: ["auth", "status"] },
    ])
  })

  it("refuses a not-logged-in CLI with the login hint", async () => {
    const { runner } = fakeRunner({
      code: 0,
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }),
    })
    await expect(
      preflightAuth(runner, { cwd: "/repo", env: {} }),
    ).rejects.toThrow(/not logged in[\s\S]*run `claude auth login`/)
  })

  it("accepts an oauth login and reports the method", async () => {
    const { runner } = fakeRunner({
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude_ai_oauth" }),
    })
    await expect(preflightAuth(runner, { cwd: "/repo", env: {} })).resolves.toEqual({
      loggedIn: true,
      authMethod: "claude_ai_oauth",
    })
  })

  it("parses auth-status JSON even with surrounding CLI noise", () => {
    expect(
      parseAuthStatus('Some banner\n{"loggedIn":true,"authMethod":"oauth"}\n'),
    ).toEqual({ loggedIn: true, authMethod: "oauth" })
    expect(() => parseAuthStatus("not json at all")).toThrow(
      /could not parse/,
    )
  })
})

describe("parseCloudStartOutput", () => {
  it("extracts id, url and title from a real-shaped start transcript", () => {
    const parsed = parseCloudStartOutput(
      [
        "Created cloud session: fix the flaky test",
        "View: https://claude.ai/code/session_01XyzAbC?tab=cloud",
        "Resume with: claude --teleport session_01XyzAbC",
      ].join("\n"),
    )
    expect(parsed).toEqual({
      sessionId: "session_01XyzAbC",
      url: "https://claude.ai/code/session_01XyzAbC?tab=cloud",
      title: "fix the flaky test",
    })
  })

  it("falls back to the View URL when the resume line is absent", () => {
    expect(
      parseCloudStartOutput("View: https://claude.ai/code/session_abc"),
    ).toEqual({
      sessionId: "session_abc",
      url: "https://claude.ai/code/session_abc",
    })
  })

  it("returns null when no session id can be found", () => {
    expect(parseCloudStartOutput("everything failed")).toBeNull()
  })
})

// ── repo source (AIP-66 §3) ─────────────────────────────────────────────────

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
