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
