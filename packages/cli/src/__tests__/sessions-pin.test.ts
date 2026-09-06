/**
 * Unit tests for `agentproto sessions pin`/`unpin` — the CLI parity verbs for
 * the `session_set_pinned` MCP tool / `POST /sessions/:id/pin`.
 *
 * Follows the fake-daemon pattern in sessions-gc.test.ts: intercept
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

describe("agentproto sessions pin / unpin", () => {
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
    httpPostJson.mockResolvedValue({ ok: true, sessionId: "s1", pinned: true })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("POSTs {pinned:true} to /sessions/:id/pin with the bearer token", async () => {
    const code = await runSessions(["pin", "s1"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(1)
    const [url, body, token] = httpPostJson.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ]
    expect(url).toBe("http://127.0.0.1:18790/sessions/s1/pin")
    expect(body).toEqual({ pinned: true })
    expect(token).toBe("tok")
    expect(stdoutChunks.join("")).toContain("s1 pinned")
  })

  it("POSTs {pinned:false} to /sessions/:id/pin for unpin", async () => {
    httpPostJson.mockResolvedValue({ ok: true, sessionId: "s1", pinned: false })
    const code = await runSessions(["unpin", "s1"])
    expect(code).toBe(0)
    const [url, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe("http://127.0.0.1:18790/sessions/s1/pin")
    expect(body).toEqual({ pinned: false })
    expect(stdoutChunks.join("")).toContain("s1 unpinned")
  })

  it("--json prints the raw daemon result", async () => {
    httpPostJson.mockResolvedValue({ ok: true, sessionId: "s1", pinned: true })
    const code = await runSessions(["pin", "s1", "--json"])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdoutChunks.join(""))
    expect(parsed).toEqual({ ok: true, sessionId: "s1", pinned: true })
  })

  it("rejects a missing session id without any network call", async () => {
    const code = await runSessions(["pin"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("missing session id")
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("rejects stray positionals with a usage error and no network call", async () => {
    const code = await runSessions(["pin", "s1", "extra"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("unexpected extra positionals")
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("surfaces a 404 as a clear no-session error", async () => {
    httpPostJson.mockRejectedValue(new Error("HTTP 404 Not Found"))
    const code = await runSessions(["pin", "sess_nope"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain('no session "sess_nope"')
  })
})
