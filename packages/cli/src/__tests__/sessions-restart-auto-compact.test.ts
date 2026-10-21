/**
 * `agentproto sessions restart --auto-compact-at-tokens <n>`, the ABSOLUTE
 * context threshold (tokens) at which an idle session is compacted
 * automatically.
 *
 * The flag is carried into the restart body as
 * `contextContinuity.autoCompactAtTokens`, and the session's existing
 * context-continuity policy travels with the restart (a restarted session
 * must not silently lose its threshold).
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

describe("sessions restart --auto-compact-at-tokens", () => {
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
    discoverDaemon.mockResolvedValue({
      found: { url: "http://127.0.0.1:18790", token: "tok" },
      stale: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    httpGetJson.mockResolvedValue({
      id: "sess_old",
      kind: "agent-cli",
      status: "killed",
      startedAt: "2026-01-01T00:00:00Z",
      workspaceSlug: "default",
      adapterSlug: "claude-code",
      command: "claude",
      cwd: process.cwd(),
      pid: 4242,
      contextContinuity: { mode: "auto", autoCompactAtTokens: 150000 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    httpPostJson.mockResolvedValue({
      id: "sess_new",
      kind: "agent-cli",
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
      workspaceSlug: "default",
      adapterSlug: "claude-code",
      command: "claude",
      cwd: process.cwd(),
      pid: 4243,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("carries the threshold into the restart body", async () => {
    const code = await runSessions(["restart", "sess_old", "--auto-compact-at-tokens", "90000"])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as Record<string, unknown>
    const continuity = body.contextContinuity as Record<string, unknown>
    expect(continuity.autoCompactAtTokens).toBe(90000)
    // The rest of the policy travels with the restart.
    expect(continuity.mode).toBe("auto")
  })

  it("keeps the existing threshold when the flag is absent", async () => {
    const code = await runSessions(["restart", "sess_old"])
    expect(code).toBe(0)
    const body = httpPostJson.mock.calls[0]![1] as Record<string, unknown>
    const continuity = body.contextContinuity as Record<string, unknown>
    expect(continuity.autoCompactAtTokens).toBe(150000)
  })

  it("refuses a non-numeric threshold", async () => {
    const code = await runSessions(["restart", "sess_old", "--auto-compact-at-tokens", "abc"])
    expect(code).toBe(2)
    expect(err.join("")).toContain("--auto-compact-at-tokens must be a number")
    expect(httpPostJson).not.toHaveBeenCalled()
  })
})
