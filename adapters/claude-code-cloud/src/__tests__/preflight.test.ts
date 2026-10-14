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
