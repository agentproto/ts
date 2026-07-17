/**
 * Unit tests for `agentproto permissions watch` — the poll loop in
 * ../commands/permissions.ts, with `_daemon-helpers.js` mocked (same seam as
 * sessions-wait.test.ts). Rule semantics themselves are pinned separately in
 * permission-rules.test.ts; here we cover flag validation, the POST bodies,
 * the handled-set dedupe, error-streak abort, and deadline expiry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { runPermissions } from "../commands/permissions.js"

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

interface InboxEntry {
  id: string
  sessionId: string
  toolCallId: string
  toolName?: string
  text: string
  options: Array<{ optionId: string; name?: string; kind?: string }>
  requestedAt: string
  sessionLabel?: string
}

const inboxEntry = (over: Partial<InboxEntry> = {}): InboxEntry => ({
  id: "perm_1",
  sessionId: "s-abc",
  toolCallId: "tc_1",
  toolName: "ExitPlanMode",
  text: "Allow ExitPlanMode?",
  options: [{ optionId: "allow_once", kind: "allow_once" }],
  requestedAt: new Date().toISOString(),
  ...over,
})

describe("agentproto permissions watch", () => {
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
    httpPostJson.mockResolvedValue({ ok: true, optionId: "allow_once" })
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  // ── flag validation (exit 2, before any HTTP) ──

  it("no rules → exit 2 and no HTTP traffic; never an implicit approve-everything", async () => {
    const code = await runPermissions(["watch"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("at least one rule is required")
    expect(discoverDaemon).not.toHaveBeenCalled()
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  it("--rules-json combined with --allow-tool → exit 2", async () => {
    const code = await runPermissions([
      "watch",
      "--rules-json",
      '[{"match":{"toolName":"X"},"decision":"approve"}]',
      "--allow-tool",
      "Y",
    ])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("mutually exclusive")
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  it("invalid --rules-json shape → exit 2 with the validator's message", async () => {
    const code = await runPermissions(["watch", "--rules-json", '[{"decision":"approve"}]'])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("match must be an object")
  })

  it("bare sub-1000 --interval is rejected as a units slip → exit 2", async () => {
    const code = await runPermissions(["watch", "--allow-tool", "X", "--interval", "30"])
    expect(code).toBe(2)
    expect(stderrChunks.join("")).toContain("--interval")
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  // ── single pass (--once) ──

  it("--once approves a matching entry with a bare {decision} body and exits 0", async () => {
    httpGetJson.mockResolvedValue({ permissions: [inboxEntry()] })

    const code = await runPermissions(["watch", "--allow-tool", "ExitPlanMode", "--once"])

    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(1)
    const [url, body, token] = httpPostJson.mock.calls[0]!
    expect(url).toContain("/permissions/perm_1")
    expect(body).toEqual({ decision: "approve" }) // no optionId/scope → daemon maps
    expect(token).toBe("tok")
    const out = stdoutChunks.join("")
    expect(out).toContain("approved perm_1")
    expect(out).toContain("rule 1: approve ExitPlanMode")
    expect(out).toContain("1 approved, 0 denied, 0 errors")
  })

  it("--always adds scope:\"always\" to the POST body", async () => {
    httpGetJson.mockResolvedValue({ permissions: [inboxEntry()] })
    await runPermissions(["watch", "--allow-tool", "ExitPlanMode", "--always", "--once"])
    expect(httpPostJson.mock.calls[0]![1]).toEqual({
      decision: "approve",
      scope: "always",
    })
  })

  it("mixed inbox: non-matching and nameless entries stay parked — exactly one POST", async () => {
    httpGetJson.mockResolvedValue({
      permissions: [
        inboxEntry({ id: "perm_match", toolName: "ExitPlanMode" }),
        inboxEntry({ id: "perm_other", toolName: "Bash" }),
        inboxEntry({ id: "perm_nameless", toolName: undefined }),
      ],
    })

    const code = await runPermissions(["watch", "--allow-tool", "Exit*", "--once"])

    expect(code).toBe(0)
    expect(httpPostJson).toHaveBeenCalledTimes(1)
    expect(httpPostJson.mock.calls[0]![0]).toContain("/permissions/perm_match")
  })

  it("--session scopes flag rules: only that session's entries are touched", async () => {
    httpGetJson.mockResolvedValue({
      permissions: [
        inboxEntry({ id: "perm_in", sessionId: "s-abc" }),
        inboxEntry({ id: "perm_out", sessionId: "s-other" }),
      ],
    })

    await runPermissions(["watch", "--session", "s-abc", "--allow-tool", "*", "--once"])

    expect(httpPostJson).toHaveBeenCalledTimes(1)
    expect(httpPostJson.mock.calls[0]![0]).toContain("/permissions/perm_in")
  })

  it("a deny rule POSTs {decision:\"deny\"}", async () => {
    httpGetJson.mockResolvedValue({ permissions: [inboxEntry({ toolName: "Bash" })] })
    httpPostJson.mockResolvedValue({ ok: true, optionId: "reject_once" })

    await runPermissions(["watch", "--deny-tool", "Bash", "--once"])

    expect(httpPostJson.mock.calls[0]![1]).toEqual({ decision: "deny" })
    expect(stdoutChunks.join("")).toContain("denied perm_1")
  })

  it("a raced POST 404 (resolved elsewhere) warns but still exits 0", async () => {
    httpGetJson.mockResolvedValue({ permissions: [inboxEntry()] })
    httpPostJson.mockRejectedValue(new Error("HTTP 404: not_found"))

    const code = await runPermissions(["watch", "--allow-tool", "*", "--once"])

    expect(code).toBe(0)
    expect(stderrChunks.join("")).toContain("already resolved or session gone")
  })

  it("--dry-run never POSTs and reports what it would have done", async () => {
    httpGetJson.mockResolvedValue({ permissions: [inboxEntry()] })

    const code = await runPermissions(["watch", "--allow-tool", "*", "--dry-run", "--once"])

    expect(code).toBe(0)
    expect(httpPostJson).not.toHaveBeenCalled()
    const out = stdoutChunks.join("")
    expect(out).toContain("would have approved perm_1")
    expect(out).toContain("dry-run")
  })

  it("--json emits NDJSON: every line parses, the last is the summary", async () => {
    httpGetJson.mockResolvedValue({ permissions: [inboxEntry()] })

    const code = await runPermissions(["watch", "--allow-tool", "*", "--json", "--once"])

    expect(code).toBe(0)
    const lines = stdoutChunks.join("").trimEnd().split("\n")
    const events = lines.map(l => JSON.parse(l) as { event: string })
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]!.event).toBe("approved")
    expect(events.at(-1)!.event).toBe("summary")
  })

  it("--once with a failing GET exits 1", async () => {
    httpGetJson.mockRejectedValue(new Error("ECONNREFUSED"))
    const code = await runPermissions(["watch", "--allow-tool", "*", "--once"])
    expect(code).toBe(1)
  })

  // ── the loop proper (fake timers) ──

  it("an entry still visible on the next poll is not POSTed twice; a 409 is never retried", async () => {
    vi.useFakeTimers()
    const racy = inboxEntry({ id: "perm_racy" })
    const badOption = inboxEntry({ id: "perm_bad", toolName: "Bash" })
    // Same snapshot twice (POST landed but the snapshot lags), then empty.
    httpGetJson
      .mockResolvedValueOnce({ permissions: [racy, badOption] })
      .mockResolvedValueOnce({ permissions: [racy, badOption] })
      .mockResolvedValue({ permissions: [] })
    httpPostJson.mockImplementation(async (url: string) => {
      if (url.includes("perm_bad")) throw new Error("HTTP 409: no_matching_option")
      return { ok: true, optionId: "allow_once" }
    })

    const run = runPermissions([
      "watch", "--allow-tool", "*", "--deny-tool", "Bash",
      "--interval", "1s", "--timeout", "3500ms",
    ])
    await vi.advanceTimersByTimeAsync(4_000)
    const code = await run

    expect(code).toBe(0)
    // perm_racy approved once, perm_bad attempted once — dedupe held on poll 2.
    expect(httpPostJson).toHaveBeenCalledTimes(2)
    expect(stderrChunks.join("")).toContain("cannot be auto-resolved")
    expect(stdoutChunks.join("")).toContain("(timeout)")
  })

  it("5 consecutive GET failures abort with exit 1, and a success resets the streak", async () => {
    vi.useFakeTimers()
    // 4 failures, one success, then 5 failures → abort on the 10th call.
    let call = 0
    httpGetJson.mockImplementation(async () => {
      call++
      if (call === 5) return { permissions: [] }
      throw new Error("ECONNREFUSED")
    })

    const run = runPermissions(["watch", "--allow-tool", "*", "--interval", "1s"])
    await vi.advanceTimersByTimeAsync(20_000)
    const code = await run

    expect(code).toBe(1)
    expect(httpGetJson).toHaveBeenCalledTimes(10)
    expect(stderrChunks.join("")).toContain("(5/5)")
  })

  it("deadline expiry ends the loop with exit 0 and a timeout summary", async () => {
    vi.useFakeTimers()
    httpGetJson.mockResolvedValue({ permissions: [] })

    const run = runPermissions([
      "watch", "--allow-tool", "*", "--interval", "1s", "--timeout", "2500ms",
    ])
    await vi.advanceTimersByTimeAsync(3_000)
    const code = await run

    expect(code).toBe(0)
    expect(stdoutChunks.join("")).toContain("0 approved, 0 denied, 0 errors")
    expect(stdoutChunks.join("")).toContain("(timeout)")
  })
})
