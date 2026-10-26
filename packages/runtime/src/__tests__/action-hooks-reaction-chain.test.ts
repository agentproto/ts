/**
 * End to end: a tool arm that starts sessions is bounded by the reaction depth
 * cap, and the agent arm self-chain guard still cuts its first hop.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createRoutineRegistrar } from "../routine-registrar.js"
import type { CronScheduler, CronJob } from "../cron-scheduler.js"
import {
  createActionRegistry,
  createReactionReceiptStore,
  createReactionRunner,
  createReactionWiring,
  reactionSpawnStamp,
  sessionFactsOf,
  wireSessionCompletion,
} from "../action-hooks/index.js"

const dirs: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function liveAgentSession(id: string): AgentSessionLike {
  return {
    sessionId: id,
    async prompt() {
      return { stopReason: "end_turn", events: [] }
    },
    async close() {},
  } as unknown as AgentSessionLike
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

function writeRoutine(ws: string, id: string, lines: string[]): void {
  const dir = join(ws, ".routines", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "ROUTINE.md"), `---\n${lines.join("\n")}\n---\n`)
}

function eventRoutine(id: string, target: string[]): string[] {
  return [
    "schema: routine/v1",
    `id: ${id}`,
    "description: test",
    "schedule:",
    "  kind: event",
    "  on: agentproto:session-completed",
    "target:",
    ...target,
  ]
}

function toolTarget(tool: string): string[] {
  return [`  tool: ${tool}`, "  inputs:", "    stage: chain"]
}

function agentTarget(): string[] {
  return ["  agent:", "    adapter: claude-code", "    prompt: say hi"]
}

function setup(routineId: string, target: string[]) {
  const ws = tmp("reaction-chain-")
  const bus = createSessionEventBus()
  const registry = createSessionsRegistry({
    persist: false,
    transcriptDir: tmp("reaction-chain-transcripts-"),
    sessionEvents: bus,
  })
  wireSessionCompletion({ bus, getSession: id => registry.get(id) })

  const store = createReactionReceiptStore({
    filePath: join(tmp("reaction-chain-receipts-"), "receipts.json"),
    debounceMs: 60_000,
    log: () => {},
  })

  let spawnCount = 0
  let valveHit = false
  const dispatchTool = vi.fn(async (_tool: string, inputs: Record<string, unknown>) => {
    if (spawnCount >= 12) {
      valveHit = true
      return { content: [{ text: "valve" }] }
    }
    spawnCount += 1
    const explicitOrigin = typeof inputs.origin === "string" ? inputs.origin : undefined
    const stamp = reactionSpawnStamp(explicitOrigin)
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: ws,
      agentSession: liveAgentSession(`live-${spawnCount}`),
      adapterSlug: "claude-code",
      ...(stamp
        ? {
            origin: stamp.origin,
            meta: stamp.meta,
          }
        : {}),
    })
    registry.closeWithOutcome(desc.id, { verdict: "done", source: "declared" })
    return { content: [{ text: "ok" }] }
  })

  const actionRegistry = createActionRegistry()
  const runner = createReactionRunner({ bus, store, bindings: [], log: () => {} })
  const wiring = createReactionWiring({
    runner,
    builtin: [],
    eventBindings: () => registrar.eventBindings(),
    conversion: {
      registry: actionRegistry,
      dispatchTool,
      getSessionFacts: id => {
        const desc = registry.get(id)
        return desc ? sessionFactsOf(desc) : undefined
      },
      workspaceRoot: ws,
    },
    log: () => {},
  })
  const registrar = createRoutineRegistrar({
    workspace: ws,
    cronScheduler: fakeCron(),
    dispatchTool,
    onReconciled: () => wiring.refresh(),
  })

  const start = async () => {
    writeRoutine(ws, routineId, eventRoutine(routineId, target))
    await registrar.reconcile()
    runner.start()
    const root = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: ws,
      agentSession: liveAgentSession("root"),
      adapterSlug: "claude-code",
    })
    registry.closeWithOutcome(root.id, { verdict: "done", source: "declared" })
  }

  return {
    start,
    store,
    dispatchTool,
    spawnCount: () => spawnCount,
    valveHit: () => valveHit,
    stop: () => {
      runner.stop()
      registry.shutdown()
    },
  }
}

describe("reaction chain", () => {
  it("bounds a tool arm that starts sessions at the reaction depth cap", async () => {
    const harness = setup("chain", toolTarget("spawn-next"))
    try {
      await harness.start()
      await vi.waitFor(
        () => expect(harness.store.rows().some(row => row.status === "dead")).toBe(true),
        { timeout: 10_000 },
      )
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(harness.dispatchTool).toHaveBeenCalledTimes(4)
      expect(harness.spawnCount()).toBe(4)
      expect(harness.valveHit()).toBe(false)

      const rows = harness.store
        .rows()
        .filter(row => row.bindingId === "routine:chain")
        .sort((a, b) => a.reactionDepth - b.reactionDepth)
      expect(rows.map(row => row.reactionDepth)).toEqual([0, 1, 2, 3, 4])
      expect(rows.map(row => row.status)).toEqual(["done", "done", "done", "done", "dead"])
      expect(rows[4]).toMatchObject({ status: "dead", lastError: "recursion_cap" })
      expect(rows[0]?.causedByEventId).toBeUndefined()
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]?.causedByEventId).toBe(rows[i - 1]?.receiptKey)
      }
    } finally {
      harness.stop()
    }
  })

  it("cuts the first hop of an agent arm through the self-chain guard", async () => {
    const harness = setup("agent-chain", agentTarget())
    try {
      await harness.start()
      await vi.waitFor(() => expect(harness.dispatchTool).toHaveBeenCalledTimes(1), {
        timeout: 10_000,
      })
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(harness.dispatchTool).toHaveBeenCalledTimes(1)
      expect(harness.spawnCount()).toBe(1)
      expect(harness.store.rows()).toHaveLength(1)
      expect(harness.valveHit()).toBe(false)
    } finally {
      harness.stop()
    }
  })
})
