/**
 * Unit tests for `agentproto sessions terminal` focused on the new
 * `--preset` surface and its interaction with raw argv.
 *
 * Follows the fake-daemon pattern: intercept `discoverDaemon` and
 * `httpPostJson` so no real socket IO happens, and intercept
 * `@agentproto/runtime/config` so no real config file is read.
 */

import { resolve } from "node:path"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"

vi.mock("@agentproto/runtime/config", async importOriginal => {
  const orig = await importOriginal<typeof import("@agentproto/runtime/config")>()
  return {
    ...orig,
    loadConfig: vi.fn(),
  }
})

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpPostJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const { loadConfig } = await import("@agentproto/runtime/config")

const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpPostJson = vi.mocked(helpers.httpPostJson)
const mockLoadConfig = vi.mocked(loadConfig)

describe("agentproto sessions terminal — preset / argv behavior", () => {
  let stderrChunks: string[]
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stderrChunks = []
    stdoutChunks = []
    stderrSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stderr as any, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk))
        return true
      })
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk))
        return true
      })

    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpPostJson.mockResolvedValue({
      id: "sess_term_001",
      kind: "terminal",
      status: "running",
      command: "claude --resume",
      workspaceSlug: "default",
      startedAt: new Date().toISOString(),
      pty: true,
    })
    mockLoadConfig.mockResolvedValue({
      terminalPresets: {
        terra: {
          argv: ["claude", "--resume"],
          env: {
            ANTHROPIC_BASE_URL: "http://localhost:4000",
            NO_COLOR: "1",
          },
          cwd: "~/projects/terra",
          workspace: "terra",
          name: "terra-tui",
          label: "Terra local TUI",
        },
        "env-only": {
          env: { FOO: "bar" },
        },
      },
    })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("USAGE documents --preset and the generic example", async () => {
    const code = await runSessions(["--help"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).toContain("--preset")
    expect(out).toContain("terminalPresets")
    expect(out).toContain("local-tui")
  })

  it("sends argv, env and preset metadata when --preset is used without --", async () => {
    const code = await runSessions(["terminal", "--preset", "terra"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(1)
    const [url, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe("http://127.0.0.1:18790/sessions/terminal")
    expect(body.argv).toEqual(["claude", "--resume"])
    expect(body.env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:4000",
      NO_COLOR: "1",
    })
    expect(body.cwd).toBe(resolveExpected("~/projects/terra"))
    expect(body.workspaceSlug).toBe("terra")
    expect(body.name).toBe("terra-tui")
    expect(body.label).toBe("Terra local TUI")
  })

  it("lets explicit argv override preset argv", async () => {
    const code = await runSessions(["terminal", "--preset", "terra", "--", "zsh"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.argv).toEqual(["zsh"])
    expect(body.env).toEqual({
      ANTHROPIC_BASE_URL: "http://localhost:4000",
      NO_COLOR: "1",
    })
  })

  it("lets explicit --cwd/--workspace/--name/--label override preset values", async () => {
    const code = await runSessions([
      "terminal",
      "--preset",
      "terra",
      "--cwd",
      "/explicit",
      "--workspace",
      "explicit-ws",
      "--name",
      "explicit-name",
      "--label",
      "explicit-label",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.cwd).toBe(resolveExpected("/explicit"))
    expect(body.workspaceSlug).toBe("explicit-ws")
    expect(body.name).toBe("explicit-name")
    expect(body.label).toBe("explicit-label")
  })

  it("emits an actionable error when the preset is not found", async () => {
    const code = await runSessions(["terminal", "--preset", "missing"])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(discoverDaemon).not.toHaveBeenCalled()
    const err = stderrChunks.join("")
    expect(err).toContain('terminal preset "missing" not found')
    expect(err).toContain("~/.agentproto/config.json")
  })

  it("emits an actionable error when the preset defines no argv and none is given", async () => {
    const code = await runSessions(["terminal", "--preset", "env-only"])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(discoverDaemon).not.toHaveBeenCalled()
    const err = stderrChunks.join("")
    expect(err).toContain('preset "env-only" does not define argv')
    expect(err).toContain("-- claude")
  })

  it("keeps raw argv launch unchanged when no --preset is passed", async () => {
    const code = await runSessions(["terminal", "--", "bash", "-l"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.argv).toEqual(["bash", "-l"])
    expect(body.env).toBeUndefined()
    expect(body.cwd).toBeUndefined()
    expect(body.workspaceSlug).toBeUndefined()
    expect(body.name).toBeUndefined()
    expect(body.label).toBeUndefined()
  })

  it("emits the existing missing-argv error when no preset and no argv", async () => {
    const code = await runSessions(["terminal"])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(discoverDaemon).not.toHaveBeenCalled()
    const err = stderrChunks.join("")
    expect(err).toContain("missing argv")
    expect(err).toContain("--preset")
  })

  it("does not leak env values in normal text output", async () => {
    const code = await runSessions(["terminal", "--preset", "terra"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).not.toContain("ANTHROPIC_BASE_URL")
    expect(out).not.toContain("localhost:4000")
    expect(out).not.toContain("NO_COLOR")
  })

  it("does not leak env values in --json output", async () => {
    const code = await runSessions(["terminal", "--preset", "terra", "--json"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).not.toContain("ANTHROPIC_BASE_URL")
    expect(out).not.toContain("localhost:4000")
  })
})

function resolveExpected(input: string): string {
  return resolve(input)
}
