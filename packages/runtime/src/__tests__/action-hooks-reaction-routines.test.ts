/**
 * End to end: real routine registrar, real reaction wiring, real reaction
 * runner over a real session event bus and a real receipt store.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { createSessionEventBus, type SessionCompletedEvent } from "../session-event-bus.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createRoutineRegistrar } from "../routine-registrar.js"
import type { CronScheduler, CronJob } from "../cron-scheduler.js"
import {
  createActionRegistry,
  createReactionReceiptStore,
  createReactionRunner,
  createReactionWiring,
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

function notifyRoutine(id: string, tool: string, extra: string[] = []): string[] {
  return [
    "schema: routine/v1",
    `id: ${id}`,
    "description: test",
    "schedule:",
    "  kind: event",
    "  on: agentproto:session-completed",
    "  filter:",
    "    session.kind: agent-cli",
    "target:",
    `  tool: ${tool}`,
    "  inputs:",
    `    stage: ${tool}`,
    ...extra,
  ]
}

describe("event routines end to end", () => {
  it("runs, dedupes, filters, hot refreshes, disables and refuses like the daemon", async () => {
    const ws = tmp("reaction-routines-")
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp("reaction-transcripts-"),
      sessionEvents: bus,
    })
    wireSessionCompletion({ bus, getSession: id => registry.get(id) })

    const store = createReactionReceiptStore({
      filePath: join(tmp("reaction-receipts-"), "receipts.json"),
      debounceMs: 60_000,
      log: () => {},
    })
    const calls: Array<{ tool: string; inputs: Record<string, unknown> }> = []
    const dispatchTool = vi.fn(async (tool: string, inputs: Record<string, unknown>) => {
      calls.push({ tool, inputs })
      return { content: [{ text: "ok" }] }
    })
    const actionRegistry = createActionRegistry()
    const runner = createReactionRunner({ bus, store, bindings: [], log: () => {} })
    const eventBindings = () => registrar.eventBindings()
    const wiring = createReactionWiring({
      runner,
      builtin: [],
      eventBindings,
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
    runner.start()

    const spawnAgent = (origin?: string, parentSessionId?: string) =>
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: ws,
        agentSession: liveAgentSession(`live-${Math.random()}`),
        adapterSlug: "claude-code",
        ...(origin ? { origin } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
      })

    try {
      writeRoutine(ws, "notify", notifyRoutine("notify", "notify-one"))
      await registrar.reconcile()

      const first = spawnAgent()
      registry.closeWithOutcome(first.id, { verdict: "done", source: "declared" })
      await vi.waitFor(() => expect(dispatchTool).toHaveBeenCalledTimes(1))
      expect(calls[0]).toEqual({
        tool: "notify-one",
        inputs: { stage: "notify-one" },
      })
      const firstEvent = {
        type: "agentproto:session-completed",
        sessionId: first.id,
        occurrenceId: `exit:${registry.get(first.id)?.endedAt}`,
        basis: "outcome",
        endedAt: registry.get(first.id)?.endedAt,
        ts: "2026-01-01T00:00:00.000Z",
      } as SessionCompletedEvent
      expect(store.rows().filter(row => row.bindingId === "routine:notify").every(row => row.status === "done")).toBe(true)

      bus.emit(firstEvent)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(dispatchTool).toHaveBeenCalledTimes(1)

      const command = registry.recordCommand({
        workspaceSlug: "default",
        cwd: ws,
        command: "echo",
        args: ["hi"],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "hi",
        stderr: "",
        origin: "command_execute",
      })
      bus.emit({
        ...firstEvent,
        sessionId: command.id,
        occurrenceId: "exit:command",
      })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(dispatchTool).toHaveBeenCalledTimes(1)

      writeRoutine(ws, "notify", notifyRoutine("notify", "notify-two"))
      await registrar.reconcile()
      const second = spawnAgent()
      registry.closeWithOutcome(second.id, { verdict: "done", source: "declared" })
      await vi.waitFor(() => expect(dispatchTool).toHaveBeenCalledTimes(2))
      expect(calls[1]?.tool).toBe("notify-two")

      writeRoutine(ws, "notify", notifyRoutine("notify", "notify-two", ["enabled: false"]))
      await registrar.reconcile()
      const third = spawnAgent()
      registry.closeWithOutcome(third.id, { verdict: "done", source: "declared" })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(dispatchTool).toHaveBeenCalledTimes(2)

      writeRoutine(ws, "action-arm", [
        "schema: routine/v1",
        "id: action-arm",
        "description: test",
        "schedule:",
        "  kind: event",
        "  on: agentproto:session-completed",
        "target:",
        "  action: demo:notify",
      ])
      const actionResult = await registrar.reconcile()
      expect(actionResult.reactions?.refused).toContainEqual({
        bindingId: "routine:action-arm",
        error: "action 'demo:notify' is not registered; a binding may not reference an unknown action",
      })
      expect(dispatchTool).toHaveBeenCalledTimes(2)

      writeRoutine(ws, "agent-arm", [
        "schema: routine/v1",
        "id: agent-arm",
        "description: test",
        "schedule:",
        "  kind: event",
        "  on: agentproto:session-completed",
        "target:",
        "  agent:",
        "    adapter: claude-code",
        "    prompt: say hi",
      ])
      await registrar.reconcile()

      const reactionLaunched = spawnAgent("reaction:routine:agent-arm")
      registry.closeWithOutcome(reactionLaunched.id, { verdict: "done", source: "declared" })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(dispatchTool).toHaveBeenCalledTimes(2)

      bus.emit({
        ...firstEvent,
        sessionId: "missing-session",
        occurrenceId: "exit:missing",
      })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(dispatchTool).toHaveBeenCalledTimes(2)
    } finally {
      runner.stop()
      registry.shutdown()
    }
  })

  it("still returns an exited session from the real registry when completion fires", () => {
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp("reaction-precondition-"),
      sessionEvents: bus,
    })
    const seen: Array<{ id: string; kind: string; status: string | undefined }> = []
    wireSessionCompletion({ bus, getSession: id => registry.get(id) })
    bus.on("agentproto:session-completed", event => {
      const desc = registry.get(event.sessionId)
      expect(desc).toBeDefined()
      seen.push({ id: event.sessionId, kind: String(desc?.kind), status: desc?.status })
    })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("precondition"),
      adapterSlug: "claude-code",
    })
    registry.closeWithOutcome(desc.id, { verdict: "done", source: "declared" })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ id: desc.id, kind: "agent-cli", status: "killed" })
    registry.shutdown()
  })
})
