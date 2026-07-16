/**
 * `agentproto cron add --command ... --timeout-ms <duration>` — validation
 * of the shared duration parser wired into cron.ts. Follows the fake-daemon
 * pattern in policy.test.ts / sessions-wait.test.ts: intercept
 * `discoverDaemon`/`httpPostJson` from _daemon-helpers so no real socket IO
 * happens, then assert on the request body / exit code produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runCron } from "../commands/cron.js"

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

describe("agentproto cron add --timeout-ms", () => {
  let stderrChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stderrChunks = []
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
      .mockImplementation(() => true)
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
    httpPostJson.mockResolvedValue({ id: "job_1", schedule: "* * * * *", recurring: true })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("a bare integer is still milliseconds, unchanged contract, and no sub-1000 guard applies", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--command",
      "echo",
      "--timeout-ms",
      "30",
    ])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as { action: { timeoutMs?: number } }
    expect(body.action.timeoutMs).toBe(30)
  })

  it("an explicit ms suffix is accepted", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--command",
      "echo",
      "--timeout-ms",
      "5000ms",
    ])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as { action: { timeoutMs?: number } }
    expect(body.action.timeoutMs).toBe(5000)
  })

  it("rejects a non-ms suffix instead of silently misparsing it, without touching the daemon", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--command",
      "echo",
      "--timeout-ms",
      "30s",
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("already declares milliseconds")
  })

  it("rejects 0", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--command",
      "echo",
      "--timeout-ms",
      "0",
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("omitting --timeout-ms sends no timeoutMs field", async () => {
    const code = await runCron(["add", "--schedule", "* * * * *", "--command", "echo"])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as { action: { timeoutMs?: number } }
    expect(body.action.timeoutMs).toBeUndefined()
  })
})
