/**
 * `agentproto cron add --target-session agent:<label>` — an AGENT LABEL
 * target instead of a session id. The daemon resolves the label to the live
 * session carrying it at FIRE time, so the job survives the agent being
 * relaunched under a new id. Follows the fake-daemon pattern in
 * cron-timeout.test.ts.
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

describe("agentproto cron add --target-session", () => {
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

  it("a plain session id is sent as sessionId, unchanged", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--target-session",
      "sess_abc123",
      "--prompt",
      "status?",
    ])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as {
      action: { kind: string; sessionId?: string; agent?: string; prompt: string }
    }
    expect(body.action).toEqual({
      kind: "prompt-session",
      sessionId: "sess_abc123",
      prompt: "status?",
    })
  })

  it("an agent:<label> target is sent as an agent label", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--target-session",
      "agent:pm",
      "--prompt",
      "status?",
    ])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as {
      action: { kind: string; sessionId?: string; agent?: string; prompt: string }
    }
    expect(body.action).toEqual({
      kind: "prompt-session",
      agent: "pm",
      prompt: "status?",
    })
  })

  it("rejects an empty agent label without touching the daemon", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--target-session",
      "agent:",
      "--prompt",
      "status?",
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("non-empty label")
  })

  it("still requires a prompt for a label target", async () => {
    const code = await runCron([
      "add",
      "--schedule",
      "* * * * *",
      "--target-session",
      "agent:pm",
    ])
    expect(code).toBe(2)
    expect(httpPostJson).not.toHaveBeenCalled()
  })
})
