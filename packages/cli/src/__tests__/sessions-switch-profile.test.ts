/**
 * `agentproto sessions switch-profile --from <profileRef> --to <profileRef>`
 * — move every session that bills against one named auth profile onto
 * another, in one command. Follows the fake-daemon pattern in
 * cron-agent-target.test.ts.
 *
 * The switch goes through the daemon's restart-with-override route
 * (`POST /sessions/:id/restart` with `access.profileRef`), which is the
 * same path the VS Code extension's profile picker uses: the conversation
 * is resumed under a NEW session id, the session's posture is carried
 * forward, and the cron jobs that targeted the old id are re-armed.
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
const httpGetJson = vi.mocked(helpers.httpGetJson)
const httpPostJson = vi.mocked(helpers.httpPostJson)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function agentSession(id: string, profileRef?: string): any {
  return {
    id,
    kind: "agent-cli",
    status: "running",
    model: "claude-opus",
    ...(profileRef
      ? { accessProfile: { profileRef, label: profileRef, endpoint: "anthropic", method: "api-key" } }
      : {}),
  }
}

describe("agentproto sessions switch-profile", () => {
  let stdoutChunks: string[]
  let stderrChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    stdoutChunks = []
    stderrChunks = []
    stdoutSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stdout as any, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk))
        return true
      })
    stderrSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stderr as any, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk))
        return true
      })
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("restarts every session on the from-profile onto the to-profile", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [
        agentSession("sess_a", "old-wallet"),
        agentSession("sess_b", "other-wallet"),
        agentSession("sess_c", "old-wallet"),
      ],
    })
    httpPostJson.mockResolvedValue({ id: "sess_new", resumedFrom: "sess_a" })

    const code = await runSessions(["switch-profile", "--from", "old-wallet", "--to", "new-wallet"])

    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(2)
    expect(httpPostJson.mock.calls[0]![0]).toBe("http://127.0.0.1:18790/sessions/sess_a/restart")
    expect(httpPostJson.mock.calls[0]![1]).toEqual({ access: { profileRef: "new-wallet" } })
    expect(httpPostJson.mock.calls[1]![0]).toBe("http://127.0.0.1:18790/sessions/sess_c/restart")
    expect(stdoutChunks.join("")).toContain("sess_a")
    expect(stdoutChunks.join("")).toContain("sess_c")
  })

  it("leaves sessions on another profile alone", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [agentSession("sess_a", "other-wallet")],
    })

    const code = await runSessions(["switch-profile", "--from", "old-wallet", "--to", "new-wallet"])

    expect(code).toBe(0)
    expect(httpPostJson).not.toHaveBeenCalled()
    expect(stdoutChunks.join("")).toContain("old-wallet")
  })

  it("skips a session that is not an agent session (no billing axis)", async () => {
    httpGetJson.mockResolvedValue({
      sessions: [
        { id: "sess_cmd", kind: "command", status: "running", accessProfile: { profileRef: "old-wallet" } },
        agentSession("sess_a", "old-wallet"),
      ],
    })
    httpPostJson.mockResolvedValue({ id: "sess_new" })

    const code = await runSessions(["switch-profile", "--from", "old-wallet", "--to", "new-wallet"])

    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(1)
    expect(httpPostJson.mock.calls[0]![0]).toBe("http://127.0.0.1:18790/sessions/sess_a/restart")
    expect(stdoutChunks.join("")).toContain("sess_cmd")
  })

  it("reports a failed restart and exits non-zero", async () => {
    httpGetJson.mockResolvedValue({ sessions: [agentSession("sess_a", "old-wallet")] })
    httpPostJson.mockRejectedValue(new Error("HTTP 400: profile not eligible"))

    const code = await runSessions(["switch-profile", "--from", "old-wallet", "--to", "new-wallet"])

    expect(code).toBe(1)
    expect(stderrChunks.join("")).toContain("sess_a")
  })

  it("requires both --from and --to", async () => {
    const code = await runSessions(["switch-profile", "--from", "old-wallet"])
    expect(code).toBe(2)
    expect(httpGetJson).not.toHaveBeenCalled()
    expect(stderrChunks.join("")).toContain("--to")
  })

  it("refuses to switch a profile onto itself", async () => {
    const code = await runSessions(["switch-profile", "--from", "same", "--to", "same"])
    expect(code).toBe(2)
    expect(httpGetJson).not.toHaveBeenCalled()
  })
})
