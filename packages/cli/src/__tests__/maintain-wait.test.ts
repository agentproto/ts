/**
 * `agentproto maintain --wait`'s poll loop: keeps polling the run record
 * until it reaches an end status, then hands that record (with its
 * persisted `output.report`) back to be printed.
 */

import { describe, it, expect, vi } from "vitest"
import { waitForRunEnd, type MaintainRunShape } from "../commands/maintain.js"

describe("waitForRunEnd", () => {
  it("polls through running and returns the finished run with its report", async () => {
    const states: MaintainRunShape[] = [
      { runId: "r", status: "running" },
      { runId: "r", status: "running" },
      { runId: "r", status: "done", output: { report: "# Repo maintenance", gaps: [] } },
    ]
    const fetchRun = vi.fn(async () => states.shift()!)
    const sleep = vi.fn(async () => {})
    const run = await waitForRunEnd(fetchRun, { intervalMs: 7, sleep })
    expect(run.status).toBe("done")
    expect(run.output?.report).toBe("# Repo maintenance")
    expect(fetchRun).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(7)
  })

  it("stops on a failed or parked run instead of polling forever", async () => {
    for (const status of ["failed", "cancelled", "awaiting-approval", "awaiting-input"]) {
      const run = await waitForRunEnd(async () => ({ runId: "r", status }), { sleep: async () => {} })
      expect(run.status).toBe(status)
    }
  })
})
