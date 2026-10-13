/**
 * `agentproto sessions migrate` — flag parsing and the HTTP call it makes.
 * Same fake-daemon pattern as sessions-handoff.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions } from "../commands/sessions.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    httpPostJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpPostJson = vi.mocked(helpers.httpPostJson)

describe("agentproto sessions migrate", () => {
  let out: string[]
  let err: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    out = []
    err = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdoutSpy = vi.spyOn(process.stdout as any, "write").mockImplementation((c: unknown) => {
      out.push(String(c))
      return true
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stderrSpy = vi.spyOn(process.stderr as any, "write").mockImplementation((c: unknown) => {
      err.push(String(c))
      return true
    })
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("`migrate --help` prints its own usage", async () => {
    expect(await runSessions(["migrate", "--help"])).toBe(0)
    expect(out.join("")).toContain("agentproto sessions migrate <id-or-name>")
    expect(out.join("")).toContain("--sandbox <provider>")
  })

  it("POSTs /sessions/:id/migrate with the flags as the body and prints the move", async () => {
    httpPostJson.mockResolvedValueOnce({
      migratedFrom: "sess_a",
      migratedTo: "sess_b",
      sandboxProvider: "e2b",
      sandboxId: "box_2",
      branch: "wt/feat",
      restore: { source: "live", snapshot: "abc123" },
      oldSessionKilled: true,
    })
    const code = await runSessions(["migrate", "sess_a", "--sandbox", "e2b", "--model", "m1", "--profile", "work"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sessions/sess_a/migrate",
      { sandbox: "e2b", model: "m1", profile: "work" },
      "tok",
    )
    const text = out.join("")
    expect(text).toContain("sess_a → sess_b")
    expect(text).toContain("wt/feat")
    expect(text).toContain("old box stopped")
  })

  it("sends an empty body by default and --json prints the response", async () => {
    httpPostJson.mockResolvedValueOnce({ migratedFrom: "a", migratedTo: "b" })
    expect(await runSessions(["migrate", "sess_a", "--json"])).toBe(0)
    expect(httpPostJson.mock.calls[0]![1]).toEqual({})
    expect(JSON.parse(out.join(""))).toEqual({ migratedFrom: "a", migratedTo: "b" })
  })

  it("exits 2 without an id, and surfaces the daemon's error code", async () => {
    expect(await runSessions(["migrate"])).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()

    httpPostJson.mockRejectedValueOnce(new Error('HTTP 400: {"error":"not_sandbox_session","message":"nope"}'))
    expect(await runSessions(["migrate", "sess_a"])).toBe(1)
    expect(err.join("")).toContain("not_sandbox_session")
  })

  it("exits 2 for an unknown session", async () => {
    httpPostJson.mockRejectedValueOnce(new Error('HTTP 404: {"error":"no_such_session"}'))
    expect(await runSessions(["migrate", "sess_x"])).toBe(2)
  })
})
