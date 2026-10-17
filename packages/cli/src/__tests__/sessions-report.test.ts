/**
 * `agentproto sessions report [--since 12h] [--topN 5] [--json]`: the pure
 * text renderer (snapshot-style) and the command wired to a fake daemon
 * (same `_daemon-helpers` mock as sessions-stats.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SessionReport } from "@agentproto/runtime"
import { runSessions } from "../commands/sessions.js"
import { renderSessionReportText } from "../commands/sessions-report.js"

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

const REPORT: SessionReport = {
  since: "12h",
  windowStart: "2026-07-24T00:00:00.000Z",
  now: "2026-07-24T12:00:00.000Z",
  totalSessions: 2,
  byHarness: [{ key: "claude-code", count: 2 }],
  byModel: [{ key: "sonnet", count: 2 }],
  byStatus: [{ key: "exited", count: 1 }, { key: "running", count: 1 }],
  byEndReason: [{ key: "operator-completed", count: 1 }],
  duration: { totalMs: 2 * 3_600_000, averageMs: 3_600_000, sessionCount: 2 },
  cost: {
    subscription: { costUsd: 1.5, tokensIn: 1000, tokensOut: 500, unpricedTokens: 0, sessionCount: 1 },
    apiKey: { costUsd: 0, tokensIn: 0, tokensOut: 0, unpricedTokens: 0, sessionCount: 0 },
    unknown: { costUsd: 0, tokensIn: 0, tokensOut: 0, unpricedTokens: 10, sessionCount: 1 },
    total: { costUsd: 1.5, tokensIn: 1000, tokensOut: 500, unpricedTokens: 10, sessionCount: 2 },
  },
  openedPrs: [
    { sessionId: "sess_a", sessionName: "feature-work", adapter: "github", number: 42, url: "https://github.com/x/y/pull/42", openedAt: "2026-07-24T01:00:00.000Z" },
  ],
  topByCost: [{ id: "sess_a", name: "feature-work", harness: "claude-code", model: "sonnet", status: "exited", costUsd: 1.5, durationMs: 3_600_000 }],
  topByDuration: [{ id: "sess_a", name: "feature-work", harness: "claude-code", model: "sonnet", status: "exited", costUsd: 1.5, durationMs: 3_600_000 }],
  activeSessions: [{ id: "sess_b", name: "live-one", harness: "claude-code", model: "sonnet", status: "running", startedAt: "2026-07-24T11:00:00.000Z" }],
  permanentAgents: [],
}

describe("renderSessionReportText", () => {
  it("renders every section", () => {
    const text = renderSessionReportText(REPORT)
    expect(text).toContain("total sessions: 2")
    expect(text).toContain("claude-code: 2")
    expect(text).toContain("sonnet: 2")
    expect(text).toContain("operator-completed: 1")
    expect(text).toContain("duration: total 2.0h, average 1.0h")
    expect(text).toContain("subscription:")
    expect(text).toContain("$1.5000")
    expect(text).toContain("PRs opened: 1")
    expect(text).toContain("#42 https://github.com/x/y/pull/42")
    expect(text).toContain("top by cost (1):")
    expect(text).toContain("top by duration (1):")
    expect(text).toContain("active sessions (1):")
    expect(text).toContain("permanent agents (0):")
    expect(text).toContain("live-one")
  })
})

describe("agentproto sessions report", () => {
  let out: string[]
  let err: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spies: any[]

  beforeEach(() => {
    out = []
    err = []
    spies = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(process.stdout as any, "write").mockImplementation((c: unknown) => (out.push(String(c)), true)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(process.stderr as any, "write").mockImplementation((c: unknown) => (err.push(String(c)), true)),
    ]
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] })
    httpGetJson.mockResolvedValue(REPORT)
  })

  afterEach(() => {
    for (const s of spies) s.mockRestore()
    vi.restoreAllMocks()
  })

  it("defaults to a 12h window and renders text", async () => {
    const code = await runSessions(["report"])
    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:18790/sessions/report?since=12h")
    expect(out.join("")).toContain("total sessions: 2")
  })

  it("forwards --since and --topN", async () => {
    await runSessions(["report", "--since", "7d", "--topN", "3"])
    expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:18790/sessions/report?since=7d&topN=3")
  })

  it("--json prints the daemon's report verbatim", async () => {
    const code = await runSessions(["report", "--json"])
    expect(code).toBe(0)
    expect(JSON.parse(out.join(""))).toEqual(REPORT)
  })

  it("rejects a non-positive --topN", async () => {
    const code = await runSessions(["report", "--topN", "0"])
    expect(code).toBe(2)
    expect(err.join("")).toMatch(/--topN/)
  })

  it("explains a daemon without the route", async () => {
    httpGetJson.mockRejectedValue(new Error("HTTP 404"))
    const code = await runSessions(["report"])
    expect(code).toBe(1)
    expect(err.join("")).toMatch(/restart/)
  })

  it("reports no-daemon cleanly", async () => {
    discoverDaemon.mockResolvedValue({ found: null, stale: [] })
    const code = await runSessions(["report"])
    expect(code).toBe(2)
  })
})
