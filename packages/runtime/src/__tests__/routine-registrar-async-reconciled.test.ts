import { afterEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { createRoutineRegistrar } from "../routine-registrar.js"
import type { CronScheduler, CronJob } from "../cron-scheduler.js"

const dirs: string[] = []
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "routine-async-reconciled-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeRoutine(ws: string, id: string): void {
  const dir = join(ws, ".routines", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "ROUTINE.md"),
    [
      "---",
      "schema: routine/v1",
      `id: ${id}`,
      "description: test",
      "schedule:",
      "  kind: event",
      "  on: agentproto:session-completed",
      "target:",
      "  tool: notify",
      "---",
    ].join("\n"),
  )
}

function fakeCron(): CronScheduler {
  const jobs = new Map<string, CronJob>()
  let counter = 0
  return {
    async create({ label, schedule, timezone, recurring = true, action }) {
      const id = `fake_cron_${++counter}`
      const job: CronJob = {
        id,
        ...(label ? { label } : {}),
        schedule,
        ...(timezone ? { timezone } : {}),
        recurring,
        action,
        createdAt: new Date().toISOString(),
        active: true,
      }
      jobs.set(id, job)
      return job
    },
    list: () => Array.from(jobs.values()),
    get: id => jobs.get(id),
    rearmSessionTarget: () => [],
    async update(id, patch) {
      const job = jobs.get(id)
      if (!job) throw new Error(`cron job not found: ${id}`)
      Object.assign(job, patch)
      return job
    },
    runs: () => ({ runs: [] }),
    delete(id) {
      if (!jobs.has(id)) throw new Error(`cron job not found: ${id}`)
      jobs.delete(id)
    },
    async run(id) {
      return jobs.get(id)?.lastResult
    },
    shutdown() {},
  }
}

describe("routine registrar async onReconciled", () => {
  it("awaits an async hook result, then swallows a rejecting hook with a warning", async () => {
    const ws = workspace()
    writeRoutine(ws, "event-fire")
    const asyncRegistrar = createRoutineRegistrar({
      workspace: ws,
      cronScheduler: fakeCron(),
      dispatchTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      onReconciled: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        return { active: ["routine:event-fire"], refused: [] }
      },
    })
    const asyncResult = await asyncRegistrar.reconcile()
    expect(asyncResult.reactions).toEqual({ active: ["routine:event-fire"], refused: [] })

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const rejectingRegistrar = createRoutineRegistrar({
      workspace: ws,
      cronScheduler: fakeCron(),
      dispatchTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      onReconciled: async () => {
        throw new Error("hook exploded")
      },
    })
    const rejectingResult = await rejectingRegistrar.reconcile()
    expect(rejectingResult.eventBindings).toHaveLength(1)
    expect(rejectingResult.reactions).toBeUndefined()
    expect(
      warn.mock.calls.some(call => String(call[0]).includes("onReconciled failed: hook exploded")),
    ).toBe(true)
    warn.mockRestore()
  })
})
