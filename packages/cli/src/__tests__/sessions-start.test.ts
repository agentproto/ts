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
