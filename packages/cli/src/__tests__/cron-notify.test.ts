/**
 * `agentproto cron add --notify always|onFailure` and `cron list` showing the
 * field. Follows the fake-daemon pattern in cron-timeout.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runCron } from "../commands/cron.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpPostJson: vi.fn(),
    httpGetJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpPostJson = vi.mocked(helpers.httpPostJson)
const httpGetJson = vi.mocked(helpers.httpGetJson)

describe("agentproto cron add --notify", () => {
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
    httpPostJson.mockResolvedValue({ id: "job_1", schedule: "* * * * *", recurring: true })
    httpGetJson.mockResolvedValue({ jobs: [] })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("sends notify onFailure in the create body", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--command",
      "echo",
      "--notify",
      "onFailure",
    ])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as { notify?: string }
    expect(body.notify).toBe("onFailure")
  })

  it("sends an explicit always", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--command",
      "echo",
      "--notify",
      "always",
    ])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as { notify?: string }
    expect(body.notify).toBe("always")
  })

  it("rejects an invalid value without touching the daemon", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--command",
      "echo",
      "--notify",
      "sometimes",
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("--notify must be always or onFailure")
  })

  it("shows notify in cron list, defaulting to always", async () => {
    httpGetJson.mockResolvedValue({
      jobs: [
        { id: "job_1", schedule: "* * * * *", recurring: true, active: true, notify: "onFailure" },
        { id: "job_2", schedule: "0 9 * * *", recurring: true, active: true },
      ],
    })
    const code = await runCron(["list"])
    expect(code).toBe(0)
    const out = stdoutChunks.join("")
    expect(out).toContain("Notify:    onFailure")
    expect(out).toContain("Notify:    always")
  })
})
