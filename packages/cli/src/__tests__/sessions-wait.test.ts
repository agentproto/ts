/**
 * Unit tests for `agentproto sessions wait` argument validation.
 *
 * Regression coverage for a bug flagged in PR review: `--policy`-only
 * invocation (the form shown in the command's own help text) was rejected
 * by a mandatory positional guard before ever reaching the `--policy`
 * branch. See `runWait` in ../commands/sessions.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"

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

describe("agentproto sessions wait — argument validation", () => {
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
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("returns exit 2 with usage when neither a session id nor --policy is given", async () => {
    const code = await runSessions(["wait"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("missing session id or policy id")
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  it("--policy alone (no positional) reaches the policy-wait endpoint, not the missing-id error", async () => {
    httpGetJson.mockResolvedValue({ timedOut: false, status: "done", policyId: "p1", sessionIds: [] })

    const code = await runSessions(["wait", "--policy", "p1"])

    expect(code).toBe(0)
    expect(stderrChunks.join("")).not.toContain("missing session id")
    const calledUrl = (httpGetJson.mock.calls[0] as [string])[0]
    expect(calledUrl).toContain("/policies/p1/wait")
  })

  it("a bare session positional (no --policy) still routes to the session-wait endpoint", async () => {
    httpGetJson.mockResolvedValue({ event: "turn-end", sessionId: "sess_1", status: "running" })

    const code = await runSessions(["wait", "sess_1"])

    expect(code).toBe(0)
    const calledUrl = (httpGetJson.mock.calls[0] as [string])[0]
    expect(calledUrl).toContain("/sessions/sess_1/wait")
  })
})

/**
 * The point of `sessions wait`: block IN THE CLI PROCESS across the
 * daemon's per-call ~55s ceiling, so an orchestrating agent can fire it
 * once (via a background job) instead of re-polling `session_monitor`
 * every 49s. These pin the long-poll loop (cursor advancing across
 * daemon-side timeouts) and the exit codes callers branch on.
 */
describe("agentproto sessions wait — long-poll loop + exit codes", () => {
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stdoutChunks = []
    stderrSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stderr as any, "write")
      .mockImplementation(() => true)
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
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("keeps polling with an advancing cursor across daemon-side timeouts, then exits 0 on a match", async () => {
    // First daemon call hits its own ~55s ceiling with no event → the CLI
    // must re-call with `since=<nextCursor>` rather than replay the window.
    httpGetJson
      .mockResolvedValueOnce({ timedOut: true, nextCursor: 42 })
      .mockResolvedValueOnce({ event: "turn-end", sessionId: "sess_1", status: "running" })

    const code = await runSessions(["wait", "sess_1", "--until", "turn-end"])

    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledTimes(2)
    const firstUrl = (httpGetJson.mock.calls[0] as [string])[0]
    const secondUrl = (httpGetJson.mock.calls[1] as [string])[0]
    expect(firstUrl).not.toContain("since=")
    expect(secondUrl).toContain("since=42")
    expect(secondUrl).toContain("event=turn-end")
  })

  it("exits 1 when the total --timeout budget is exhausted without a match", async () => {
    // Every daemon call reports its own timeout; with a tiny total budget
    // the CLI loop must give up and report the overall timeout as exit 1.
    httpGetJson.mockResolvedValue({ timedOut: true, nextCursor: 1 })

    const code = await runSessions(["wait", "sess_1", "--timeout", "5"])

    expect(code).toBe(1)
    expect(stdoutChunks.join("")).toContain("timed out")
  })

  it("exits 3 when the session is unknown (daemon 404)", async () => {
    httpGetJson.mockRejectedValue(new Error("HTTP 404 Not Found"))

    const code = await runSessions(["wait", "sess_missing"])

    expect(code).toBe(3)
  })

  it("rejects an invalid --until value before touching the daemon (exit 2)", async () => {
    const code = await runSessions(["wait", "sess_1", "--until", "bogus"])

    expect(code).toBe(2)
    expect(httpGetJson).not.toHaveBeenCalled()
  })
})
