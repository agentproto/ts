import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  recordSpawnAdmission,
  resetSpawnAdmissionCounters,
  spawnAdmissionReport,
} from "../action-hooks/spawn-admission-counters.js"
import type { AdmissionDecision } from "../action-hooks/types.js"

const STAGES = [
  "claim",
  "worktree-policy",
  "worktree-collision-sync",
  "worktree-collision-async",
] as const
const OUTCOMES = ["allow", "deny", "reuse", "defer"] as const
const SOURCES = ["explicit", "implicit", "worktree-cwd"] as const

function zeroStages(): Record<string, Record<string, number>> {
  return Object.fromEntries(STAGES.map(stage => [stage, Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]))]))
}

describe("spawn admission counters", () => {
  beforeEach(() => {
    resetSpawnAdmissionCounters()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("presents every stage and outcome at zero in a fresh report", () => {
    const report = spawnAdmissionReport()
    expect(report.since).toEqual(expect.any(String))
    expect(Number.isNaN(Date.parse(report.since))).toBe(false)
    expect(report.total).toBe(0)
    expect(report.stages).toEqual(zeroStages())
    expect(report.dedupeSources).toEqual({ explicit: 0, implicit: 0, "worktree-cwd": 0 })
    expect(report.codes).toEqual([])
  })

  it("counts allow and logs nothing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    recordSpawnAdmission({ stage: "worktree-policy", decision: { outcome: "allow" } })

    const report = spawnAdmissionReport()
    expect(report.total).toBe(1)
    expect(report.stages["worktree-policy"].allow).toBe(1)
    expect(report.codes).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })

  it("counts reuse by dedupe source and writes exactly one line in the fixed format", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    recordSpawnAdmission({
      stage: "claim",
      decision: { outcome: "reuse", targetId: "session-1", code: "spawn_claim_hit" },
      dedupeSource: "explicit",
    })

    const report = spawnAdmissionReport()
    expect(report.total).toBe(1)
    expect(report.stages.claim.reuse).toBe(1)
    expect(report.dedupeSources.explicit).toBe(1)
    expect(report.dedupeSources.implicit).toBe(0)
    expect(report.dedupeSources["worktree-cwd"]).toBe(0)
    expect(report.codes).toEqual([
      { stage: "claim", outcome: "reuse", code: "spawn_claim_hit", count: 1 },
    ])
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      "[spawn-admission] stage=claim outcome=reuse code=spawn_claim_hit source=explicit",
    )
  })

  it("counts deny and defer by code", () => {
    recordSpawnAdmission({
      stage: "claim",
      decision: { outcome: "deny", code: "agent_spawn_failed", message: "boom" },
    })
    recordSpawnAdmission({
      stage: "claim",
      decision: { outcome: "deny", code: "agent_spawn_failed", message: "boom" },
    })
    recordSpawnAdmission({
      stage: "worktree-policy",
      decision: { outcome: "defer", queueEntryId: "q1", code: "worktree_busy" },
    })

    const report = spawnAdmissionReport()
    expect(report.stages.claim.deny).toBe(2)
    expect(report.stages["worktree-policy"].defer).toBe(1)
    expect(report.codes).toEqual([
      { stage: "claim", outcome: "deny", code: "agent_spawn_failed", count: 2 },
      { stage: "worktree-policy", outcome: "defer", code: "worktree_busy", count: 1 },
    ])
  })

  it("sorts codes by count and cuts the report to 50 rows", () => {
    for (let i = 0; i < 60; i++) {
      recordSpawnAdmission({
        stage: "claim",
        decision: { outcome: "deny", code: `code-${i}`, message: "x" },
      })
    }
    for (let i = 0; i < 5; i++) {
      recordSpawnAdmission({
        stage: "claim",
        decision: { outcome: "deny", code: "hot-code", message: "x" },
      })
    }

    const report = spawnAdmissionReport()
    expect(report.codes).toHaveLength(50)
    expect(report.codes[0]).toEqual({
      stage: "claim",
      outcome: "deny",
      code: "hot-code",
      count: 5,
    })
    const counts = report.codes.map(row => row.count)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })

  it("caps distinct code keys at 100 but still counts every event", () => {
    for (let i = 0; i < 120; i++) {
      recordSpawnAdmission({
        stage: "claim",
        decision: { outcome: "deny", code: `distinct-${i}`, message: "x" },
      })
    }
    recordSpawnAdmission({
      stage: "claim",
      decision: { outcome: "deny", code: "late-code", message: "x" },
    })

    const report = spawnAdmissionReport()
    expect(report.total).toBe(121)
    expect(report.stages.claim.deny).toBe(121)
    expect(report.codes.map(row => row.code)).not.toContain("late-code")
  })

  it("never leaks a target id, label, message or prompt into the line or the report", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const decision = {
      outcome: "deny",
      code: "worktree_disabled",
      message: "SECRET_MESSAGE",
      targetId: "SECRET_TARGET",
      label: "SECRET_LABEL",
      prompt: "SECRET_PROMPT",
    } as unknown as AdmissionDecision
    recordSpawnAdmission({ stage: "worktree-policy", decision })

    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0]?.[0])
    expect(line).toBe("[spawn-admission] stage=worktree-policy outcome=deny code=worktree_disabled")
    const serialized = JSON.stringify(spawnAdmissionReport())
    for (const secret of ["SECRET_TARGET", "SECRET_LABEL", "SECRET_MESSAGE", "SECRET_PROMPT"]) {
      expect(line).not.toContain(secret)
      expect(serialized).not.toContain(secret)
    }
  })

  it("counts a dedupe source only for a reuse decision", () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    recordSpawnAdmission({
      stage: "claim",
      decision: { outcome: "deny", code: "agent_spawn_failed", message: "x" },
      dedupeSource: "explicit",
    })
    expect(spawnAdmissionReport().dedupeSources.explicit).toBe(0)
  })

  it("returns a snapshot: a report taken earlier does not change when more events arrive", () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    recordSpawnAdmission({ stage: "claim", decision: { outcome: "allow" } })
    const before = spawnAdmissionReport()
    recordSpawnAdmission({ stage: "claim", decision: { outcome: "allow" } })
    expect(before.stages.claim.allow).toBe(1)
    expect(before.total).toBe(1)
    expect(spawnAdmissionReport().stages.claim.allow).toBe(2)
  })

  it("reset zeroes everything", () => {
    recordSpawnAdmission({
      stage: "claim",
      decision: { outcome: "reuse", targetId: "session-1", code: "spawn_claim_hit" },
      dedupeSource: "implicit",
    })
    recordSpawnAdmission({
      stage: "worktree-policy",
      decision: { outcome: "deny", code: "worktree_disabled", message: "x" },
    })
    resetSpawnAdmissionCounters()

    const report = spawnAdmissionReport()
    expect(report.total).toBe(0)
    expect(report.stages).toEqual(zeroStages())
    expect(report.dedupeSources).toEqual(Object.fromEntries(SOURCES.map(source => [source, 0])))
    expect(report.codes).toEqual([])
  })
})
