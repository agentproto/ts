/**
 * `workflow_status` compact mode on the shape that blew it up in dogfood
 * (maintain run wfrun_da5405c6, 2026-10-07): a spawn circuit breaker skipping
 * every step of every unstarted fan-out item with one ~750-char reason, plus
 * a ~150k-char `branchGcApply` in the run output.
 */
import { describe, expect, it } from "vitest"
import { compactWorkflowRunStatus, COMPACT_OUTPUT_VALUE_MAX_CHARS } from "../orchestration-tools.js"
import type { RoutineStepState } from "../step-run-types.js"
import type { WorkflowRun } from "../workflow-runner.js"

const ITEM_STEPS = ["reviewWorktreeAdd", "reviewOne", "verdictCheck", "nudge", "reviewSettled", "reviewWorktreeRemove"]
const CIRCUIT = `circuit-open: ${"agent step spawn refused (app_boundary_cwd_outside): … ".repeat(14)}`

function dogfoodRun(): WorkflowRun {
  const steps: RoutineStepState[] = [
    { index: 0, label: "branchGcPlan", status: "done", output: { plan: "x".repeat(50_000) } },
    { index: 2, label: "reviewOne[0]", status: "failed", error: "boom" },
  ]
  for (const item of [6, 7, 8]) {
    for (const id of ITEM_STEPS) steps.push({ index: 2, label: `${id}[${item}]`, status: "skipped", skipReason: CIRCUIT })
  }
  steps.push({ index: 3, label: "reviewCleanup", status: "done" })
  steps.push({ index: 4, label: "late[9]", status: "skipped", skipReason: CIRCUIT })
  return {
    runId: "wfrun_x",
    workflowId: "maintain",
    status: "done",
    startedAt: "2026-10-07T15:08:07.065Z",
    stages: [{ index: 0, status: "done", steps }],
    output: { report: "# Repo maintenance", branchGcApply: { entries: "y".repeat(150_000) }, gaps: [] },
  } as unknown as WorkflowRun
}

describe("compactWorkflowRunStatus", () => {
  it("folds consecutive identically-skipped steps into one row and never repeats a long reason", () => {
    const steps = compactWorkflowRunStatus(dogfoodRun()).stages[0]!.steps
    expect(steps.map(s => s.label)).toEqual([
      "branchGcPlan",
      "reviewOne[0]",
      "reviewWorktreeAdd[6] … reviewWorktreeRemove[8]",
      "reviewCleanup",
      "late[9]",
    ])
    const folded = steps[2]!
    expect(folded).toMatchObject({ status: "skipped", collapsedSteps: 18 })
    expect(folded.skipReason).toMatch(/^circuit-open: .*pass full: true\]$/)
    expect(steps[4]!.skipReason).toBe("(same as reviewWorktreeAdd[6])")
    expect(steps[4]!.collapsedSteps).toBeUndefined()
    expect(steps[0]).not.toHaveProperty("output")
  })

  it("caps oversized run.output values, keeps the small ones verbatim", () => {
    const compact = compactWorkflowRunStatus(dogfoodRun())
    const output = compact.output as Record<string, unknown>
    expect(output.report).toBe("# Repo maintenance")
    expect(output.gaps).toEqual([])
    expect(output.branchGcApply).toMatch(/^\[object, \d+ chars — pass full: true\]$/)
    expect(JSON.stringify(compact).length).toBeLessThan(COMPACT_OUTPUT_VALUE_MAX_CHARS)
  })

  it("leaves a run without skips or big output unchanged apart from dropping step outputs", () => {
    const run = {
      runId: "r",
      workflowId: "w",
      status: "done",
      startedAt: "t",
      stages: [{ index: 0, status: "done", steps: [{ index: 0, label: "a", status: "done", output: 1 }] }],
      output: { ok: true },
    } as unknown as WorkflowRun
    const compact = compactWorkflowRunStatus(run)
    expect(compact.stages[0]!.steps).toEqual([{ index: 0, label: "a", status: "done" }])
    expect(compact.output).toEqual({ ok: true })
  })
})
