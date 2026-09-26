/**
 * Unit tests for `agentproto sessions wait` argument validation.
 *
 * Regression coverage for a bug flagged in PR review: `--policy`-only
 * invocation (the form shown in the command's own help text) was rejected
 * by a mandatory positional guard before ever reaching the `--policy`
 * branch. See `runWait` in ../commands/sessions.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runSessions, resolveWaitDefaultTimeout } from "../commands/sessions.js"

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

describe("resolveWaitDefaultTimeout — default --timeout selection", () => {
  it("defaults to 15m (900000ms) when --until is explicit — a real agent turn runs 5-20m", () => {
    expect(resolveWaitDefaultTimeout(true)).toBe(900_000)
  })

  it("defaults to the original 60s (60000ms) for a bare `sessions wait` (no --until)", () => {
    expect(resolveWaitDefaultTimeout(false)).toBe(60_000)
  })
})

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
    // First call is the pre-flight GET /sessions/:id descriptor read (new —
    // see the idle short-circuit tests below); a `busy: true` descriptor
    // keeps this test on the existing blocking-loop path so it still pins
    // what it always pinned: routing to the /wait endpoint.
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValueOnce({ event: "turn-end", sessionId: "sess_1", status: "running" })

    const code = await runSessions(["wait", "sess_1"])

    expect(code).toBe(0)
    const calledUrl = (httpGetJson.mock.calls[1] as [string])[0]
    expect(calledUrl).toContain("/sessions/sess_1/wait")
  })
})

/**
 * The point of `sessions wait`: block IN THE CLI PROCESS across the
 * daemon's per-call ~55s ceiling, so an orchestrating agent can fire it
 * once (via a background job) instead of re-polling `session_monitor`
 * every 49s. These pin the long-poll loop (cursor advancing across
 * daemon-side timeouts) and the exit codes callers branch on.
 */
describe("agentproto sessions wait — long-poll loop + exit codes", () => {
  let stdoutChunks: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(() => {
    stdoutChunks = []
    stderrSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(process.stderr as any, "write")
      .mockImplementation(() => true)
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

  it("keeps polling with an advancing cursor across daemon-side timeouts, then exits 0 on a match", async () => {
    // First call is the pre-flight descriptor read (`busy: true` keeps this
    // on the blocking-loop path); then the daemon's ~55s ceiling with no
    // event → the CLI must re-call with `since=<nextCursor>` rather than
    // replay the window.
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValueOnce({ timedOut: true, nextCursor: 42 })
      .mockResolvedValueOnce({ event: "turn-end", sessionId: "sess_1", status: "running" })

    const code = await runSessions(["wait", "sess_1", "--until", "turn-end"])

    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledTimes(3)
    const firstUrl = (httpGetJson.mock.calls[1] as [string])[0]
    const secondUrl = (httpGetJson.mock.calls[2] as [string])[0]
    expect(firstUrl).not.toContain("since=")
    expect(secondUrl).toContain("since=42")
    expect(secondUrl).toContain("event=turn-end")
  })

  it("exits 2 when the total --timeout budget is exhausted without a match, suggesting --timeout", async () => {
    // Pre-flight descriptor read reports a turn in flight (`busy: true`) so
    // this stays on the blocking-loop path; every subsequent daemon call
    // reports its own timeout. With a tiny total budget the CLI loop must
    // give up and report the overall timeout as exit 2 — distinct from a
    // hard CLI failure (which stays at 1) — and point the caller at
    // --timeout.
    //
    // "5ms" (not bare "5"): a bare number under 1000 is now rejected as an
    // ambiguous units slip (see ../util/duration.ts) before the daemon is
    // ever touched, which would turn this into a usage-error test instead
    // of a budget-exhaustion test. The explicit suffix keeps the same tiny,
    // fast-failing budget while staying valid input.
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValue({ timedOut: true, nextCursor: 1 })

    const code = await runSessions(["wait", "sess_1", "--timeout", "5ms"])

    expect(code).toBe(2)
    expect(stdoutChunks.join("")).toContain("timed out")
    expect(stdoutChunks.join("")).toContain("--timeout")
  })

  it("states the resolved duration in the timeout message, not just 'timed out'", async () => {
    // The actual incident: --timeout 3000 meant to be 3000 SECONDS timed out
    // in 3 seconds and looked like a broken session, not a units mistake.
    // Echoing the resolved duration back makes a wrong unit obvious the
    // moment it bites. (150ms, not a round "seconds" value, to keep this
    // test fast — the loop's deadline is real wall-clock time.)
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValue({ timedOut: true, nextCursor: 1 })

    const code = await runSessions(["wait", "sess_1", "--timeout", "150ms"])

    expect(code).toBe(2)
    expect(stdoutChunks.join("")).toContain("timed out after 150ms")
  })

  it("rejects a bare --timeout under 1000 as an ambiguous units slip, without touching the daemon", async () => {
    const code = await runSessions(["wait", "sess_1", "--timeout", "30"])

    expect(code).toBe(2)
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  it("exits 3 when the session is unknown (daemon 404)", async () => {
    // Rejects on every call, so this now exercises the pre-flight
    // GET /sessions/:id 404 path rather than the /wait endpoint's — same
    // "no session" outcome either way, which is what this test pins.
    httpGetJson.mockRejectedValue(new Error("HTTP 404 Not Found"))

    const code = await runSessions(["wait", "sess_missing"])

    expect(code).toBe(3)
  })

  it("rejects an invalid --until value before touching the daemon (exit 2)", async () => {
    const code = await runSessions(["wait", "sess_1", "--until", "bogus"])

    expect(code).toBe(2)
    expect(httpGetJson).not.toHaveBeenCalled()
  })
})

/**
 * Fail-loud on a silent no-op turn (bug 2 fix — `monitorSessionWait`
 * dropping `empty`/`reason` everywhere). A caller branching only on
 * exit-code-0-vs-nonzero must not read `empty: true` / `reason: "error"` as
 * success — mirrors the `waitTurnEnd` precedent in
 * sessions-registry-agent-host.ts.
 */
describe("agentproto sessions wait — fails loud on a silent no-op turn", () => {
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
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.resetAllMocks()
  })

  it("exits 4 when the matched turn-end carries `empty: true`", async () => {
    // `busy: true` on the pre-flight descriptor keeps this on the
    // blocking-loop path so the /wait endpoint's empty-turn result is
    // actually what this test reaches.
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValue({
        event: "turn-end",
        sessionId: "sess_1",
        status: "running",
        empty: true,
      })

    const code = await runSessions(["wait", "sess_1", "--until", "turn-end"])

    expect(code).toBe(4)
    expect(stderrChunks.join("")).toContain("empty turn")
  })

  it("exits 4 when the matched turn-end carries `reason: \"error\"`", async () => {
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValue({
        event: "turn-end",
        sessionId: "sess_1",
        status: "running",
        reason: "error",
      })

    const code = await runSessions(["wait", "sess_1", "--until", "turn-end"])

    expect(code).toBe(4)
    expect(stderrChunks.join("")).toContain("reason 'error'")
  })

  it("exits 0 for a productive turn-end (no empty/reason fields)", async () => {
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValue({
        event: "turn-end",
        sessionId: "sess_1",
        status: "running",
      })

    const code = await runSessions(["wait", "sess_1", "--until", "turn-end"])

    expect(code).toBe(0)
  })
})

/**
 * The operator incident this whole module exists for: --timeout 3000
 * (meant as 3000 SECONDS) blocked 3 seconds, said "timed out", and read as
 * a broken session rather than a units mistake — because the resolved
 * budget was never stated until AFTER the fact. These pin the up-front
 * echo (stated before the wait blocks, not just in the timeout message)
 * and the machine-readable form for --json callers.
 */
describe("agentproto sessions wait — up-front budget echo + JSON fields", () => {
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

  it("states the resolved budget, in both forms, on stderr BEFORE the wait resolves", async () => {
    // `busy: true` on the pre-flight descriptor keeps this session on the
    // real blocking-loop path — the case the up-front budget echo is about.
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValue({ event: "turn-end", sessionId: "sess_1", status: "running" })

    const code = await runSessions(["wait", "sess_1", "--timeout", "30s"])

    expect(code).toBe(0)
    expect(stderrChunks.join("")).toContain("waiting up to 30s (30000ms)")
    expect(stderrChunks.join("")).toContain("sess_1")
  })

  it("suppresses the up-front budget line under --json", async () => {
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValue({ event: "turn-end", sessionId: "sess_1", status: "running" })

    const code = await runSessions(["wait", "sess_1", "--timeout", "30s", "--json"])

    expect(code).toBe(0)
    expect(stderrChunks.join("")).not.toContain("waiting up to")
  })

  it("the matched-result JSON carries timeoutMs and timeout alongside the daemon's own fields", async () => {
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValue({ event: "turn-end", sessionId: "sess_1", status: "running" })

    const code = await runSessions(["wait", "sess_1", "--timeout", "30s", "--json"])

    expect(code).toBe(0)
    const parsed = JSON.parse(stdoutChunks.join(""))
    expect(parsed).toMatchObject({
      event: "turn-end",
      sessionId: "sess_1",
      timeoutMs: 30_000,
      timeout: "30s",
    })
  })

  it("the timeout error JSON carries timeoutMs and timeout, not just totalTimeoutMs", async () => {
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValue({ timedOut: true, nextCursor: 1 })

    const code = await runSessions(["wait", "sess_1", "--timeout", "150ms", "--json"])

    expect(code).toBe(2)
    const parsed = JSON.parse(stdoutChunks.join(""))
    expect(parsed).toMatchObject({ timedOut: true, timeoutMs: 150, timeout: "150ms" })
  })
})

/**
 * The bug this whole change fixes: `sessions wait --until turn-end` against
 * a session whose turn already ended (idle — not busy, not awaiting input,
 * nothing queued) used to fall through to the real long-poll (the daemon's
 * already-finished-turn check needs a `since` cursor a fresh CLI process
 * never has), burn the entire --timeout budget, and then report a timeout
 * that lies about why ("...if the task is still running" — it isn't). The
 * CLI now reads the session's descriptor via GET /sessions/:id BEFORE
 * blocking and short-circuits to a distinct, honest exit code (5) instead.
 */
describe("agentproto sessions wait — idle short-circuit (exit 5)", () => {
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

  it("short-circuits to exit 5 for an idle/done session without ever calling the blocking /wait endpoint", async () => {
    httpGetJson.mockResolvedValueOnce({
      id: "sess_1",
      status: "running",
      busy: false,
      awaitingInput: false,
      turnsCompleted: 3,
    })

    const code = await runSessions(["wait", "sess_1", "--until", "turn-end"])

    expect(code).toBe(5)
    expect(httpGetJson).toHaveBeenCalledTimes(1)
    const calledUrl = (httpGetJson.mock.calls[0] as [string])[0]
    expect(calledUrl).not.toContain("/wait")
    expect(calledUrl).toContain("/sessions/sess_1")
  })

  it("does not print the up-front 'waiting up to' budget-echo line — nothing is being waited on", async () => {
    httpGetJson.mockResolvedValueOnce({
      id: "sess_1",
      status: "running",
      busy: false,
      awaitingInput: false,
    })

    const code = await runSessions(["wait", "sess_1", "--until", "any"])

    expect(code).toBe(5)
    expect(stderrChunks.join("")).not.toContain("waiting up to")
  })

  it("does not suggest a longer --timeout — that's the exact lie this exit code fixes", async () => {
    httpGetJson.mockResolvedValueOnce({
      id: "sess_1",
      status: "running",
      busy: false,
      awaitingInput: false,
    })

    const code = await runSessions(["wait", "sess_1", "--until", "awaiting-input"])

    expect(code).toBe(5)
    const out = stdoutChunks.join("")
    expect(out).not.toContain("longer --timeout")
    expect(out).not.toContain("still running")
    expect(out).toContain("idle")
  })

  it("--json reports idle: true with sessionId/status/busy/awaitingInput, not timedOut", async () => {
    httpGetJson.mockResolvedValueOnce({
      id: "sess_1",
      status: "running",
      busy: false,
      awaitingInput: false,
    })

    const code = await runSessions(["wait", "sess_1", "--until", "turn-end", "--json"])

    expect(code).toBe(5)
    const parsed = JSON.parse(stdoutChunks.join(""))
    expect(parsed).toMatchObject({
      idle: true,
      sessionId: "sess_1",
      status: "running",
      busy: false,
      awaitingInput: false,
    })
    expect(parsed.timedOut).toBeUndefined()
  })

  it("exits 3 when the pre-flight descriptor read 404s (unknown session)", async () => {
    httpGetJson.mockRejectedValueOnce(new Error("HTTP 404 Not Found"))

    const code = await runSessions(["wait", "sess_missing", "--until", "turn-end"])

    expect(code).toBe(3)
    expect(stderrChunks.join("")).toContain('no session "sess_missing"')
  })

  it("a session with a turn genuinely in flight (busy: true) still goes through the existing blocking loop", async () => {
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: true })
      .mockResolvedValueOnce({ event: "turn-end", sessionId: "sess_1", status: "running" })

    const code = await runSessions(["wait", "sess_1", "--until", "turn-end"])

    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledTimes(2)
    const waitUrl = (httpGetJson.mock.calls[1] as [string])[0]
    expect(waitUrl).toContain("/sessions/sess_1/wait")
  })

  it("a session that is awaiting input is NOT treated as idle — it falls through and matches immediately", async () => {
    // awaitingInput: true is a real, immediate match (monitorSessionWait's
    // sync check fires without needing `since`) — not idleness. The
    // pre-flight check must let this fall through to the loop rather than
    // short-circuiting to exit 5.
    httpGetJson
      .mockResolvedValueOnce({ id: "sess_1", status: "running", busy: false, awaitingInput: true })
      .mockResolvedValueOnce({
        event: "awaiting-input",
        sessionId: "sess_1",
        status: "running",
        awaitingInput: true,
      })

    const code = await runSessions(["wait", "sess_1", "--until", "awaiting-input"])

    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledTimes(2)
  })

  it("a session with a queued prompt about to run is NOT treated as idle", async () => {
    httpGetJson
      .mockResolvedValueOnce({
        id: "sess_1",
        status: "running",
        busy: false,
        awaitingInput: false,
        queuedPrompts: 1,
      })
      .mockResolvedValueOnce({ event: "turn-end", sessionId: "sess_1", status: "running" })

    const code = await runSessions(["wait", "sess_1", "--until", "turn-end"])

    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledTimes(2)
  })

  it("`--until exited` skips the pre-flight idle check entirely and goes straight to the /wait endpoint", async () => {
    httpGetJson.mockResolvedValueOnce({
      event: "exited",
      sessionId: "sess_1",
      status: "exited",
    })

    const code = await runSessions(["wait", "sess_1", "--until", "exited"])

    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledTimes(1)
    const calledUrl = (httpGetJson.mock.calls[0] as [string])[0]
    expect(calledUrl).toContain("/sessions/sess_1/wait")
  })
})
