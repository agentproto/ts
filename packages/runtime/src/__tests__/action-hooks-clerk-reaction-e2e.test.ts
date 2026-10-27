/**
 * End to end: real clerk turn-end controller, real session bus and registry,
 * real receipt store, runner, wiring and action registry. The controller gets
 * injected timers and clock; the pass runner is a spy.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

import type { ClerkHookConfig, ClerkPassInput } from "@agentproto/clerk"
import { createClerkTurnEndController } from "@agentproto/clerk"

import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionDescriptor,
} from "../sessions.js"
import {
  createActionRegistry,
  createClerkReaction,
  createReactionReceiptStore,
  createReactionRunner,
  createReactionWiring,
  reactionSpawnStamp,
  sessionFactsOf,
  toReactionBinding,
  type ResolvedEventBinding,
} from "../action-hooks/index.js"
import {
  CLERK_REACTION_ACTION_ID,
  CLERK_REACTION_BINDING_ID,
  type ClerkReaction,
} from "../action-hooks/clerk-reaction.js"

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

const config = (run: ClerkHookConfig["run"] = { routine: "steward" }): ClerkHookConfig => ({
  enabled: true,
  on: "turn_end",
  debounceMs: 5,
  run,
})

const turnEnd = (sessionId: string): SessionEvent =>
  ({
    type: "session:turn-end",
    sessionId,
    awaitingInput: false,
    ts: "2026-01-01T00:00:00.000Z",
  }) as SessionEvent

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function fakeTimers() {
  let nextId = 0
  const timers = new Map<number, { fn: () => void; canceled: boolean }>()
  return {
    setTimer(fn: () => void): unknown {
      const id = ++nextId
      timers.set(id, { fn, canceled: false })
      return id
    },
    clearTimer(timer: unknown): void {
      const entry = timers.get(timer as number)
      if (entry) entry.canceled = true
    },
    fire(): void {
      const entries = [...timers.values()]
      timers.clear()
      for (const entry of entries) {
        if (!entry.canceled) entry.fn()
      }
    },
  }
}

interface HarnessOptions {
  slug?: string
  owned?: () => readonly string[]
  run?: ClerkHookConfig["run"]
  pass?: (input: ClerkPassInput) => Promise<unknown> | unknown
  autoTimer?: boolean
}

function setup(opts: HarnessOptions = {}) {
  const ws = tmp("clerk-reaction-e2e-")
  const bus = createSessionEventBus()
  const registry = createSessionsRegistry({
    persist: false,
    transcriptDir: tmp("clerk-reaction-transcripts-"),
    sessionEvents: bus,
  })
  const root = registry.spawnAgent({
    workspaceSlug: opts.slug ?? "ws-a",
    cwd: ws,
    agentSession: liveAgentSession("root"),
    adapterSlug: "claude-code",
  })

  const clock = { now: 1_000 }
  const store = createReactionReceiptStore({ persist: false, nowMs: () => clock.now, log: () => {} })
  const pass = vi.fn(opts.pass ?? (async () => undefined))
  const actionRegistry = createActionRegistry()
  const runner = createReactionRunner({
    bus,
    store,
    bindings: [],
    nowMs: () => clock.now,
    log: () => {},
  })
  const reaction: ClerkReaction = createClerkReaction({
    sessions: registry,
    resolveConfig: () => config(opts.run),
    runPass: pass,
    ownedWorkspaces: opts.owned ?? (() => ["ws-a"]),
    emit: event => bus.emit(event),
    nowIso: () => "2026-01-01T00:00:01.000Z",
    log: () => {},
  })
  actionRegistry.register(reaction.handler)
  const wiring = createReactionWiring({
    runner,
    builtin: [reaction.binding],
    eventBindings: () => [],
    conversion: {
      registry: actionRegistry,
      dispatchTool: vi.fn(),
      getSessionFacts: id => {
        const desc = registry.get(id)
        return desc ? sessionFactsOf(desc) : undefined
      },
      workspaceRoot: ws,
    },
    log: () => {},
  })
  wiring.refresh()
  runner.start()

  const timers = fakeTimers()
  const setTimer = opts.autoTimer
    ? (fn: () => void) => setTimeout(fn, 0)
    : (fn: () => void) => timers.setTimer(fn)
  const clearTimer = opts.autoTimer
    ? (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)
    : (timer: unknown) => timers.clearTimer(timer)
  const controller = createClerkTurnEndController({
    registry,
    sessionEvents: bus,
    resolveConfig: () => config(opts.run),
    runPass: reaction.dispatch,
    now: () => clock.now,
    setTimer,
    clearTimer,
    onError: () => {},
  })
  const due: SessionEvent[] = []
  bus.on("agentproto:clerk-due", event => {
    due.push(event)
  })

  return {
    ws,
    bus,
    registry,
    root,
    store,
    pass,
    runner,
    reaction,
    actionRegistry,
    controller,
    clock,
    due,
    fire: () => timers.fire(),
    stop: () => {
      controller.dispose()
      runner.stop()
      registry.shutdown()
    },
  }
}

function rowsOf(store: ReturnType<typeof createReactionReceiptStore>, sessionId?: string) {
  return store
    .rows()
    .filter(row => row.bindingId === CLERK_REACTION_BINDING_ID)
    .filter(row => sessionId === undefined || row.sessionId === sessionId)
}

describe("clerk reaction end to end", () => {
  it("owned workspace: one debounce firing leads to one done receipt and one pass", async () => {
    const h = setup({ run: { routine: "steward" } })
    try {
      h.bus.emit(turnEnd(h.root.id))
      h.fire()
      await waitFor(() => rowsOf(h.store).some(row => row.status === "done"))
      const rows = rowsOf(h.store)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: "done", outcomeRef: "routine:steward" })
      expect(h.pass).toHaveBeenCalledTimes(1)
      expect(h.due).toHaveLength(1)
    } finally {
      h.stop()
    }
  })

  it("command arm: a non-zero exit ends dead after one attempt and a zero exit ends done", async () => {
    const failing = setup({
      run: { command: "/usr/local/bin/steward" },
      pass: async () => ({ code: 1 }),
    })
    try {
      failing.bus.emit(turnEnd(failing.root.id))
      failing.fire()
      await waitFor(() => rowsOf(failing.store).some(row => row.status === "dead"))
      const failedRows = rowsOf(failing.store)
      expect(failedRows).toHaveLength(1)
      expect(failedRows[0]).toMatchObject({
        status: "dead",
        attempt: 1,
      })
      expect(failedRows[0]?.lastError).toContain("command exited with code 1")
      expect(failing.pass).toHaveBeenCalledTimes(1)
    } finally {
      failing.stop()
    }

    const passing = setup({
      run: { command: "/usr/local/bin/steward" },
      pass: async () => ({ code: 0 }),
    })
    try {
      passing.bus.emit(turnEnd(passing.root.id))
      passing.fire()
      await waitFor(() => rowsOf(passing.store).some(row => row.status === "done"))
      expect(rowsOf(passing.store)).toHaveLength(1)
      expect(rowsOf(passing.store)[0]).toMatchObject({
        status: "done",
        outcomeRef: "command:steward",
      })
      expect(passing.pass).toHaveBeenCalledTimes(1)
    } finally {
      passing.stop()
    }
  })

  it("three turn-ends inside the debounce window lead to one pass and one receipt", async () => {
    const h = setup()
    try {
      h.bus.emit(turnEnd(h.root.id))
      h.bus.emit(turnEnd(h.root.id))
      h.bus.emit(turnEnd(h.root.id))
      h.fire()
      await waitFor(() => rowsOf(h.store).some(row => row.status === "done"))
      expect(rowsOf(h.store)).toHaveLength(1)
      expect(h.pass).toHaveBeenCalledTimes(1)
      expect(h.due).toHaveLength(1)
    } finally {
      h.stop()
    }
  })

  it("not owned workspace: the legacy dispatch runs, with no receipt and no clerk-due", async () => {
    const h = setup({ slug: "ws-b", owned: () => ["ws-a"] })
    try {
      h.bus.emit(turnEnd(h.root.id))
      h.fire()
      await waitFor(() => h.pass.mock.calls.length === 1)
      expect(h.pass).toHaveBeenCalledTimes(1)
      expect(rowsOf(h.store)).toEqual([])
      expect(h.due).toEqual([])
    } finally {
      h.stop()
    }
  })

  it("flipping ownership between two firings switches the path with no double run", async () => {
    let owned: string[] = ["ws-a"]
    const h = setup({ owned: () => owned })
    try {
      h.bus.emit(turnEnd(h.root.id))
      h.fire()
      await waitFor(() => rowsOf(h.store).some(row => row.status === "done"))
      expect(rowsOf(h.store)).toHaveLength(1)
      expect(h.pass).toHaveBeenCalledTimes(1)

      owned = []
      h.bus.emit(turnEnd(h.root.id))
      h.fire()
      await waitFor(() => h.pass.mock.calls.length === 2)
      expect(h.pass).toHaveBeenCalledTimes(2)
      expect(rowsOf(h.store)).toHaveLength(1)
    } finally {
      h.stop()
    }
  })

  it("a pass that throws once is failed, then done after retryDue, with two calls in total", async () => {
    let calls = 0
    const h = setup({
      pass: async () => {
        calls += 1
        if (calls === 1) throw new Error("pass exploded")
        return undefined
      },
    })
    try {
      h.bus.emit(turnEnd(h.root.id))
      h.fire()
      await waitFor(() => rowsOf(h.store).some(row => row.status === "failed"))
      const failed = rowsOf(h.store)[0]
      expect(failed?.status).toBe("failed")
      expect(failed?.lastError).toContain("pass exploded")

      h.clock.now += 10 * 60_000
      await h.runner.retryDue()
      await waitFor(() => rowsOf(h.store).some(row => row.status === "done"))
      expect(rowsOf(h.store)).toHaveLength(1)
      expect(rowsOf(h.store)[0]).toMatchObject({ status: "done", outcomeRef: "routine:steward" })
      expect(calls).toBe(2)
    } finally {
      h.stop()
    }
  })

  it("restart: a stale pending receipt dies and a running non idempotent receipt is not replayed", async () => {
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp("clerk-reaction-restart-"),
      sessionEvents: bus,
    })
    const store = createReactionReceiptStore({ persist: false, log: () => {} })
    const pass = vi.fn()
    const reaction = createClerkReaction({
      sessions: registry,
      resolveConfig: () => config(),
      runPass: pass,
      ownedWorkspaces: () => ["ws-a"],
      emit: () => {},
      log: () => {},
    })
    const input = {
      sessionId: "gone-1",
      event: "agentproto:clerk-due",
      occurrenceId: "due:gone",
      bindingId: CLERK_REACTION_BINDING_ID,
      actionId: CLERK_REACTION_ACTION_ID,
      configRevision: "clerk-pass-v1",
      maxAttempts: 3,
      reactionDepth: 0,
    }
    const pending = await store.insertPending(input)
    const running = await store.insertPending({ ...input, sessionId: "gone-2", occurrenceId: "due:running" })
    await store.markRunning(running.receiptKey)

    const runner = createReactionRunner({ bus, store, bindings: [reaction.binding], log: () => {} })
    await runner.reconcileOnBoot()

    expect(store.get(pending.receiptKey)).toMatchObject({ status: "dead", lastError: "stale_trigger" })
    expect(store.get(running.receiptKey)?.status).toBe("running")
    expect(pass).not.toHaveBeenCalled()
    runner.stop()
    registry.shutdown()
  })

  it("recursion guard: a pass that spawns and ends a turn does not chain beyond the depth cap", async () => {
    let seq = 0
    let h: ReturnType<typeof setup>
    h = setup({
      autoTimer: true,
      pass: async () => {
        seq += 1
        const stamp = reactionSpawnStamp("reaction:clerk-chain")
        const child = h.registry.spawnAgent({
          workspaceSlug: "ws-a",
          cwd: h.ws,
          agentSession: liveAgentSession(`child-${seq}`),
          adapterSlug: "claude-code",
          ...(stamp ? { origin: stamp.origin, meta: stamp.meta } : {}),
        })
        h.bus.emit(turnEnd(child.id))
        return undefined
      },
    })
    try {
      h.bus.emit(turnEnd(h.root.id))
      await waitFor(() => rowsOf(h.store).some(row => row.lastError === "recursion_cap"), 10_000)
      await new Promise(resolve => setTimeout(resolve, 50))
      const rows = rowsOf(h.store).sort((a, b) => a.reactionDepth - b.reactionDepth)
      expect(rows.map(row => row.reactionDepth)).toEqual([0, 1, 2, 3, 4])
      expect(rows.map(row => row.status)).toEqual(["done", "done", "done", "done", "dead"])
      expect(rows[4]?.lastError).toBe("recursion_cap")
      expect(h.pass).toHaveBeenCalledTimes(4)
    } finally {
      h.stop()
    }
  })

  it("registered action: toReactionBinding resolves the clerk handler and its run calls the pass once", async () => {
    const h = setup()
    try {
      const resolved = {
        bindingId: "routine:clerk-action",
        event: { event: "agentproto:session-completed" },
        target: { action: CLERK_REACTION_ACTION_ID },
        source: { kind: "routine", routineId: "clerk-action" },
        configRevision: "rev-1",
      } as unknown as ResolvedEventBinding
      const converted = toReactionBinding(resolved, {
        registry: h.actionRegistry,
        dispatchTool: vi.fn(),
        getSessionFacts: id => {
          const desc = h.registry.get(id)
          return desc ? sessionFactsOf(desc) : undefined
        },
        workspaceRoot: h.ws,
      })
      expect(converted.ok).toBe(true)
      if (!converted.ok) return
      expect(h.actionRegistry.get(CLERK_REACTION_ACTION_ID)).toBe(h.reaction.handler)
      const outcome = await converted.binding.target.run({
        receiptKey: "routine:clerk-action/key",
        sessionId: h.root.id,
        event: "agentproto:session-completed",
        occurrenceId: "exit:1",
        bindingId: "routine:clerk-action",
        reactionDepth: 0,
      })
      expect(outcome).toEqual({ ok: true, outcomeRef: "routine:steward" })
      expect(h.pass).toHaveBeenCalledTimes(1)
    } finally {
      h.stop()
    }
  })
})
