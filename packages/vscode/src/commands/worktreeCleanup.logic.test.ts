import { describe, expect, it } from "vitest"

import type { WorktreeGcOutcomeView, WorktreeGcPlanEntryView } from "../client/types.js"
import {
  gcOutcomeCounts,
  gcOutcomeSummary,
  gcPlanSummary,
  isWorktreeGcNotConfigured,
  partitionGcPlan,
  worktreeLabel,
} from "./worktreeCleanup.logic.js"

function entry(over: Partial<WorktreeGcPlanEntryView> = {}): WorktreeGcPlanEntryView {
  return {
    path: "/w/repo/feat-x",
    branch: "feat-x",
    head: "abc123",
    class: "reclaim",
    tree: "clean",
    integration: { state: "merged" },
    liveness: { state: "none", sessionCount: 0 },
    ...over,
  }
}

describe("partitionGcPlan", () => {
  it("splits entries by class", () => {
    const plan = [
      entry({ path: "/w/a", class: "reclaim" }),
      entry({ path: "/w/b", class: "salvage" }),
      entry({ path: "/w/c", class: "hold" }),
      entry({ path: "/w/d", class: "reclaim" }),
    ]
    const p = partitionGcPlan(plan)
    expect(p.reclaim.map(e => e.path)).toEqual(["/w/a", "/w/d"])
    expect(p.salvage.map(e => e.path)).toEqual(["/w/b"])
    expect(p.hold.map(e => e.path)).toEqual(["/w/c"])
  })
})

describe("worktreeLabel", () => {
  it("is 'branch — dir'", () => {
    expect(worktreeLabel(entry({ path: "/w/repo/feat-x", branch: "feat-x" }))).toBe("feat-x — feat-x")
  })
  it("falls back to the dir for a detached worktree", () => {
    expect(worktreeLabel(entry({ path: "/w/repo/detached-1", branch: null }))).toBe("detached-1")
  })
  it("tolerates a trailing slash", () => {
    expect(worktreeLabel(entry({ path: "/w/repo/x/", branch: null }))).toBe("x")
  })
})

describe("gcPlanSummary", () => {
  it("reclaim only", () => {
    expect(gcPlanSummary({ reclaim: [entry()], salvage: [], hold: [] })).toBe("1 to reclaim")
  })
  it("adds dirty + held clauses when present", () => {
    expect(
      gcPlanSummary({ reclaim: [entry(), entry()], salvage: [entry()], hold: [entry(), entry()] }),
    ).toBe("2 to reclaim · 1 dirty (kept) · 2 held (open PR / live)")
  })
})

describe("gcOutcomeCounts / gcOutcomeSummary", () => {
  const outcomes: WorktreeGcOutcomeView[] = [
    { path: "/w/a", branch: "a", result: "reclaimed" },
    { path: "/w/b", branch: "b", result: "reclaimed" },
    { path: "/w/c", branch: "c", result: "held" },
    { path: "/w/d", branch: "d", result: "failed", message: "boom" },
  ]
  it("counts by result", () => {
    expect(gcOutcomeCounts(outcomes)).toEqual({ reclaimed: 2, held: 1, failed: 1 })
  })
  it("summarizes most-relevant-first", () => {
    expect(gcOutcomeSummary(outcomes)).toBe("2 reclaimed · 1 held · 1 failed")
  })
  it("empty → 'nothing to do'", () => {
    expect(gcOutcomeSummary([])).toBe("nothing to do")
  })
})

describe("isWorktreeGcNotConfigured", () => {
  it("matches the 501 / not-configured error", () => {
    expect(isWorktreeGcNotConfigured(new Error("POST /worktrees/gc failed: HTTP 501 …"))).toBe(true)
    expect(isWorktreeGcNotConfigured(new Error("worktree_gc_not_configured"))).toBe(true)
  })
  it("does not match an unrelated error", () => {
    expect(isWorktreeGcNotConfigured(new Error("HTTP 500 gc_failed"))).toBe(false)
  })
})
