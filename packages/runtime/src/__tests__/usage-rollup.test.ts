import { describe, expect, it } from "vitest"
import {
  parseWindow,
  rollupUsage,
  type SessionSnapshots,
  type UsageSnapshotRecord,
} from "../usage-rollup.js"

// A fixed injected clock — no Date.now anywhere. All snapshot timestamps are
// expressed relative to this instant.
const NOW = Date.parse("2026-07-24T12:00:00.000Z")
const HOUR = 3_600_000

/** ISO timestamp `hoursAgo` hours before NOW. */
function ago(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString()
}

function snap(
  ts: string,
  fields: Partial<Omit<UsageSnapshotRecord, "ts" | "source">> & {
    source?: UsageSnapshotRecord["source"]
  } = {},
): UsageSnapshotRecord {
  const { source = "computed", ...rest } = fields
  return { ts, source, ...rest }
}

describe("parseWindow", () => {
  it("parses shorthand units", () => {
    expect(parseWindow("5h")).toEqual({ ms: 5 * HOUR })
    expect(parseWindow("7d")).toEqual({ ms: 7 * 86_400_000 })
    expect(parseWindow("30m")).toEqual({ ms: 30 * 60_000 })
    expect(parseWindow("2w")).toEqual({ ms: 2 * 604_800_000 })
    expect(parseWindow("45s")).toEqual({ ms: 45 * 1_000 })
  })

  it("parses ISO-8601 durations", () => {
    expect(parseWindow("PT5H")).toEqual({ ms: 5 * HOUR })
    expect(parseWindow("P7D")).toEqual({ ms: 7 * 86_400_000 })
    expect(parseWindow("PT30M")).toEqual({ ms: 30 * 60_000 })
    expect(parseWindow("P1DT12H")).toEqual({ ms: 86_400_000 + 12 * HOUR })
    expect(parseWindow("P2W")).toEqual({ ms: 2 * 604_800_000 })
    expect(parseWindow("PT90S")).toEqual({ ms: 90 * 1_000 })
  })

  it("rejects unparseable and non-positive input", () => {
    for (const bad of ["", "  ", "abc", "5", "5x", "h5", "-3h", "0h", "P", "PT", "P0D", "5.5h", "1hh"]) {
      expect(parseWindow(bad)).toHaveProperty("error")
    }
  })
})

describe("rollupUsage", () => {
  it("(a) cumulative snapshots do NOT double-count", () => {
    // Three growing snapshots, all in-window, no pre-window baseline.
    // Window spend must be latest − baseline(0) = 0.06, NOT the sum 0.10.
    const sessions: SessionSnapshots[] = [
      {
        sessionId: "s1",
        profileRef: "p1",
        harness: "claude-code",
        snapshots: [
          snap(ago(3), { costUsd: 0.01, tokensIn: 100, tokensOut: 50, model: "m1" }),
          snap(ago(2), { costUsd: 0.03, tokensIn: 300, tokensOut: 150, model: "m1" }),
          snap(ago(1), { costUsd: 0.06, tokensIn: 600, tokensOut: 300, model: "m1" }),
        ],
      },
    ]
    const r = rollupUsage(sessions, { window: "5h", nowMs: NOW })
    expect(r.total.spentUsd).toBeCloseTo(0.06, 10)
    expect(r.total.tokensIn).toBe(600)
    expect(r.total.tokensOut).toBe(300)
    expect(r.total.unpricedTokens).toBe(0)
    expect(r.sessionsConsidered).toBe(1)
    expect(r.basis).toBe("local-estimate")
    expect(r.window).toBe("5h")
    expect(r.windowMs).toBe(5 * HOUR)
    expect(r.now).toBe(new Date(NOW).toISOString())
    expect(r.windowStart).toBe(new Date(NOW - 5 * HOUR).toISOString())
  })

  it("(b) a pre-window snapshot is the baseline and is not itself counted", () => {
    // Baseline at 6h ago (before the 5h window); two in-window snapshots.
    // Spend = latest(0.10) − baseline(0.04) = 0.06.
    const sessions: SessionSnapshots[] = [
      {
        sessionId: "s1",
        profileRef: "p1",
        harness: "claude-code",
        snapshots: [
          snap(ago(6), { costUsd: 0.04, tokensIn: 400, tokensOut: 200, model: "m1" }),
          snap(ago(3), { costUsd: 0.07, tokensIn: 700, tokensOut: 350, model: "m1" }),
          snap(ago(1), { costUsd: 0.1, tokensIn: 1000, tokensOut: 500, model: "m1" }),
        ],
      },
    ]
    const r = rollupUsage(sessions, { window: "5h", nowMs: NOW })
    expect(r.total.spentUsd).toBeCloseTo(0.06, 10)
    expect(r.total.tokensIn).toBe(600)
    expect(r.total.tokensOut).toBe(300)
    expect(r.sessionsConsidered).toBe(1)
  })

  it("(c) unpriced (no-pricing) session adds 0 dollars and tokens to unpricedTokens", () => {
    const sessions: SessionSnapshots[] = [
      {
        sessionId: "s1",
        profileRef: "p1",
        harness: "gemini",
        snapshots: [
          snap(ago(3), { tokensIn: 100, tokensOut: 50, model: "m-unpriced", source: "no-pricing" }),
          snap(ago(1), { tokensIn: 400, tokensOut: 200, model: "m-unpriced", source: "no-pricing" }),
        ],
      },
    ]
    const r = rollupUsage(sessions, { window: "5h", nowMs: NOW })
    expect(r.total.spentUsd).toBe(0)
    expect(r.total.tokensIn).toBe(0)
    expect(r.total.tokensOut).toBe(0)
    expect(r.total.unpricedTokens).toBe(600) // (400−0)+(200−0)
    expect(r.sessionsConsidered).toBe(1)
    expect(r.byProfile).toEqual([
      { profileRef: "p1", spentUsd: 0, tokensIn: 0, tokensOut: 0, unpricedTokens: 600 },
    ])
  })

  it("(c') source:none also routes tokens to unpricedTokens with 0 dollars", () => {
    const sessions: SessionSnapshots[] = [
      {
        sessionId: "s1",
        snapshots: [snap(ago(1), { tokensIn: 10, tokensOut: 5, source: "none" })],
      },
    ]
    const r = rollupUsage(sessions, { window: "5h", nowMs: NOW })
    expect(r.total.spentUsd).toBe(0)
    expect(r.total.unpricedTokens).toBe(15)
  })

  it("(d) empty window → all-zero buckets, sessionsConsidered:0", () => {
    // The only snapshots are older than the window.
    const sessions: SessionSnapshots[] = [
      {
        sessionId: "s1",
        profileRef: "p1",
        snapshots: [
          snap(ago(20), { costUsd: 0.5, tokensIn: 100, tokensOut: 50, model: "m1" }),
          snap(ago(10), { costUsd: 0.9, tokensIn: 200, tokensOut: 100, model: "m1" }),
        ],
      },
    ]
    const r = rollupUsage(sessions, { window: "5h", nowMs: NOW })
    expect(r.total).toEqual({ spentUsd: 0, tokensIn: 0, tokensOut: 0, unpricedTokens: 0 })
    expect(r.sessionsConsidered).toBe(0)
    expect(r.byProfile).toEqual([])
    expect(r.byModel).toEqual([])
    expect(r.byHarness).toEqual([])
  })

  it("(e) parseWindow errors throw from rollupUsage", () => {
    expect(() => rollupUsage([], { window: "nonsense", nowMs: NOW })).toThrow(/invalid window/)
    expect(() => rollupUsage([], { window: "0h", nowMs: NOW })).toThrow(/invalid window/)
  })

  it("(f) grouping — 2 profiles × 2 models sum correctly; total = Σ of each by* array", () => {
    const sessions: SessionSnapshots[] = [
      {
        sessionId: "s1",
        profileRef: "p1",
        harness: "claude-code",
        snapshots: [snap(ago(1), { costUsd: 0.02, tokensIn: 200, tokensOut: 100, model: "mA" })],
      },
      {
        sessionId: "s2",
        profileRef: "p1",
        harness: "claude-code",
        snapshots: [snap(ago(1), { costUsd: 0.05, tokensIn: 500, tokensOut: 250, model: "mB" })],
      },
      {
        sessionId: "s3",
        profileRef: "p2",
        harness: "codex",
        snapshots: [snap(ago(1), { costUsd: 0.1, tokensIn: 1000, tokensOut: 500, model: "mA" })],
      },
      {
        sessionId: "s4",
        profileRef: "p2",
        harness: "codex",
        snapshots: [snap(ago(1), { costUsd: 0.03, tokensIn: 300, tokensOut: 150, model: "mB" })],
      },
    ]
    const r = rollupUsage(sessions, { window: "5h", nowMs: NOW })

    expect(r.total.spentUsd).toBeCloseTo(0.2, 10)
    expect(r.total.tokensIn).toBe(2000)
    expect(r.total.tokensOut).toBe(1000)
    expect(r.sessionsConsidered).toBe(4)

    // Grouped by profile: p1 = 0.07, p2 = 0.13. Sorted spentUsd desc.
    expect(r.byProfile.map(b => b.profileRef)).toEqual(["p2", "p1"])
    expect(r.byProfile.find(b => b.profileRef === "p1")?.spentUsd).toBeCloseTo(0.07, 10)
    expect(r.byProfile.find(b => b.profileRef === "p2")?.spentUsd).toBeCloseTo(0.13, 10)

    // Grouped by model: mA = 0.12, mB = 0.08.
    expect(r.byModel.find(b => b.model === "mA")?.spentUsd).toBeCloseTo(0.12, 10)
    expect(r.byModel.find(b => b.model === "mB")?.spentUsd).toBeCloseTo(0.08, 10)

    // Grouped by harness: claude-code = 0.07, codex = 0.13.
    expect(r.byHarness.find(b => b.harness === "codex")?.spentUsd).toBeCloseTo(0.13, 10)
    expect(r.byHarness.find(b => b.harness === "claude-code")?.spentUsd).toBeCloseTo(0.07, 10)

    // total == Σ of each by* array (every axis partitions the same buckets).
    const sum = (arr: Array<{ spentUsd: number; tokensIn: number; tokensOut: number; unpricedTokens: number }>) => ({
      spentUsd: arr.reduce((a, b) => a + b.spentUsd, 0),
      tokensIn: arr.reduce((a, b) => a + b.tokensIn, 0),
      tokensOut: arr.reduce((a, b) => a + b.tokensOut, 0),
      unpricedTokens: arr.reduce((a, b) => a + b.unpricedTokens, 0),
    })
    for (const axis of [r.byProfile, r.byModel, r.byHarness]) {
      const s = sum(axis)
      expect(s.spentUsd).toBeCloseTo(r.total.spentUsd, 10)
      expect(s.tokensIn).toBe(r.total.tokensIn)
      expect(s.tokensOut).toBe(r.total.tokensOut)
      expect(s.unpricedTokens).toBe(r.total.unpricedTokens)
    }
  })

  it("(g) negative delta (non-monotonic cumulative anomaly) is clamped to 0", () => {
    // Pre-window baseline (8h ago, outside the 5h window) is HIGHER than the
    // latest in-window snapshot — a corrupt/reset cumulative counter. The
    // negative delta must clamp to 0, never subtract from the total.
    const sessions: SessionSnapshots[] = [
      {
        sessionId: "s1",
        profileRef: "p1",
        harness: "claude-code",
        snapshots: [
          snap(ago(8), { costUsd: 0.5, tokensIn: 5000, tokensOut: 2500, model: "m1" }),
          snap(ago(1), { costUsd: 0.2, tokensIn: 2000, tokensOut: 1000, model: "m1" }),
        ],
      },
    ]
    const r = rollupUsage(sessions, { window: "5h", nowMs: NOW })
    expect(r.total.spentUsd).toBe(0)
    expect(r.total.tokensIn).toBe(0)
    expect(r.total.tokensOut).toBe(0)
    expect(r.sessionsConsidered).toBe(1)
  })

  it("attribution keys default to 'unknown' when absent", () => {
    const sessions: SessionSnapshots[] = [
      {
        sessionId: "s1",
        snapshots: [snap(ago(1), { costUsd: 0.01, tokensIn: 10, tokensOut: 5 })], // no model/profile/harness
      },
    ]
    const r = rollupUsage(sessions, { window: "5h", nowMs: NOW })
    expect(r.byProfile).toEqual([
      { profileRef: "unknown", spentUsd: 0.01, tokensIn: 10, tokensOut: 5, unpricedTokens: 0 },
    ])
    expect(r.byModel[0]?.model).toBe("unknown")
    expect(r.byHarness[0]?.harness).toBe("unknown")
  })

  it("boundary: a snapshot exactly at windowStart is in-window (baseline), inclusive [start, now]", () => {
    // Snapshot exactly at windowStart counts as in-window (>=), so it becomes
    // the baseline-less first in-window point; a later snapshot yields the delta.
    const sessions: SessionSnapshots[] = [
      {
        sessionId: "s1",
        profileRef: "p1",
        snapshots: [
          snap(new Date(NOW - 5 * HOUR).toISOString(), { costUsd: 0.02, tokensIn: 200, tokensOut: 100, model: "m1" }),
          snap(ago(1), { costUsd: 0.05, tokensIn: 500, tokensOut: 250, model: "m1" }),
        ],
      },
    ]
    const r = rollupUsage(sessions, { window: "5h", nowMs: NOW })
    // Both in-window, no pre-window baseline → delta = latest − 0 = 0.05.
    expect(r.total.spentUsd).toBeCloseTo(0.05, 10)
    expect(r.total.tokensIn).toBe(500)
  })
})
