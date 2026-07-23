/**
 * Unit tests for `agentproto sessions gc` — the CLI parity verb for the
 * `session_gc` MCP tool (which previously had no CLI surface).
 *
 * Follows the fake-daemon pattern in sessions-start.test.ts: intercept
 * `discoverDaemon` and `httpPostJson` from _daemon-helpers so no real socket
 * IO happens, then assert on the POST url/body captured from the mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"

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

describe("agentproto sessions gc", () => {
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
    httpPostJson.mockResolvedValue({ mode: "archived", ids: [], count: 0 })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("POSTs to /sessions/gc with the bearer token and no flags by default", async () => {
    httpPostJson.mockResolvedValue({ mode: "archived", ids: ["a", "b"], count: 2 })
    const code = await runSessions(["gc"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(1)
    const [url, body, token] = httpPostJson.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ]
    expect(url).toBe("http://127.0.0.1:18790/sessions/gc")
    expect(body).toEqual({})
    expect(token).toBe("tok")
    expect(stdoutChunks.join("")).toContain("archived 2 terminal sessions")
  })

  it("maps --older-than-days to olderThanDays (as a number)", async () => {
    const code = await runSessions(["gc", "--older-than-days", "7"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toEqual({ olderThanDays: 7 })
    expect(typeof (body as { olderThanDays: unknown }).olderThanDays).toBe("number")
  })

  it("maps --forget to forget:true", async () => {
    httpPostJson.mockResolvedValue({ mode: "forgotten", ids: ["x"], count: 1 })
    const code = await runSessions(["gc", "--forget"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toEqual({ forget: true })
    // count === 1 → singular, and the mode is surfaced verbatim.
    expect(stdoutChunks.join("")).toContain("forgotten 1 terminal session")
  })

  it("combines --older-than-days and --forget", async () => {
    const code = await runSessions(["gc", "--older-than-days", "30", "--forget"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toEqual({ olderThanDays: 30, forget: true })
  })

  it("--json prints the raw daemon result and still hits the same route", async () => {
    httpPostJson.mockResolvedValue({ mode: "archived", ids: ["a"], count: 1 })
    const code = await runSessions(["gc", "--json"])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdoutChunks.join(""))
    expect(parsed).toEqual({ mode: "archived", ids: ["a"], count: 1 })
  })

  it("rejects a non-positive / non-numeric --older-than-days without any network call", async () => {
    const code = await runSessions(["gc", "--older-than-days", "nope"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("invalid --older-than-days")
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("rejects stray positionals with a usage error and no network call", async () => {
    const code = await runSessions(["gc", "some-session-id"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("unexpected positional")
    expect(httpPostJson).not.toHaveBeenCalled()
  })
})
