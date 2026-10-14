/**
 * `agentproto sessions restart` — the TYPED restart failure body.
 *
 * When the daemon's restart surfaces reject with
 * `{error:{code,reason,action?,message}, message}` (box gone, provider
 * missing, rejected override, …), the CLI prints the human `reason` FIRST
 * and the technical detail under it — never the raw JSON blob
 * `formatHttpError` preserves. Anything untyped keeps today's byte-for-byte
 * message, so this is purely additive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { describeRestartFailure, runSessions } from "../commands/sessions.js"

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

const REASON = "The box this session ran in is gone, so the session can't be resumed where it was."
const DETAIL =
  'restartAgentSession: sandbox "sbx_1" expired or is unreachable (provider "e2b") — spawn a fresh session.'

function typedPayload(): string {
  return JSON.stringify({
    error: {
      code: "sandbox_gone",
      reason: REASON,
      message: DETAIL,
      action: { kind: "spawn-on-branch", branch: "wt/some-branch" },
    },
    message: DETAIL,
    sessionId: "sess_old",
  })
}

describe("describeRestartFailure", () => {
  it("prints the reason first, then the indented detail", () => {
    const out = describeRestartFailure(`HTTP 500: ${typedPayload()}`)
    expect(out.split("\n")[0]).toBe(REASON)
    expect(out.split("\n")[1]).toBe(`  ${DETAIL}`)
  })

  it("accepts the payload without an HTTP prefix too", () => {
    expect(describeRestartFailure(typedPayload()).startsWith(REASON)).toBe(true)
  })

  it("leaves every untyped message byte-for-byte unchanged", () => {
    expect(describeRestartFailure(`HTTP 500: {"error":"restart_failed","message":"boom"}`)).toBe(
      `HTTP 500: {"error":"restart_failed","message":"boom"}`,
    )
    expect(describeRestartFailure("not json at all")).toBe("not json at all")
    expect(describeRestartFailure("")).toBe("")
  })

  it("falls back to the payload's top-level message when error.message is absent", () => {
    const payload = JSON.stringify({
      error: { code: "retired", reason: "This session is retired." },
      message: "session is retired",
    })
    expect(describeRestartFailure(`HTTP 409: ${payload}`)).toBe(
      "This session is retired.\n  session is retired",
    )
  })
})

describe("agentproto sessions restart — typed failure output", () => {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    httpPostJson.mockRejectedValue(new Error(`HTTP 500: ${typedPayload()}`))
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.clearAllMocks()
  })

  it("prints the reason on the first line and the detail under it", async () => {
    const code = await runSessions(["restart", "sess_old"])
    expect(code).toBe(1)
    const text = err.join("")
    const lines = text.split("\n").filter(Boolean)
    expect(lines[0]).toBe(`agentproto sessions restart: ${REASON}`)
    expect(lines[1]).toBe(`  ${DETAIL}`)
    // The raw payload never reaches the user.
    expect(text).not.toContain('"sandbox_gone"')
  })

  it("keeps today's output for an untyped failure", async () => {
    httpPostJson.mockRejectedValue(new Error('HTTP 500: {"error":"restart_failed","message":"boom"}'))
    const code = await runSessions(["restart", "sess_old"])
    expect(code).toBe(1)
    expect(err.join("")).toContain(
      'agentproto sessions restart: HTTP 500: {"error":"restart_failed","message":"boom"}',
    )
  })
})
