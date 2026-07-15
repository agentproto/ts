/**
 * Unit tests for `agentproto sessions story` subcommand.
 *
 * Mirrors sessions-export.test.ts's conventions: intercept `discoverDaemon`
 * and `httpGetJson` before they hit the network / filesystem, since `story`
 * reuses the same `/sessions/:id/export?format=json` route and folds the
 * result through `buildStory` (packages/runtime/src/session-story.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"

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

// A transcript that folds into: chapter "Cadrage" with a user step + one
// bash step (mirrors packages/runtime/src/__tests__/session-story.test.ts's
// own folding fixture, so the expected shape is already verified there).
const TRANSCRIPT_CONTENT = JSON.stringify({
  meta: { title: "demo session" },
  messages: [
    { role: "user", text: "Explore le repo stp", ts: 1700000000000 },
    {
      role: "assistant",
      toolCalls: [{ name: "Bash", args: JSON.stringify({ command: "ls -R pricing/" }) }],
      ts: 1700000001000,
    },
    {
      role: "tool",
      toolName: "Bash",
      text: "pricing/\n  summary.ts\n  loader.ts",
      ts: 1700000002000,
    },
  ],
})

// ── USAGE listing ─────────────────────────────────────────────────────────────

describe("agentproto sessions --help", () => {
  it("includes 'story' in the usage output", async () => {
    const written: string[] = []
    const stub = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk))
        return true
      })

    await runSessions(["--help"])

    stub.mockRestore()
    const allOutput = written.join("")
    expect(allOutput).toContain("story")
  })
})

// ── dispatch ──────────────────────────────────────────────────────────────────

describe("agentproto sessions story — dispatch", () => {
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
    const code = await runSessions(["story"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("missing session id")
  })

  it("returns exit code 2 when no daemon is found", async () => {
    discoverDaemon.mockResolvedValue({ found: null, stale: [] })
    const code = await runSessions(["story", "sess_001"])
    expect(code).toBe(2)
    expect(printNoDaemonError).toHaveBeenCalled()
  })

  it("returns exit code 2 for an invalid --source value", async () => {
    const code = await runSessions(["story", "sess_006", "--source", "bogus"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("invalid --source")
    expect(discoverDaemon).not.toHaveBeenCalled()
  })

  it("returns exit code 2 for HTTP 404 (unknown session)", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockRejectedValue(new Error("HTTP 404: session not found"))

    const code = await runSessions(["story", "sess_ghost"])

    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("not found")
  })

  it("requests format=json from the export route", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockResolvedValue({
      sessionId: "sess_001",
      adapter: "claude-code",
      format: "json",
      content: TRANSCRIPT_CONTENT,
    })

    await runSessions(["story", "sess_001"])

    const calledUrl = (httpGetJson.mock.calls[0] as [string])[0]
    expect(calledUrl).toContain("/sessions/sess_001/export")
    expect(calledUrl).toContain("format=json")
  })

  it("passes --source through to the query string", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockResolvedValue({
      sessionId: "sess_004",
      adapter: "daemon",
      format: "json",
      content: TRANSCRIPT_CONTENT,
    })

    await runSessions(["story", "sess_004", "--source", "daemon"])

    const calledUrl = (httpGetJson.mock.calls[0] as [string])[0]
    expect(calledUrl).toContain("source=daemon")
  })

  it("--json emits the folded chapters/steps structure", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockResolvedValue({
      sessionId: "sess_002",
      adapter: "hermes",
      format: "json",
      content: TRANSCRIPT_CONTENT,
    })

    const code = await runSessions(["story", "sess_002", "--json"])

    expect(code).toBe(0)
    const parsed = JSON.parse(stdoutChunks.join(""))
    expect(parsed.sessionId).toBe("sess_002")
    expect(parsed.adapter).toBe("hermes")
    expect(parsed.chapters).toHaveLength(1)
    expect(parsed.chapters[0]).toMatchObject({ title: "Cadrage" })
    expect(parsed.steps).toHaveLength(2)
    expect(parsed.steps[1]).toMatchObject({ kind: "bash", count: 1 })
  })

  it("renders a readable text story without --json", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockResolvedValue({
      sessionId: "sess_003",
      adapter: "claude-code",
      format: "json",
      content: TRANSCRIPT_CONTENT,
    })

    const code = await runSessions(["story", "sess_003", "--no-color"])

    expect(code).toBe(0)
    const stdout = stdoutChunks.join("")
    expect(stdout).toContain("STORY")
    expect(stdout).toContain("sess_003")
    expect(stdout).toContain("Cadrage")
    expect(stdout).toContain("[bash]")
    expect(stdout).toContain("ls -R pricing/")
    // --no-color: no raw ANSI escapes leak into the output
    expect(stdout).not.toContain("\x1b[")
  })

  it("handles an empty transcript without crashing", async () => {
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpGetJson.mockResolvedValue({
      sessionId: "sess_empty",
      adapter: "claude-code",
      format: "json",
      content: JSON.stringify({ meta: {}, messages: [] }),
    })

    const code = await runSessions(["story", "sess_empty", "--no-color"])

    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("empty transcript")
  })
})
