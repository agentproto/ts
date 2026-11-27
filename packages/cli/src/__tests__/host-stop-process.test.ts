/** `agentproto host stop-process`: usage checks and reading the daemon's refusal. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { answerFromHttpError, runHostStopProcess } from "../commands/host-stop-process.js"

const io = vi.hoisted(() => ({ calls: [] as { url: string; body: unknown }[], reply: undefined as unknown, fail: undefined as unknown }))

vi.mock("../commands/_daemon-helpers.js", () => ({
  discoverDaemon: async () => ({ found: { url: "http://daemon.test", token: "t" } }),
  printNoDaemonError: () => undefined,
  httpPostJson: async (url: string, body: unknown) => {
    io.calls.push({ url, body })
    if (io.fail) throw io.fail
    return io.reply
  },
}))

let err = ""
beforeEach(() => {
  io.calls = []
  io.reply = undefined
  io.fail = undefined
  err = ""
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write)
  vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
    err += String(c)
    return true
  }) as typeof process.stderr.write)
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.AGENTPROTO_SESSION_ID
})

describe("agentproto host stop-process", () => {
  it("requires one numeric pid and a reason", async () => {
    expect(await runHostStopProcess([])).toBe(64)
    expect(await runHostStopProcess(["abc", "--reason", "x"])).toBe(64)
    expect(await runHostStopProcess(["123"])).toBe(64)
    expect(await runHostStopProcess(["123", "--reason", "x", "--grace", "99999"])).toBe(64)
    expect(io.calls).toEqual([])
  })

  it("posts the request with the caller session, and exits 0 when stopped", async () => {
    process.env.AGENTPROTO_SESSION_ID = "sess_esc1"
    io.reply = { ok: true, pid: 123, message: "stopped pid 123", notified: true }
    expect(await runHostStopProcess(["123", "--reason", "whole-disk scan", "--grace", "2000"])).toBe(0)
    expect(io.calls[0]).toEqual({
      url: "http://daemon.test/host/processes/123/stop?callerSessionId=sess_esc1",
      body: { reason: "whole-disk scan", graceMs: 2000 },
    })
  })

  it("exits 3 with the daemon's reason when refused", async () => {
    io.fail = new Error(`HTTP 403: ${JSON.stringify({ ok: false, pid: 9, code: "not-in-session", message: "pid 9 does not descend from any live daemon session" })}`)
    expect(await runHostStopProcess(["9", "--reason", "x"])).toBe(3)
    expect(err).toContain("refused (not-in-session)")
  })

  it("answerFromHttpError ignores errors that are not the route's answer", () => {
    expect(answerFromHttpError(new Error("connect ECONNREFUSED"))).toBeUndefined()
    expect(answerFromHttpError(new Error("HTTP 500: oops"))).toBeUndefined()
  })
})
