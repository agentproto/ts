/**
 * Unit tests for `agentproto sessions prompt` — CLI parity for the daemon's
 * `POST /sessions/:id/prompt` (the route `agent_prompt` (MCP) and the VS
 * Code panel already use to message a running session; this verb was the
 * only way to reach it that previously required a hand-crafted curl call).
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

describe("agentproto sessions prompt", () => {
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
    httpPostJson.mockResolvedValue({ ok: true, id: "sess_abc", queued: true })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("defaults to fire-and-forget + queue, POSTing ?wait=false with queue:true", async () => {
    const code = await runSessions(["prompt", "sess_abc", "--prompt", "go check the PR"])
    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(1)
    const [url, body, token] = httpPostJson.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ]
    expect(url).toBe("http://127.0.0.1:18790/sessions/sess_abc/prompt?wait=false")
    expect(body).toEqual({ prompt: "go check the PR", queue: true })
    expect(token).toBe("tok")
    expect(stdoutChunks.join("")).toContain("sent to sess_abc")
  })

  it("reports the queue position when the daemon says the prompt is pending", async () => {
    httpPostJson.mockResolvedValue({
      ok: true,
      id: "sess_abc",
      queued: true,
      pending: true,
      queueId: "q_123",
      queuePosition: 2,
    })
    const code = await runSessions(["prompt", "sess_abc", "--prompt", "hi"])
    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("queued for sess_abc (position 2)")
  })

  it("--wait drops queue/force and POSTs the blocking route (no query string)", async () => {
    httpPostJson.mockResolvedValue({ ok: true, id: "sess_abc" })
    const code = await runSessions([
      "prompt",
      "sess_abc",
      "--prompt",
      "hi",
      "--wait",
      "--force",
    ])
    expect(code).toBe(0)
    const [url, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe("http://127.0.0.1:18790/sessions/sess_abc/prompt")
    expect(body).toEqual({ prompt: "hi" })
    expect(stdoutChunks.join("")).toContain("sess_abc turn complete")
  })

  it("maps --interrupt to interrupt:true on both the queued and --wait arms", async () => {
    const code = await runSessions([
      "prompt",
      "sess_abc",
      "--prompt",
      "redirect now",
      "--interrupt",
    ])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toEqual({ prompt: "redirect now", queue: true, interrupt: true })
  })

  it("maps --force to force:true alongside queue:true (fire-and-forget only)", async () => {
    const code = await runSessions(["prompt", "sess_abc", "--prompt", "hi", "--force"])
    expect(code).toBe(0)
    const [, body] = httpPostJson.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).toEqual({ prompt: "hi", queue: true, force: true })
  })

  it("--json prints the raw daemon result", async () => {
    httpPostJson.mockResolvedValue({ ok: true, id: "sess_abc", queued: true })
    const code = await runSessions(["prompt", "sess_abc", "--prompt", "hi", "--json"])
    expect(code).toBe(0)
    expect(JSON.parse(stdoutChunks.join(""))).toEqual({
      ok: true,
      id: "sess_abc",
      queued: true,
    })
  })

  it("rejects a missing --prompt without any network call", async () => {
    const code = await runSessions(["prompt", "sess_abc"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("missing session id or --prompt")
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("rejects a missing session id without any network call", async () => {
    const code = await runSessions(["prompt", "--prompt", "hi"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("missing session id or --prompt")
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("rejects stray positionals with a usage error and no network call", async () => {
    const code = await runSessions(["prompt", "sess_abc", "extra", "--prompt", "hi"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("unexpected extra positionals")
    expect(httpPostJson).not.toHaveBeenCalled()
  })

  it("maps a 409 to a clear retry hint", async () => {
    httpPostJson.mockRejectedValue(new Error("HTTP 409: mid-turn"))
    const code = await runSessions(["prompt", "sess_abc", "--prompt", "hi", "--wait"])
    expect(code).toBe(1)
    expect(stderrChunks.join("")).toContain("--interrupt or --wait")
  })

  it("maps a 404 to a not-found message", async () => {
    httpPostJson.mockRejectedValue(new Error("HTTP 404: not found"))
    const code = await runSessions(["prompt", "sess_missing", "--prompt", "hi"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain('no session "sess_missing"')
  })
})
