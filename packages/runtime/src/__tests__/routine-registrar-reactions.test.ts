/**
 * Routine registrar's onReconciled hook and the event routine skip text.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { createRoutineRegistrar, type ReconcileResult } from "../routine-registrar.js"
import type { CronScheduler, CronJob } from "../cron-scheduler.js"

const dirs: string[] = []
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "routine-reactions-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeRoutine(ws: string, id: string, lines: string[]): void {
  const dir = join(ws, ".routines", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "ROUTINE.md"), `---\n${lines.join("\n")}\n---\n`)
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

function registrar(ws: string, onReconciled?: (result: ReconcileResult) => unknown) {
  return createRoutineRegistrar({
    workspace: ws,
    cronScheduler: fakeCron(),
    dispatchTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...(onReconciled ? { onReconciled: onReconciled as never } : {}),
  })
}

function eventRoutine(ws: string, id: string): void {
  writeRoutine(ws, id, [
    "schema: routine/v1",
    `id: ${id}`,
    "description: test",
    "schedule:",
    "  kind: event",
    "  on: agentproto:session-completed",
    "target:",
    "  tool: notify",
  ])
}

describe("routine registrar reactions hook", () => {
  it("calls the hook last with the built result and attaches its value", async () => {
    const ws = workspace()
    eventRoutine(ws, "event-fire")
    const seen: ReconcileResult[] = []
    const reg = registrar(ws, result => {
      seen.push(result)
      expect(result.eventBindings?.map(binding => binding.bindingId)).toEqual(["routine:event-fire"])
      return { active: ["routine:event-fire"], refused: [] }
    })
    const result = await reg.reconcile()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(result)
    expect(result.reactions).toEqual({ active: ["routine:event-fire"], refused: [] })
  })

  it("a throwing hook does not fail the reconcile and warns", async () => {
    const ws = workspace()
    eventRoutine(ws, "event-fire")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const reg = registrar(ws, () => {
      throw new Error("hook exploded")
    })
    const result = await reg.reconcile()
    expect(result.eventBindings).toHaveLength(1)
    expect(result.reactions).toBeUndefined()
    expect(warn.mock.calls.some(call => String(call[0]).includes("onReconciled failed: hook exploded"))).toBe(true)
    warn.mockRestore()
  })

  it("reports the new skip reason for an event routine", async () => {
    const ws = workspace()
    eventRoutine(ws, "event-fire")
    const result = await registrar(ws).reconcile()
    expect(result.skipped).toEqual([
      {
        id: "event-fire",
        reason: "schedule.kind 'event' resolved to a reaction binding; fired by the reaction runner",
      },
    ])
  })
})
