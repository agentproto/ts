/**
 * Unit tests for `agentproto sessions start` — specifically the
 * orchestrator / mcpServers flag parity added on top of the base
 * `--cwd --workspace --model --prompt --label` flags.
 *
 * Follows the fake-daemon pattern in sessions-export.test.ts: intercept
 * `discoverDaemon` and `httpPostJson` from _daemon-helpers so no real
 * socket IO happens, then assert on the POST body captured from the mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { resolve } from "node:path"
import { runSessions } from "../commands/sessions.js"

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readFile: readFileMock,
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
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpPostJson = vi.mocked(helpers.httpPostJson)

describe("agentproto sessions start — orchestrator / mcpServers flags", () => {
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

    readFileMock.mockReset()
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpPostJson.mockResolvedValue({
      id: "sess_001",
      kind: "agent",
      status: "running",
      command: "claude-code",
      workspaceSlug: "default",
      startedAt: new Date().toISOString(),
    })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("USAGE documents the new flags", async () => {
    const code = await runSessions(["--help"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).toContain("--orchestrator")
    expect(out).toContain("--orchestrator-json")
    expect(out).toContain("--mcp-servers-json")
  })

  it("sends orchestrator: true for the --orchestrator boolean shorthand", async () => {
    const code = await runSessions(["start", "claude-code", "--orchestrator"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(1)
    const [url, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe("http://127.0.0.1:18790/sessions/agent")
    expect(body.orchestrator).toBe(true)
    expect(body.mcpServers).toBeUndefined()
  })

  it("defaults cwd to the shell directory when neither --cwd nor --workspace is given", async () => {
    const code = await runSessions(["start", "claude-code"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.cwd).toBe(process.cwd())
  })

  it("resolves an explicit --cwd over the shell default", async () => {
    await runSessions(["start", "claude-code", "--cwd", "/tmp/foo"])
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.cwd).toBe(resolve("/tmp/foo"))
  })

  it("does not stamp a shell cwd when --workspace is given (daemon resolves it)", async () => {
    await runSessions(["start", "claude-code", "--workspace", "agentproto"])
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.cwd).toBeUndefined()
    expect(body.workspaceSlug).toBe("agentproto")
  })

  it("parses --orchestrator-json into the object form", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--orchestrator-json",
      '{"tools":["agent_start"],"maxDepth":2,"maxChildren":5}',
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.orchestrator).toEqual({
      tools: ["agent_start"],
      maxDepth: 2,
      maxChildren: 5,
    })
  })

  it("prefers --orchestrator-json over --orchestrator when both are given", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--orchestrator",
      "--orchestrator-json",
      '{"maxDepth":3}',
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.orchestrator).toEqual({ maxDepth: 3 })
  })

  it("fails fast on malformed --orchestrator-json before any network call", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--orchestrator-json",
      "{not valid json",
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(discoverDaemon).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("invalid --orchestrator-json")
  })

  it("parses inline --mcp-servers-json into an array on the POST body", async () => {
    const servers = [
      { name: "fs", transport: "stdio", ref: "npx:@modelcontextprotocol/server-filesystem" },
      { name: "search", transport: "http" },
    ]
    const code = await runSessions([
      "start",
      "claude-code",
      "--mcp-servers-json",
      JSON.stringify(servers),
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.mcpServers).toEqual(servers)
  })

  it("fails fast on malformed --mcp-servers-json before any network call", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--mcp-servers-json",
      "not json at all",
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(discoverDaemon).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("invalid --mcp-servers-json")
  })

  it("fails fast when --mcp-servers-json parses to a non-array", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--mcp-servers-json",
      '{"name":"fs"}',
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("invalid --mcp-servers-json")
  })

  it("reads --mcp-servers-json from a file when prefixed with @", async () => {
    const servers = [{ name: "fs", transport: "stdio" }]
    readFileMock.mockResolvedValue(JSON.stringify(servers))

    const code = await runSessions([
      "start",
      "claude-code",
      "--mcp-servers-json",
      "@/tmp/mcp-servers.json",
    ])

    expect(code).toBe(0)
    expect(readFileMock).toHaveBeenCalledWith("/tmp/mcp-servers.json", "utf8")
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.mcpServers).toEqual(servers)
  })

  it("fails fast with a clear message when the @file does not exist", async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const code = await runSessions([
      "start",
      "claude-code",
      "--mcp-servers-json",
      "@/tmp/does-not-exist.json",
    ])

    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("could not read --mcp-servers-json file")
  })

  it("omits orchestrator and mcpServers from the body when neither flag is passed", async () => {
    const code = await runSessions(["start", "claude-code"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.orchestrator).toBeUndefined()
    expect(body.mcpServers).toBeUndefined()
  })

  it("USAGE documents --title (FIX C)", async () => {
    const code = await runSessions(["--help"])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("--title")
  })

  it("sends --title on the POST body, alongside --label", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--title",
      "Nightly audit",
      "--label",
      "audit",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.title).toBe("Nightly audit")
    expect(body.label).toBe("audit")
  })

  it("omits title from the body when --title is not passed", async () => {
    const code = await runSessions(["start", "claude-code"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.title).toBeUndefined()
  })
})

describe("agentproto sessions start — --access-profile / --worktree flags", () => {
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

    readFileMock.mockReset()
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpPostJson.mockResolvedValue({
      id: "sess_001",
      kind: "agent",
      status: "running",
      command: "claude-code",
      workspaceSlug: "default",
      startedAt: new Date().toISOString(),
    })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it("USAGE documents --access-profile, --worktree and --no-worktree", async () => {
    const code = await runSessions(["--help"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).toContain("--access-profile")
    expect(out).toContain("--worktree")
    expect(out).toContain("--no-worktree")
    expect(out).toContain("--mode")
    expect(out).toContain("--effort")
  })

  it("sends body.mode and body.effort for --mode / --effort", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--mode",
      "plan",
      "--effort",
      "xhigh",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.mode).toBe("plan")
    expect(body.effort).toBe("xhigh")
  })

  it("sends body.access = { profileRef } for --access-profile", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--access-profile",
      "claude-max",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.access).toEqual({ profileRef: "claude-max" })
  })

  it("omits body.access when --access-profile is not passed", async () => {
    await runSessions(["start", "claude-code"])
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.access).toBeUndefined()
  })

  it("sends body.worktree = true for --worktree", async () => {
    const code = await runSessions(["start", "claude-code", "--worktree"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.worktree).toBe(true)
  })

  it("sends body.worktree = false for --no-worktree", async () => {
    const code = await runSessions(["start", "claude-code", "--no-worktree"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.worktree).toBe(false)
  })

  it("rejects --worktree and --no-worktree together before any network call", async () => {
    const code = await runSessions(["start", "claude-code", "--worktree", "--no-worktree"])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(discoverDaemon).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("mutually exclusive")
  })

  it("omits body.worktree when neither flag is passed (daemon policy decides)", async () => {
    await runSessions(["start", "claude-code"])
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.worktree).toBeUndefined()
  })

  it("sends body.sandbox as a bare string for a provider slug", async () => {
    const code = await runSessions(["start", "claude-code", "--sandbox", "e2b"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.sandbox).toBe("e2b")
  })

  it("sends body.sandbox as a parsed object for inline JSON", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--sandbox",
      '{"provider":"e2b","reuse":"sbx_123"}',
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.sandbox).toEqual({ provider: "e2b", reuse: "sbx_123" })
  })

  it("reads --sandbox @<file> and parses its JSON contents", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ provider: "box" }))
    const code = await runSessions([
      "start",
      "claude-code",
      "--sandbox",
      "@/tmp/sandbox-spec.json",
    ])
    expect(code).toBe(0)
    expect(readFileMock).toHaveBeenCalledWith("/tmp/sandbox-spec.json", "utf8")
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.sandbox).toEqual({ provider: "box" })
  })

  it("rejects invalid --sandbox JSON before any network call", async () => {
    const code = await runSessions(["start", "claude-code", "--sandbox", "{not json"])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("invalid --sandbox JSON")
  })

  it("omits body.sandbox when --sandbox is not passed", async () => {
    await runSessions(["start", "claude-code"])
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.sandbox).toBeUndefined()
  })

  it("USAGE documents --sandbox", async () => {
    const code = await runSessions(["--help"])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("--sandbox")
  })

  it("combo: --orchestrator --access-profile wires both on the body (WP-R5 repro)", async () => {
    const code = await runSessions([
      "start",
      "claude-code",
      "--orchestrator",
      "--access-profile",
      "claude-pro-max",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.orchestrator).toBe(true)
    expect(body.access).toEqual({ profileRef: "claude-pro-max" })
  })

  it("prints the worktree path in the plain-text success line when the descriptor has one", async () => {
    httpPostJson.mockResolvedValue({
      id: "sess_001",
      kind: "agent",
      status: "running",
      command: "claude-code",
      workspaceSlug: "default",
      worktreePath: "/tmp/wt/claude-worktree-7",
      startedAt: new Date().toISOString(),
    })
    const code = await runSessions(["start", "claude-code", "--worktree"])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("worktree: /tmp/wt/claude-worktree-7")
  })

  it("omits the worktree line from the success line when the descriptor has none", async () => {
    const code = await runSessions(["start", "claude-code"])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).not.toContain("worktree:")
  })

  it("frames an access_profile_ineligible daemon failure with an actionable hint", async () => {
    httpPostJson.mockRejectedValue(
      new Error(
        'HTTP 400: {"error":"access_profile_ineligible","message":"profile \\"foo\\" (api/subscription) is not eligible for adapter \\"claude-code\\" on route \\"default\\" (billed endpoint: api)."}',
      ),
    )
    const code = await runSessions([
      "start",
      "claude-code",
      "--access-profile",
      "foo",
    ])
    expect(code).toBe(1)
    const err = stderrChunks.join("")
    expect(err).toContain("access_profile_ineligible")
    expect(err).toContain("not eligible")
    expect(err).toContain("--access-profile")
  })

  it("frames an access_profile_not_found daemon failure with an actionable hint", async () => {
    httpPostJson.mockRejectedValue(
      new Error('HTTP 400: {"error":"access_profile_not_found","message":"no auth profile \\"ghost\\" found."}'),
    )
    const code = await runSessions([
      "start",
      "claude-code",
      "--access-profile",
      "ghost",
    ])
    expect(code).toBe(1)
    const err = stderrChunks.join("")
    expect(err).toContain("access_profile_not_found")
    expect(err).toContain("no auth profile")
  })
})
