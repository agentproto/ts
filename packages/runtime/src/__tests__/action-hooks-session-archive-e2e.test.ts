/**
 * End to end: real routine registrar, real reaction wiring, real action
 * registry, real session registry, real bus, real receipt store and runner.
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
  createReactionReceiptStore,
  createReactionRunner,
  createReactionWiring,
  createSessionArchiveAction,
  sessionFactsOf,
  SESSION_ARCHIVE_ACTION_ID,
  wireSessionCompletion,
  type ActionRegistry,
  type ReactionReceiptStore,
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

const ROUTINE_ID = "archive-finished-children"

const ROUTINE_LINES = [
  "schema: routine/v1",
  `id: ${ROUTINE_ID}`,
  "description: Archive a child agent session once it has completed.",
  "schedule:",
  "  kind: event",
  "  on: agentproto:session-completed",
  "  filter:",
  "    session.isChild: true",
  "target:",
  "  action: session:archive",
]

function writeRoutine(ws: string, lines: string[]): void {
  const dir = join(ws, ".routines", ROUTINE_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "ROUTINE.md"), `---\n${lines.join("\n")}\n---\n`)
}

function spawn(registry: SessionsRegistry, parentSessionId?: string) {
  return registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: liveAgentSession(`live-${Math.random()}`),
    adapterSlug: "claude-code",
    ...(parentSessionId ? { parentSessionId } : {}),
  })
}

function spawnParentAndChild(registry: SessionsRegistry) {
  const parent = spawn(registry)
  const child = spawn(registry, parent.id)
  return { parent, child }
}

function makeContext() {
  const ws = tmp("session-archive-e2e-")
  const bus = createSessionEventBus()
  const registry = createSessionsRegistry({
    persist: false,
    transcriptDir: tmp("session-archive-transcripts-"),
    sessionEvents: bus,
  })
  wireSessionCompletion({ bus, getSession: id => registry.get(id) })
  const actionRegistry: ActionRegistry = createActionRegistry([
    createSessionArchiveAction({ sessions: registry, log: () => {} }),
  ])
  const dispatchTool = async () => ({ content: [{ text: "ok" }] })
  let onReconciled: () => void = () => {}
  const registrar = createRoutineRegistrar({
    workspace: ws,
    cronScheduler: fakeCron(),
    dispatchTool,
    onReconciled: () => onReconciled(),
  })
  const openRunner = (store: ReactionReceiptStore) => {
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
    onReconciled = () => {
      wiring.refresh()
    }
    return { runner, wiring }
  }
  return { ws, bus, registry, actionRegistry, registrar, openRunner }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function receiptInput(sessionId: string, occurrenceId: string) {
  return {
    sessionId,
    event: "agentproto:session-completed",
    occurrenceId,
    bindingId: `routine:${ROUTINE_ID}`,
    actionId: SESSION_ARCHIVE_ACTION_ID,
    configRevision: "test",
    maxAttempts: 3,
    reactionDepth: 0,
  }
}

describe("session:archive event routine end to end", () => {
  it("archives a completed child exactly once and fires one retirement", async () => {
    const ctx = makeContext()
    const store = createReactionReceiptStore({
      filePath: join(tmp("session-archive-receipts-"), "receipts.json"),
      debounceMs: 60_000,
      log: () => {},
    })
    writeRoutine(ctx.ws, ROUTINE_LINES)
    const { runner } = ctx.openRunner(store)
    const archiveSpy = vi.spyOn(ctx.registry, "archiveSession")
    await ctx.registrar.reconcile()
    runner.start()
    try {
      const { child } = spawnParentAndChild(ctx.registry)
      ctx.registry.closeWithOutcome(child.id, { verdict: "done", source: "declared" })
      const retired = vi.fn()
      ctx.registry.onSessionRetired(retired)
      await waitFor(() =>
        store.rows().some(row => row.bindingId === `routine:${ROUTINE_ID}` && row.status === "done"),
      )
      const rows = store.rows().filter(row => row.bindingId === `routine:${ROUTINE_ID}`)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.outcomeRef).toBe("archived")
      expect(ctx.registry.get(child.id)?.archived).toBe(true)
      expect(archiveSpy).toHaveBeenCalledTimes(1)
      expect(retired).toHaveBeenCalledTimes(1)
      expect(retired.mock.calls[0]?.[0]).toMatchObject({ sessionId: child.id, cause: "archived" })
    } finally {
      runner.stop()
      ctx.registry.shutdown()
    }
  })

  it("delivering the same completion twice keeps one archive and one retirement", async () => {
    const ctx = makeContext()
    const store = createReactionReceiptStore({
      filePath: join(tmp("session-archive-receipts-"), "receipts.json"),
      debounceMs: 60_000,
      log: () => {},
    })
    writeRoutine(ctx.ws, ROUTINE_LINES)
    const { runner } = ctx.openRunner(store)
    const archiveSpy = vi.spyOn(ctx.registry, "archiveSession")
    await ctx.registrar.reconcile()
    runner.start()
    try {
      const { child } = spawnParentAndChild(ctx.registry)
      ctx.registry.closeWithOutcome(child.id, { verdict: "done", source: "declared" })
      const retired = vi.fn()
      ctx.registry.onSessionRetired(retired)
      await waitFor(() =>
        store.rows().some(row => row.bindingId === `routine:${ROUTINE_ID}` && row.status === "done"),
      )
      const row = store.rows().find(entry => entry.bindingId === `routine:${ROUTINE_ID}`)
      expect(row).toBeDefined()
      const endedAt = ctx.registry.get(child.id)?.endedAt ?? "2026-01-01T00:00:00.000Z"
      ctx.bus.emit({
        type: "agentproto:session-completed",
        sessionId: child.id,
        occurrenceId: row?.occurrenceId ?? `exit:${endedAt}`,
        basis: "outcome",
        endedAt,
        ts: "2026-01-01T00:00:00.000Z",
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(archiveSpy).toHaveBeenCalledTimes(1)
      expect(retired).toHaveBeenCalledTimes(1)
      expect(store.rows().filter(entry => entry.bindingId === `routine:${ROUTINE_ID}`)).toHaveLength(1)
    } finally {
      runner.stop()
      ctx.registry.shutdown()
    }
  })

  it("does not archive a completed non-child session and writes no receipt", async () => {
    const ctx = makeContext()
    const store = createReactionReceiptStore({
      filePath: join(tmp("session-archive-receipts-"), "receipts.json"),
      debounceMs: 60_000,
      log: () => {},
    })
    writeRoutine(ctx.ws, ROUTINE_LINES)
    const { runner } = ctx.openRunner(store)
    const archiveSpy = vi.spyOn(ctx.registry, "archiveSession")
    await ctx.registrar.reconcile()
    runner.start()
    try {
      const root = spawn(ctx.registry)
      ctx.registry.closeWithOutcome(root.id, { verdict: "done", source: "declared" })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(ctx.registry.get(root.id)?.archived).not.toBe(true)
      expect(archiveSpy).not.toHaveBeenCalled()
      expect(store.rows()).toHaveLength(0)
    } finally {
      runner.stop()
      ctx.registry.shutdown()
    }
  })

  it("skips a pinned completed child with a done receipt", async () => {
    const ctx = makeContext()
    const store = createReactionReceiptStore({
      filePath: join(tmp("session-archive-receipts-"), "receipts.json"),
      debounceMs: 60_000,
      log: () => {},
    })
    writeRoutine(ctx.ws, ROUTINE_LINES)
    const { runner } = ctx.openRunner(store)
    const archiveSpy = vi.spyOn(ctx.registry, "archiveSession")
    await ctx.registrar.reconcile()
    runner.start()
    try {
      const { child } = spawnParentAndChild(ctx.registry)
      ctx.registry.setPinned(child.id, true)
      ctx.registry.closeWithOutcome(child.id, { verdict: "done", source: "declared" })
      await waitFor(() =>
        store.rows().some(row => row.bindingId === `routine:${ROUTINE_ID}` && row.status === "done"),
      )
      const row = store.rows().find(entry => entry.bindingId === `routine:${ROUTINE_ID}`)
      expect(row?.outcomeRef).toBe("skipped:pinned")
      expect(ctx.registry.get(child.id)?.archived).not.toBe(true)
      expect(archiveSpy).not.toHaveBeenCalled()
    } finally {
      runner.stop()
      ctx.registry.shutdown()
    }
  })

  it("boot replay after the archive happened finishes the receipt without a second archive", async () => {
    const ctx = makeContext()
    const receiptPath = join(tmp("session-archive-receipts-"), "receipts.json")
    const store1 = createReactionReceiptStore({ filePath: receiptPath, log: () => {} })
    writeRoutine(ctx.ws, ROUTINE_LINES)
    ctx.openRunner(store1)
    await ctx.registrar.reconcile()
    try {
      const { child } = spawnParentAndChild(ctx.registry)
      ctx.registry.closeWithOutcome(child.id, { verdict: "done", source: "declared" })
      const retired = vi.fn()
      ctx.registry.onSessionRetired(retired)
      ctx.registry.archiveSession(child.id)
      expect(retired).toHaveBeenCalledTimes(1)

      const pending = await store1.insertPending(
        receiptInput(child.id, `exit:${ctx.registry.get(child.id)?.endedAt}`),
      )
      await store1.markRunning(pending.receiptKey)
      store1.flushSync()

      const store2 = createReactionReceiptStore({ filePath: receiptPath, log: () => {} })
      const { runner: runner2 } = ctx.openRunner(store2)
      await ctx.registrar.reconcile()
      await runner2.reconcileOnBoot()

      const row = store2.get(pending.receiptKey)
      expect(row?.status).toBe("done")
      expect(row?.outcomeRef).toBe("skipped:already_archived")
      expect(retired).toHaveBeenCalledTimes(1)
    } finally {
      ctx.registry.shutdown()
    }
  })

  it("boot replay before the archive happened archives once on replay", async () => {
    const ctx = makeContext()
    const receiptPath = join(tmp("session-archive-receipts-"), "receipts.json")
    const store1 = createReactionReceiptStore({ filePath: receiptPath, log: () => {} })
    writeRoutine(ctx.ws, ROUTINE_LINES)
    ctx.openRunner(store1)
    await ctx.registrar.reconcile()
    try {
      const { child } = spawnParentAndChild(ctx.registry)
      ctx.registry.closeWithOutcome(child.id, { verdict: "done", source: "declared" })
      const retired = vi.fn()
      ctx.registry.onSessionRetired(retired)

      const pending = await store1.insertPending(
        receiptInput(child.id, `exit:${ctx.registry.get(child.id)?.endedAt}`),
      )
      await store1.markRunning(pending.receiptKey)
      store1.flushSync()

      const store2 = createReactionReceiptStore({ filePath: receiptPath, log: () => {} })
      const { runner: runner2 } = ctx.openRunner(store2)
      await ctx.registrar.reconcile()
      await runner2.reconcileOnBoot()

      const row = store2.get(pending.receiptKey)
      expect(row?.status).toBe("done")
      expect(row?.outcomeRef).toBe("archived")
      expect(ctx.registry.get(child.id)?.archived).toBe(true)
      expect(retired).toHaveBeenCalledTimes(1)
    } finally {
      ctx.registry.shutdown()
    }
  })

  it("disabling the routine removes the binding so the child is not archived", async () => {
    const ctx = makeContext()
    const store = createReactionReceiptStore({
      filePath: join(tmp("session-archive-receipts-"), "receipts.json"),
      debounceMs: 60_000,
      log: () => {},
    })
    writeRoutine(ctx.ws, ROUTINE_LINES)
    const { runner, wiring } = ctx.openRunner(store)
    await ctx.registrar.reconcile()
    expect(wiring.current().active).toContain(`routine:${ROUTINE_ID}`)
    runner.start()
    try {
      writeRoutine(ctx.ws, [...ROUTINE_LINES, "enabled: false"])
      await ctx.registrar.reconcile()
      expect(wiring.current().active).not.toContain(`routine:${ROUTINE_ID}`)
      const { child } = spawnParentAndChild(ctx.registry)
      ctx.registry.closeWithOutcome(child.id, { verdict: "done", source: "declared" })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(ctx.registry.get(child.id)?.archived).not.toBe(true)
      expect(store.rows()).toHaveLength(0)
    } finally {
      runner.stop()
      ctx.registry.shutdown()
    }
  })
})
