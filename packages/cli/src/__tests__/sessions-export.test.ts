/**
 * Unit tests for `agentproto sessions export` subcommand.
 *
 * Tests the CLI routing and flag parsing without needing a live daemon
 * by intercepting `discoverDaemon` and `httpGetJson` before they hit the
 * network / filesystem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"

// ── mock node:fs for the -o file-write test ──────────────────────────────────

const { writeFileSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
}))

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    writeFileSync,
    default: { ...actual, writeFileSync },
  }
})

// ── mock the daemon-helper module so no real socket IO happens ────────────────

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)
const printNoDaemonError = vi.mocked(helpers.printNoDaemonError)

// ── USAGE listing ─────────────────────────────────────────────────────────────

describe("agentproto sessions --help", () => {
  it("includes 'export' in the usage output", async () => {
    const written: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    const stub = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk))
        return true
      })

    await runSessions(["--help"])

    stub.mockRestore()
    void origWrite
    const allOutput = written.join("")
    expect(allOutput).toContain("export")
  })
})

// ── dispatch ──────────────────────────────────────────────────────────────────

describe("agentproto sessions export — dispatch", () => {
  let stderrChunks: string[]
  let stdoutChunks: string[]
  let stderrSpy: any
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
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("returns exit code 2 and prints usage when no session id is supplied", async () => {
    const code = await runSessions(["export"])
    expect(code).toBe(2)
    const stderr = stderrChunks.join("")
    expect(stderr).toContain("missing session id")
  })

  it("returns exit code 2 when no daemon is found", async () => {
    discoverDaemon.mockResolvedValue({ found: null, stale: [] })
    const code = await runSessions(["export", "sess_001"])
    expect(code).toBe(2)
    expect(printNoDaemonError).toHaveBeenCalled()
  })

  it("prints markdown content to stdout on success", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockResolvedValue({
      sessionId: "sess_001",
      adapter: "claude-code",
      format: "markdown",
      meta: {},
      content: "# My Session\n\nHello!",
    })

    const code = await runSessions(["export", "sess_001"])

    expect(code).toBe(0)
    const stdout = stdoutChunks.join("")
    expect(stdout).toContain("# My Session")
    expect(stdout).toContain("Hello!")
  })

  it("passes --json flag as format=json in the query string", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockResolvedValue({
      sessionId: "sess_002",
      adapter: "hermes",
      format: "json",
      meta: {},
      content: '{"meta":{},"messages":[]}',
    })

    await runSessions(["export", "sess_002", "--json"])

    const calledUrl = (httpGetJson.mock.calls[0] as [string])[0]
    expect(calledUrl).toContain("format=json")
  })

  it("writes output to a file when -o is supplied", async () => {
    writeFileSync.mockClear()
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockResolvedValue({
      sessionId: "sess_003",
      adapter: "claude-code",
      format: "markdown",
      meta: {},
      content: "# Written to file",
    })

    const code = await runSessions(["export", "sess_003", "-o", "/tmp/out.md"])

    expect(code).toBe(0)
    expect(writeFileSync).toHaveBeenCalledWith("/tmp/out.md", "# Written to file", "utf8")
    // Nothing written to stdout
    expect(stdoutChunks.join("")).toBe("")
  })

  it("returns exit code 2 for HTTP 404 (unknown session)", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockRejectedValue(new Error("HTTP 404: session not found"))

    const code = await runSessions(["export", "sess_ghost"])

    expect(code).toBe(2)
    const stderr = stderrChunks.join("")
    expect(stderr).toContain("not found")
  })
})