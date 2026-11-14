/**
 * End to end: the real agent `on` scanner over a real AGENT.md, the real
 * routine registrar with its async onReconciled hook, the real reaction wiring
 * and runner, a real session event bus, a real receipt store and the real
 * session registry holding session:archive and a demo:note stub.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { createSessionEventBus } from "../session-event-bus.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionsRegistry,
} from "../sessions.js"
import { createRoutineRegistrar } from "../routine-registrar.js"
import type { CronScheduler, CronJob } from "../cron-scheduler.js"
import {
  createActionRegistry,
  createAgentOnScanner,
  createReactionReceiptStore,
  createReactionRunner,
  createReactionWiring,
  createSessionArchiveAction,
  sessionFactsOf,
  SESSION_ARCHIVE_ACTION_ID,
  wireSessionCompletion,
  type ActionHandler,
  type ReactionReceiptStore,
} from "../action-hooks/index.js"

const EVENT = "agentproto:session-completed"
const NOTE_ACTION_ID = "demo:note"

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

function writeAgent(ws: string, dir: string, id: string, on: string[] = []): void {
  const target = join(ws, ".agents", dir)
  mkdirSync(target, { recursive: true })
  const lines = [
    "---",
    "schema: agent/v1",
    `id: "${id}"`,
    `description: Agent ${id} for testing`,
    "model: test-model",
    ...on,
    "---",
    "",
    `You are agent ${id}.`,
  ]
  writeFileSync(join(target, "AGENT.md"), `${lines.join("\n")}\n`)
}

const archiveOn = ["on:", `  ${EVENT}: session:archive`]

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface Context {
  ws: string
  bus: ReturnType<typeof createSessionEventBus>
  registry: SessionsRegistry
  store: ReactionReceiptStore
  runner: ReturnType<typeof createReactionRunner>
  registrar: ReturnType<typeof createRoutineRegistrar>
  receiptBinding: string
  archiveRows: () => number
  spawn: (agentId?: string) => string
  complete: (sessionId: string) => void
}

function makeContext(): Context {
  const ws = tmp("agent-on-e2e-")
  const bus = createSessionEventBus()
  const registry = createSessionsRegistry({
    persist: false,
    transcriptDir: tmp("agent-on-transcripts-"),
    sessionEvents: bus,
  })
  wireSessionCompletion({ bus, getSession: id => registry.get(id) })
  const noteHandler: ActionHandler = {
    actionId: NOTE_ACTION_ID,
    idempotent: true,
    run: async () => ({ ok: true, outcomeRef: "noted" }),
  }
  const actionRegistry = createActionRegistry([
    createSessionArchiveAction({ sessions: registry, log: () => {} }),
    noteHandler,
  ])
  const dispatchTool = async () => ({ content: [{ text: "ok" }] })
  const store = createReactionReceiptStore({
    filePath: join(tmp("agent-on-receipts-"), "receipts.json"),
    debounceMs: 60_000,
    log: () => {},
  })
  const runner = createReactionRunner({ bus, store, bindings: [], log: () => {} })
  const scanner = createAgentOnScanner({ workspace: ws, log: () => {} })
  let registrar: ReturnType<typeof createRoutineRegistrar>
  const wiring = createReactionWiring({
    runner,
    builtin: [],
    eventBindings: () => registrar?.eventBindings() ?? [],
    agentBindings: () => scanner.current(),
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
  registrar = createRoutineRegistrar({
    workspace: ws,
    cronScheduler: fakeCron(),
    dispatchTool,
    onReconciled: async () => {
      await scanner.rescan()
      return wiring.refresh()
    },
  })
  const receiptBinding = `archiver/on/${EVENT}/0`
  return {
    ws,
    bus,
    registry,
    store,
    runner,
    registrar,
    receiptBinding,
    // Settled receipts only: a pending or running row exists before the handler has run.
    archiveRows: () =>
      store.rows().filter(row => row.bindingId === receiptBinding && row.status === "done").length,
    spawn: agentId => {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: ws,
        agentSession: liveAgentSession(`live-${Math.random()}`),
        adapterSlug: "claude-code",
        ...(agentId ? { meta: { agentId } } : {}),
      })
      return desc.id
    },
    complete: sessionId => {
      registry.closeWithOutcome(sessionId, { verdict: "done", source: "declared" })
    },
  }
}

async function start(ctx: Context): Promise<void> {
  await ctx.registrar.reconcile()
  ctx.runner.start()
}

describe("agent on maps end to end", () => {
  it("archives only the completed session whose meta.agentId is the declaring agent", async () => {
    const ctx = makeContext()
    writeAgent(ctx.ws, "archiver", "archiver", archiveOn)
    await start(ctx)
    const archiveSpy = vi.spyOn(ctx.registry, "archiveSession")
    try {
      const outsider = ctx.spawn()
      ctx.complete(outsider)
      const insider = ctx.spawn("archiver")
      ctx.complete(insider)
      await waitFor(() => ctx.archiveRows() >= 1)
      expect(ctx.registry.get(insider)?.archived).toBe(true)
      expect(ctx.registry.get(outsider)?.archived).not.toBe(true)
      expect(archiveSpy).toHaveBeenCalledTimes(1)
      expect(archiveSpy).toHaveBeenCalledWith(insider)
      expect(ctx.archiveRows()).toBe(1)
    } finally {
      ctx.runner.stop()
      ctx.registry.shutdown()
    }
  })

  it("archives once when the same completion is delivered twice", async () => {
    const ctx = makeContext()
    writeAgent(ctx.ws, "archiver", "archiver", archiveOn)
    await start(ctx)
    const archiveSpy = vi.spyOn(ctx.registry, "archiveSession")
    try {
      const first = ctx.spawn("archiver")
      ctx.complete(first)
      await waitFor(() => ctx.archiveRows() >= 1)
      const row = ctx.store.rows().find(entry => entry.bindingId === ctx.receiptBinding)
      expect(row).toBeDefined()
      const endedAt = ctx.registry.get(first)?.endedAt ?? "2026-01-01T00:00:00.000Z"
      ctx.bus.emit({
        type: EVENT,
        sessionId: first,
        occurrenceId: row?.occurrenceId ?? `exit:${endedAt}`,
        basis: "outcome",
        endedAt,
        ts: "2026-01-01T00:00:00.000Z",
      })
      const control = ctx.spawn("archiver")
      ctx.complete(control)
      await waitFor(() => ctx.archiveRows() >= 2)
      expect(archiveSpy).toHaveBeenCalledTimes(2)
      expect(archiveSpy).toHaveBeenCalledWith(first)
      expect(archiveSpy).toHaveBeenCalledWith(control)
    } finally {
      ctx.runner.stop()
      ctx.registry.shutdown()
    }
  })

  it("stops firing after the on map is removed and reconcile runs", async () => {
    const ctx = makeContext()
    writeAgent(ctx.ws, "archiver", "archiver", archiveOn)
    writeAgent(ctx.ws, "other", "other", archiveOn)
    await start(ctx)
    const archiveSpy = vi.spyOn(ctx.registry, "archiveSession")
    try {
      writeAgent(ctx.ws, "archiver", "archiver")
      await ctx.registrar.reconcile()
      const removed = ctx.spawn("archiver")
      ctx.complete(removed)
      const control = ctx.spawn("other")
      ctx.complete(control)
      await waitFor(() =>
        ctx.store.rows().some(
          row => row.bindingId === `other/on/${EVENT}/0` && row.status === "done",
        ),
      )
      expect(ctx.registry.get(control)?.archived).toBe(true)
      expect(ctx.registry.get(removed)?.archived).not.toBe(true)
      expect(
        ctx.store.rows().some(
          row => row.bindingId === ctx.receiptBinding && row.sessionId === removed,
        ),
      ).toBe(false)
      expect(archiveSpy).toHaveBeenCalledTimes(1)
    } finally {
      ctx.runner.stop()
      ctx.registry.shutdown()
    }
  })

  it("reports an unsupported event under reactions.refused without breaking another agent", async () => {
    const ctx = makeContext()
    writeAgent(ctx.ws, "turned", "turned", ["on:", "  turn-end: session:archive"])
    writeAgent(ctx.ws, "archiver", "archiver", archiveOn)
    await start(ctx)
    try {
      const result = await ctx.registrar.reconcile()
      expect(result.reactions?.refused).toContainEqual({
        bindingId: "turned/on/turn-end/0",
        error:
          "event 'turn-end' is not supported by reaction bindings; only agentproto:session-completed, agentproto:context-compacted are supported",
      })
      expect(result.reactions?.active).toContain(ctx.receiptBinding)
      const insider = ctx.spawn("archiver")
      ctx.complete(insider)
      await waitFor(() => ctx.archiveRows() >= 1)
      expect(ctx.registry.get(insider)?.archived).toBe(true)
    } finally {
      ctx.runner.stop()
      ctx.registry.shutdown()
    }
  })

  it("refuses an on entry naming an unregistered action with the existing error", async () => {
    const ctx = makeContext()
    writeAgent(ctx.ws, "ghost", "ghost", ["on:", `  ${EVENT}: demo:missing`])
    await start(ctx)
    try {
      const result = await ctx.registrar.reconcile()
      expect(result.reactions?.refused).toContainEqual({
        bindingId: `ghost/on/${EVENT}/0`,
        error:
          "action 'demo:missing' is not registered; a binding may not reference an unknown action",
      })
    } finally {
      ctx.runner.stop()
      ctx.registry.shutdown()
    }
  })

  it("does not abort reconcile when onReconciled rejects", async () => {
    const ws = tmp("agent-on-e2e-")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const registrar = createRoutineRegistrar({
      workspace: ws,
      cronScheduler: fakeCron(),
      dispatchTool: async () => ({ content: [{ text: "ok" }] }),
      onReconciled: async () => {
        throw new Error("hook exploded")
      },
    })
    try {
      const result = await registrar.reconcile()
      expect(result.errors).toEqual([])
      expect(result.reactions).toBeUndefined()
      expect(
        warn.mock.calls.some(call => String(call[0]).includes("onReconciled failed: hook exploded")),
      ).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("agent on archive receipts", () => {
  it("uses the archive action id in its receipt", async () => {
    const ctx = makeContext()
    writeAgent(ctx.ws, "archiver", "archiver", archiveOn)
    await start(ctx)
    try {
      const insider = ctx.spawn("archiver")
      ctx.complete(insider)
      await waitFor(() => ctx.archiveRows() >= 1)
      const row = ctx.store.rows().find(entry => entry.bindingId === ctx.receiptBinding)
      expect(row?.actionId).toBe(SESSION_ARCHIVE_ACTION_ID)
      expect(row?.outcomeRef).toBe("archived")
    } finally {
      ctx.runner.stop()
      ctx.registry.shutdown()
    }
  })
})
