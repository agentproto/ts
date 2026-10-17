import { describe, expect, it } from "vitest"
import { buildSessionReport, type SessionReportInput } from "../session-report.js"

// A fixed injected clock — no Date.now anywhere. All timestamps are
// expressed relative to this instant.
const NOW = Date.parse("2026-07-24T12:00:00.000Z")
const HOUR = 3_600_000

function ago(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString()
}

function session(overrides: Partial<SessionReportInput> & { id: string }): SessionReportInput {
  return {
    status: "exited",
    startedAt: ago(1),
    ...overrides,
  }
}

describe("buildSessionReport", () => {
  it("filters to sessions started within the window", () => {
    const sessions: SessionReportInput[] = [
      session({ id: "in", startedAt: ago(2) }),
      session({ id: "out", startedAt: ago(20) }),
    ]
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW })
    expect(r.totalSessions).toBe(1)
    expect(r.windowStart).toBe(new Date(NOW - 5 * HOUR).toISOString())
    expect(r.now).toBe(new Date(NOW).toISOString())
  })

  it("counts by harness, model and status", () => {
    const sessions: SessionReportInput[] = [
      session({ id: "a", harness: "claude-code", model: "sonnet", status: "exited" }),
      session({ id: "b", harness: "claude-code", model: "opus", status: "exited" }),
      session({ id: "c", harness: "codex", model: "opus", status: "running", alive: true }),
    ]
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW })
    expect(r.byHarness).toEqual([
      { key: "claude-code", count: 2 },
      { key: "codex", count: 1 },
    ])
    expect(r.byModel).toEqual([
      { key: "opus", count: 2 },
      { key: "sonnet", count: 1 },
    ])
    expect(r.byStatus).toEqual([
      { key: "exited", count: 2 },
      { key: "running", count: 1 },
    ])
  })

  it("buckets end reasons for terminal sessions only, skipping alive ones", () => {
    const sessions: SessionReportInput[] = [
      session({ id: "a", status: "exited", endedReason: "operator-completed" }),
      session({ id: "b", status: "killed", endedReason: "operator-stopped" }),
      session({ id: "c", status: "error", endedReason: "crashed" }),
      session({ id: "d", status: "killed", endedReason: "restarted" }),
      session({ id: "e", status: "exited", endedReason: "idle-reaped" }),
      session({ id: "f", status: "exited" }), // no endedReason -> "unknown"
      session({ id: "g", status: "running", alive: true }), // alive -> excluded
    ]
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW })
    const byKey = new Map(r.byEndReason.map(e => [e.key, e.count]))
    expect(byKey.get("operator-completed")).toBe(1)
    expect(byKey.get("operator-stopped")).toBe(1)
    expect(byKey.get("crashed")).toBe(1)
    expect(byKey.get("restarted")).toBe(1)
    expect(byKey.get("idle-reaped")).toBe(1)
    expect(byKey.get("unknown")).toBe(1)
    expect(byKey.has("running")).toBe(false)
    expect(r.byEndReason.reduce((n, e) => n + e.count, 0)).toBe(6)
  })

  it("computes total/average wall-clock duration, counting a still-running session's elapsed-so-far", () => {
    const sessions: SessionReportInput[] = [
      session({ id: "a", startedAt: ago(2), endedAt: ago(1) }), // 1h
      session({ id: "b", startedAt: ago(1), status: "running", alive: true }), // 1h (to now)
    ]
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW })
    expect(r.duration.sessionCount).toBe(2)
    expect(r.duration.totalMs).toBe(2 * HOUR)
    expect(r.duration.averageMs).toBe(HOUR)
  })

  it("buckets cost by auth mode, keeping unpriced tokens separate from costUsd", () => {
    const sessions: SessionReportInput[] = [
      session({ id: "a", authMode: "subscription", costUsd: 1, tokensIn: 100, tokensOut: 50 }),
      session({ id: "b", authMode: "api-key", costUsd: 2, tokensIn: 200, tokensOut: 100 }),
      session({ id: "c", tokensIn: 10, tokensOut: 5 }), // unknown auth, no costUsd -> unpriced
    ]
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW })
    expect(r.cost.subscription).toEqual({ costUsd: 1, tokensIn: 100, tokensOut: 50, unpricedTokens: 0, sessionCount: 1 })
    expect(r.cost.apiKey).toEqual({ costUsd: 2, tokensIn: 200, tokensOut: 100, unpricedTokens: 0, sessionCount: 1 })
    expect(r.cost.unknown).toEqual({ costUsd: 0, tokensIn: 0, tokensOut: 0, unpricedTokens: 15, sessionCount: 1 })
    expect(r.cost.total).toEqual({ costUsd: 3, tokensIn: 300, tokensOut: 150, unpricedTokens: 15, sessionCount: 3 })
  })

  it("counts costUsd even with no usageSource echo (cold sidecar-derived sessions never carry one)", () => {
    const sessions: SessionReportInput[] = [session({ id: "cold", costUsd: 5.5 })]
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW })
    expect(r.cost.total.costUsd).toBe(5.5)
    expect(r.cost.total.unpricedTokens).toBe(0)
  })

  it("lists PRs opened by in-window sessions", () => {
    const sessions: SessionReportInput[] = [
      session({
        id: "a",
        name: "pr-session",
        openedPrs: [{ adapter: "github", number: 42, url: "https://github.com/x/y/pull/42", openedAt: ago(1) }],
      }),
      session({ id: "b", startedAt: ago(20) /* out of window */, openedPrs: [{ adapter: "github", number: 1, url: "u", openedAt: ago(20) }] }),
    ]
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW })
    expect(r.openedPrs).toEqual([
      { sessionId: "a", sessionName: "pr-session", adapter: "github", number: 42, url: "https://github.com/x/y/pull/42", openedAt: ago(1) },
    ])
  })

  it("ranks topByCost and topByDuration, respecting topN", () => {
    const sessions: SessionReportInput[] = [
      session({ id: "cheap-long", startedAt: ago(4), endedAt: ago(1), costUsd: 0.5 }), // 3h
      session({ id: "expensive-short", startedAt: ago(1.5), endedAt: ago(1), costUsd: 9 }), // 0.5h
      session({ id: "mid", startedAt: ago(3), endedAt: ago(2), costUsd: 2 }), // 1h
    ]
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW, topN: 2 })
    expect(r.topByCost.map(s => s.id)).toEqual(["expensive-short", "mid"])
    expect(r.topByDuration.map(s => s.id)).toEqual(["cheap-long", "mid"])
  })

  it("reports active sessions and permanent agents regardless of the window", () => {
    const sessions: SessionReportInput[] = [
      session({ id: "old-permanent", startedAt: ago(1000), status: "running", alive: true, keepAlive: true }),
      session({ id: "recent-active", startedAt: ago(1), status: "running", alive: true }),
      session({ id: "ended", startedAt: ago(1), status: "exited", alive: false }),
    ]
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW })
    // "old-permanent" started 1000h ago, outside the 5h window, but
    // activeSessions/permanentAgents are NOT window-filtered.
    expect(r.totalSessions).toBe(2)
    expect(r.activeSessions.map(s => s.id).sort()).toEqual(["old-permanent", "recent-active"])
    expect(r.permanentAgents.map(s => s.id)).toEqual(["old-permanent"])
  })

  it("defaults topN to 5", () => {
    const sessions: SessionReportInput[] = Array.from({ length: 8 }, (_, i) =>
      session({ id: `s${i}`, costUsd: i }),
    )
    const r = buildSessionReport(sessions, { since: "5h", nowMs: NOW })
    expect(r.topByCost).toHaveLength(5)
  })
})
