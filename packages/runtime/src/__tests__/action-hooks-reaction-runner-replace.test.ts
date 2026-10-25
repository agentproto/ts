/**
 * ReactionRunner.replaceBindings: hot swap of the live binding set.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionEventBus, type SessionCompletedEvent, type SessionEvent } from "../session-event-bus.js"
import {
  buildReactionReceiptKey,
  createReactionReceiptStore,
  createReactionRunner,
  type NewReactionReceipt,
  type ReactionBinding,
  type ReactionTarget,
  type ReactionTargetInput,
  type ReactionTargetOutcome,
} from "../action-hooks/index.js"

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "reaction-replace-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const EVENT = "agentproto:session-completed"

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: ms => { t += ms } }
}

async function flush(times = 50): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const completed = (over: Partial<SessionCompletedEvent> = {}): SessionCompletedEvent => ({
  type: EVENT,
  sessionId: "sess-1",
  occurrenceId: "exit:1",
  basis: "outcome",
  endedAt: "2026-01-01T00:00:00.000Z",
  ts: "2026-01-01T00:00:00.000Z",
  ...over,
})

const keyOf = (occurrenceId: string, bindingId = "bind-1"): string =>
  buildReactionReceiptKey({ sessionId: "sess-1", event: EVENT, occurrenceId, bindingId })

const pendingInput = (over: Partial<NewReactionReceipt> = {}): NewReactionReceipt => ({
  sessionId: "sess-1",
  event: EVENT,
  occurrenceId: "exit:1",
  bindingId: "bind-1",
  actionId: "brain:ingest",
  configRevision: "cfg-1",
  maxAttempts: 3,
  reactionDepth: 0,
  ...over,
})

function makeTarget(
  idempotent = true,
  impl?: (input: ReactionTargetInput) => Promise<ReactionTargetOutcome>,
): { target: ReactionTarget; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(impl ?? (async () => ({ ok: true, outcomeRef: "ref-1" })))
  return {
    target: { actionId: "brain:ingest", idempotent, run: run as unknown as ReactionTarget["run"] },
    run,
  }
}

function makeBinding(over: Partial<ReactionBinding> = {}): ReactionBinding {
  return {
    bindingId: "bind-1",
    event: EVENT,
    actionId: "brain:ingest",
    configRevision: "cfg-1",
    maxAttempts: 3,
    reactionDepth: 0,
    occurrenceIdOf: (event: SessionEvent) =>
      event.type === EVENT ? (event as SessionCompletedEvent).occurrenceId : undefined,
    target: over.target ?? makeTarget().target,
    ...over,
  }
}

function setup(over: { bindings?: readonly ReactionBinding[] } = {}) {
  const c = clock()
  const file = join(tmp(), "receipts.json")
  const logs: string[] = []
  const store = createReactionReceiptStore({ filePath: file, nowMs: c.now, debounceMs: 60_000, log: () => {} })
  const bus = createSessionEventBus()
  const runner = createReactionRunner({
    bus,
    store,
    bindings: over.bindings ?? [],
    nowMs: c.now,
    log: line => logs.push(line),
  })
  return { c, file, logs, store, bus, runner }
}

describe("reaction runner replaceBindings", () => {
  it("adds a binding that then handles an event", async () => {
    const { bus, runner } = setup()
    const { target, run } = makeTarget()
    runner.start()
    runner.replaceBindings([makeBinding({ bindingId: "bind-new", target })])
    bus.emit(completed())
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    runner.stop()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toMatchObject({ bindingId: "bind-new" })
  })

  it("removes a binding without touching its pending receipt and logs the ids once", async () => {
    const { bus, runner, store, logs } = setup({ bindings: [makeBinding({ bindingId: "bind-1" })] })
    const { target, run } = makeTarget()
    const key = keyOf("exit:1", "bind-1")
    await store.insertPending(pendingInput({ bindingId: "bind-1" }))
    runner.start()
    runner.replaceBindings([makeBinding({ bindingId: "bind-2", target })])
    bus.emit(completed())
    await flush()
    runner.stop()
    expect(run).not.toHaveBeenCalled()
    expect(store.get(key)?.status).toBe("pending")
    expect(logs.filter(line => line.includes("bindings removed: bind-1"))).toHaveLength(1)
    runner.replaceBindings([makeBinding({ bindingId: "bind-2", target })])
    expect(logs.filter(line => line.includes("bindings removed:"))).toHaveLength(1)
  })

  it("an in-flight run finishes with its old binding after a replace", async () => {
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const entered = new Promise<void>(resolve => { started = resolve })
    const old = makeTarget(true, async () => {
      started?.()
      await new Promise<void>(resolve => { release = resolve })
      return { ok: true, outcomeRef: "old" }
    })
    const { runner } = setup({ bindings: [makeBinding({ bindingId: "bind-old", target: old.target })] })
    const event = completed({ occurrenceId: "exit:inflight" })
    const runPromise = runner.handleEvent(event, "exit:inflight")
    await entered
    const fresh = makeTarget()
    runner.replaceBindings([makeBinding({ bindingId: "bind-new", target: fresh.target })])
    release?.()
    await runPromise
    expect(old.run).toHaveBeenCalledTimes(1)
    expect(fresh.run).not.toHaveBeenCalled()
  })

  it("a removed binding's pending receipt resumes at boot when the binding comes back", async () => {
    const { runner, store } = setup({ bindings: [makeBinding({ bindingId: "bind-1" })] })
    const key = keyOf("exit:resume", "bind-1")
    await store.insertPending(pendingInput({ occurrenceId: "exit:resume", bindingId: "bind-1" }))
    const { target, run } = makeTarget(true, async () => ({ ok: true, outcomeRef: "resumed" }))
    runner.replaceBindings([])
    await runner.reconcileOnBoot()
    expect(run).not.toHaveBeenCalled()
    expect(store.get(key)?.status).toBe("pending")
    runner.replaceBindings([makeBinding({ bindingId: "bind-1", target })])
    await runner.reconcileOnBoot()
    expect(run).toHaveBeenCalledTimes(1)
    expect(store.get(key)?.status).toBe("done")
  })

  it("status lists the current bindings only", () => {
    const { runner } = setup({ bindings: [makeBinding({ bindingId: "bind-old" })] })
    runner.replaceBindings([makeBinding({ bindingId: "bind-a" }), makeBinding({ bindingId: "bind-b" })])
    expect(runner.status().map(entry => entry.bindingId)).toEqual(["bind-a", "bind-b"])
  })
})
