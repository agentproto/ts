/**
 * ReactionRunner: live delivery, single-flight, durable running, retries,
 * recursion cap, boot reconciliation and the retry tick. Every test drives an
 * injected clock over a real receipt file; none sleeps.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionEventBus, type SessionCompletedEvent, type SessionEvent } from "../session-event-bus.js"
import {
  buildReactionReceiptKey,
  createReactionReceiptStore,
  createReactionRunner,
  type NewReactionReceipt,
  type ReactionBinding,
  type ReactionReceipt,
  type ReactionReceiptStore,
  type ReactionRunner,
  type ReactionRunnerOptions,
  type ReactionTarget,
  type ReactionTargetInput,
  type ReactionTargetOutcome,
} from "../action-hooks/index.js"

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "reaction-runner-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function clock(start = 1_000_000) {
  let t = start
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms
    },
  }
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const EVENT = "agentproto:session-completed"

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
  buildReactionReceiptKey({
    sessionId: "sess-1",
    event: EVENT,
    occurrenceId,
    bindingId,
  })

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

function openStore(file: string, c: ReturnType<typeof clock>): ReactionReceiptStore {
  return createReactionReceiptStore({
    filePath: file,
    nowMs: c.now,
    debounceMs: 60_000,
    log: () => {},
  })
}

function makeTarget(
  idempotent = true,
  impl?: (input: ReactionTargetInput) => Promise<ReactionTargetOutcome>,
): { target: ReactionTarget; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(impl ?? (async () => ({ ok: true, outcomeRef: "ref-1" })))
  return {
    target: {
      actionId: "brain:ingest",
      idempotent,
      run: run as unknown as ReactionTarget["run"],
    },
    run,
  }
}

function makeBinding(over: Partial<ReactionBinding> = {}): ReactionBinding {
  const target = over.target ?? makeTarget().target
  return {
    bindingId: "bind-1",
    event: EVENT,
    actionId: "brain:ingest",
    configRevision: "cfg-1",
    maxAttempts: 3,
    reactionDepth: 0,
    occurrenceIdOf: (event: SessionEvent) =>
      event.type === EVENT ? (event as SessionCompletedEvent).occurrenceId : undefined,
    target,
    ...over,
  }
}

function setup(
  over: {
    bindings?: readonly ReactionBinding[]
    file?: string
    c?: ReturnType<typeof clock>
    store?: ReactionReceiptStore
  } & Partial<ReactionRunnerOptions> = {},
): {
  c: ReturnType<typeof clock>
  file: string
  logs: string[]
  store: ReactionReceiptStore
  bus: ReturnType<typeof createSessionEventBus>
  bindings: readonly ReactionBinding[]
  runner: ReactionRunner
} {
  const c = over.c ?? clock()
  const file = over.file ?? join(tmp(), "receipts.json")
  const logs: string[] = []
  const store = over.store ?? openStore(file, c)
  const bus = createSessionEventBus()
  const bindings = over.bindings ?? [makeBinding()]
  const runner = createReactionRunner({
    bus,
    store,
    bindings,
    nowMs: c.now,
    log: line => logs.push(line),
    ...over,
  })
  return { c, file, logs, store, bus, bindings, runner }
}

describe("reaction runner", () => {
  it("a bus event runs the target once and the receipt ends done with its outcomeRef", async () => {
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve
    })
    const run = vi.fn(async () => {
      notifyStarted?.()
      return { ok: true, outcomeRef: "brain-ref-1" }
    })
    const target: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: run as unknown as ReactionTarget["run"],
    }
    const { runner, bus, store } = setup({ bindings: [makeBinding({ target })] })

    runner.start()
    bus.emit(completed({ occurrenceId: "exit:1" }))
    await started
    await flush()
    runner.stop()

    expect(run).toHaveBeenCalledTimes(1)
    const input = (run.mock.calls[0] as unknown as [ReactionTargetInput])[0]
    expect(input.receiptKey).toBe(keyOf("exit:1"))
    expect(input.occurrenceId).toBe("exit:1")
    expect(input.bindingId).toBe("bind-1")
    const receipt = store.get(keyOf("exit:1"))
    expect(receipt?.status).toBe("done")
    expect(receipt?.outcomeRef).toBe("brain-ref-1")
  })

  it("an event for which occurrenceIdOf returns undefined creates no receipt", () => {
    const { runner, bus, store } = setup({
      bindings: [makeBinding({ occurrenceIdOf: () => undefined })],
    })
    runner.start()
    bus.emit(completed())
    runner.stop()
    expect(store.rows()).toEqual([])
  })

  it("honours shouldHandle: false skips, true proceeds, a throw is logged and skips", async () => {
    const shouldHandle = vi.fn((): boolean => false)
    const run = vi.fn(async () => ({ ok: true, outcomeRef: "ref" }))
    const target: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: run as unknown as ReactionTarget["run"],
    }
    const { runner, store, logs } = setup({
      bindings: [makeBinding({ target, shouldHandle })],
    })

    await runner.handleEvent(completed({ occurrenceId: "exit:a" }), "exit:a")
    expect(store.rows()).toEqual([])

    shouldHandle.mockReturnValue(true)
    await runner.handleEvent(completed({ occurrenceId: "exit:b" }), "exit:b")
    expect(store.rows()).toHaveLength(1)
    expect(store.get(keyOf("exit:b"))?.status).toBe("done")
    expect(run).toHaveBeenCalledTimes(1)

    shouldHandle.mockImplementation(() => {
      throw new Error("filter exploded")
    })
    await runner.handleEvent(completed({ occurrenceId: "exit:c" }), "exit:c")
    expect(store.rows()).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(logs.some(line => line.includes("shouldHandle") && line.includes("filter exploded"))).toBe(true)
  })

  it("the same occurrence delivered twice, sequentially and concurrently, runs the target once", async () => {
    const calls: string[] = []
    const run = vi.fn(async (input: ReactionTargetInput) => {
      calls.push(input.occurrenceId)
      return { ok: true, outcomeRef: `ref-${input.occurrenceId}` }
    })
    const target: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: run as unknown as ReactionTarget["run"],
    }
    const { runner, store, c } = setup({ bindings: [makeBinding({ target })] })

    const event = completed({ occurrenceId: "exit:sequential" })
    await runner.handleEvent(event, "exit:sequential")
    await runner.handleEvent(event, "exit:sequential")
    expect(run).toHaveBeenCalledTimes(1)

    const concurrentEvent = completed({ occurrenceId: "exit:concurrent" })
    await store.insertPending(pendingInput({ occurrenceId: "exit:concurrent" }))
    await Promise.all([
      runner.handleEvent(concurrentEvent, "exit:concurrent"),
      runner.handleEvent(concurrentEvent, "exit:concurrent"),
    ])
    expect(calls).toEqual(["exit:sequential", "exit:concurrent"])

    const raceKey = keyOf("exit:race")
    await store.insertPending(pendingInput({ occurrenceId: "exit:race" }))
    await store.markRunning(raceKey)
    await store.markFailed(raceKey, "retry me", c.now())
    const raceEvent = completed({ occurrenceId: "exit:race" })
    await Promise.all([runner.retryDue(), runner.handleEvent(raceEvent, "exit:race")])
    expect(calls.filter(occurrenceId => occurrenceId === "exit:race")).toHaveLength(1)
  })

  it("running is durable before the target starts", async () => {
    const c = clock()
    const file = join(tmp(), "receipts.json")
    const store = openStore(file, c)
    const seenStatuses: string[] = []
    const run = vi.fn(async (input: ReactionTargetInput) => {
      const fresh = openStore(file, c)
      seenStatuses.push(fresh.get(input.receiptKey)?.status ?? "missing")
      return { ok: true, outcomeRef: "ref" }
    })
    const target: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: run as unknown as ReactionTarget["run"],
    }
    const runner = createReactionRunner({
      bus: createSessionEventBus(),
      store,
      bindings: [makeBinding({ target })],
      nowMs: c.now,
      log: () => {},
    })

    await runner.handleEvent(completed({ occurrenceId: "exit:1" }), "exit:1")
    expect(seenStatuses).toEqual(["running"])
  })

  it("a failed durable markRunning never runs the target", async () => {
    const c = clock()
    const base = tmp()
    const dir = join(base, "receipts")
    mkdirSync(dir)
    const file = join(dir, "receipts.json")
    const store = openStore(file, c)
    const run = vi.fn(async () => ({ ok: true, outcomeRef: "ref" }))
    const target: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: run as unknown as ReactionTarget["run"],
    }
    const runner = createReactionRunner({
      bus: createSessionEventBus(),
      store,
      bindings: [makeBinding({ target })],
      nowMs: c.now,
      log: () => {},
    })

    await store.insertPending(pendingInput())
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, "not a directory")

    await runner.handleEvent(completed({ occurrenceId: "exit:1" }), "exit:1")

    expect(run).not.toHaveBeenCalled()
    expect(store.get(keyOf("exit:1"))?.status).toBe("pending")
  })

  it("retries a retryable failure only after nextAttemptAt is due, then ends done at attempt 2", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, retryable: true, error: "boom" })
      .mockResolvedValueOnce({ ok: true, outcomeRef: "ref-2" })
    const target: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: run as unknown as ReactionTarget["run"],
    }
    const { runner, store, c } = setup({ bindings: [makeBinding({ target })] })

    await runner.handleEvent(completed({ occurrenceId: "exit:1" }), "exit:1")
    const key = keyOf("exit:1")
    let receipt = store.get(key)
    expect(receipt?.status).toBe("failed")
    expect(receipt?.lastError).toBe("boom")
    expect(receipt?.nextAttemptAt).toBe(c.now() + 30_000)

    await runner.retryDue()
    expect(run).toHaveBeenCalledTimes(1)

    c.advance(29_999)
    await runner.retryDue()
    expect(run).toHaveBeenCalledTimes(1)

    c.advance(1)
    await runner.retryDue()
    expect(run).toHaveBeenCalledTimes(2)
    receipt = store.get(key)
    expect(receipt?.status).toBe("done")
    expect(receipt?.attempt).toBe(2)
    expect(receipt?.outcomeRef).toBe("ref-2")
  })

  it("sends a non-retryable failure to dead, retries a thrown error and stops at maxAttempts", async () => {
    const deadRun = vi.fn(async () => ({ ok: false, retryable: false, error: "fatal" }))
    const deadTarget: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: deadRun as unknown as ReactionTarget["run"],
    }
    const deadCase = setup({ bindings: [makeBinding({ target: deadTarget })] })
    await deadCase.runner.handleEvent(completed({ occurrenceId: "exit:dead" }), "exit:dead")
    expect(deadCase.store.get(keyOf("exit:dead"))?.status).toBe("dead")
    expect(deadCase.store.get(keyOf("exit:dead"))?.lastError).toBe("fatal")
    deadCase.c.advance(600_000)
    await deadCase.runner.retryDue()
    expect(deadRun).toHaveBeenCalledTimes(1)

    const thrownRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("thrown boom"))
      .mockResolvedValueOnce({ ok: true, outcomeRef: "ref" })
    const thrownTarget: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: thrownRun as unknown as ReactionTarget["run"],
    }
    const thrownCase = setup({ bindings: [makeBinding({ target: thrownTarget })] })
    await thrownCase.runner.handleEvent(completed({ occurrenceId: "exit:throw" }), "exit:throw")
    expect(thrownCase.store.get(keyOf("exit:throw"))?.status).toBe("failed")
    expect(thrownCase.store.get(keyOf("exit:throw"))?.lastError).toBe("thrown boom")
    thrownCase.c.advance(30_000)
    await thrownCase.runner.retryDue()
    expect(thrownCase.store.get(keyOf("exit:throw"))?.status).toBe("done")
    expect(thrownCase.store.get(keyOf("exit:throw"))?.attempt).toBe(2)

    const exhaustRun = vi.fn(async () => ({ ok: false, retryable: true, error: "still failing" }))
    const exhaustTarget: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: exhaustRun as unknown as ReactionTarget["run"],
    }
    const exhaustCase = setup({
      bindings: [makeBinding({ target: exhaustTarget, maxAttempts: 2 })],
    })
    await exhaustCase.runner.handleEvent(completed({ occurrenceId: "exit:exhaust" }), "exit:exhaust")
    exhaustCase.c.advance(30_000)
    await exhaustCase.runner.retryDue()
    expect(exhaustRun).toHaveBeenCalledTimes(2)
    expect(exhaustCase.store.get(keyOf("exit:exhaust"))?.status).toBe("dead")
  })

  it("caps recursion with a dead receipt and never runs the target", async () => {
    const run = vi.fn(async () => ({ ok: true, outcomeRef: "ref" }))
    const target: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: run as unknown as ReactionTarget["run"],
    }
    const { runner, store } = setup({
      bindings: [makeBinding({ target, reactionDepth: 4 })],
      maxReactionDepth: 4,
    })

    await runner.handleEvent(completed({ occurrenceId: "exit:1" }), "exit:1")

    expect(run).not.toHaveBeenCalled()
    const receipt = store.get(keyOf("exit:1"))
    expect(receipt?.status).toBe("dead")
    expect(receipt?.lastError).toBe("recursion_cap")
  })

  it("restart A: a pending receipt is re-driven exactly once for idempotent and non idempotent targets", async () => {
    for (const idempotent of [true, false]) {
      const c = clock()
      const file = join(tmp(), "receipts.json")
      const first = openStore(file, c)
      await first.insertPending(pendingInput({ occurrenceId: "exit:pending" }))

      const { target, run } = makeTarget(
        idempotent,
        async () => ({ ok: true, outcomeRef: "reconciled" }),
      )
      const second = openStore(file, c)
      const secondRunner = createReactionRunner({
        bus: createSessionEventBus(),
        store: second,
        bindings: [makeBinding({ target })],
        nowMs: c.now,
        log: () => {},
      })
      await secondRunner.reconcileOnBoot()

      expect(run).toHaveBeenCalledTimes(1)
      const receipt = second.get(keyOf("exit:pending"))
      expect(receipt?.status).toBe("done")
      expect(receipt?.attempt).toBe(1)
      second.flushSync()

      const third = openStore(file, c)
      const thirdTarget = makeTarget(idempotent)
      const thirdRunner = createReactionRunner({
        bus: createSessionEventBus(),
        store: third,
        bindings: [makeBinding({ target: thirdTarget.target })],
        nowMs: c.now,
        log: () => {},
      })
      await thirdRunner.reconcileOnBoot()
      expect(thirdTarget.run).not.toHaveBeenCalled()
      expect(third.get(keyOf("exit:pending"))?.status).toBe("done")
    }
  })

  it("restart B: a running receipt is re-driven only for an idempotent target", async () => {
    {
      const c = clock()
      const file = join(tmp(), "receipts.json")
      const first = openStore(file, c)
      await first.insertPending(pendingInput({ occurrenceId: "exit:running" }))
      await first.markRunning(keyOf("exit:running"))

      const { target, run } = makeTarget(true, async () => ({ ok: true, outcomeRef: "redriven" }))
      const second = openStore(file, c)
      const runner = createReactionRunner({
        bus: createSessionEventBus(),
        store: second,
        bindings: [makeBinding({ target })],
        nowMs: c.now,
        log: () => {},
      })
      await runner.reconcileOnBoot()

      expect(run).toHaveBeenCalledTimes(1)
      const receipt = second.get(keyOf("exit:running"))
      expect(receipt?.status).toBe("done")
      expect(receipt?.attempt).toBe(2)
    }

    {
      const c = clock()
      const file = join(tmp(), "receipts.json")
      const first = openStore(file, c)
      await first.insertPending(pendingInput({ occurrenceId: "exit:running" }))
      await first.markRunning(keyOf("exit:running"))

      const { target, run } = makeTarget(false)
      const second = openStore(file, c)
      const runner = createReactionRunner({
        bus: createSessionEventBus(),
        store: second,
        bindings: [makeBinding({ target })],
        nowMs: c.now,
        log: () => {},
      })
      await runner.reconcileOnBoot()

      expect(run).not.toHaveBeenCalled()
      expect(runner.status()[0]?.running).toBe(1)
      expect(second.get(keyOf("exit:running"))?.status).toBe("running")
    }
  })

  it("marks a pending receipt dead when its trigger is stale, without running", async () => {
    const c = clock()
    const file = join(tmp(), "receipts.json")
    const store = openStore(file, c)
    await store.insertPending(pendingInput({ occurrenceId: "exit:stale" }))
    const { target, run } = makeTarget()
    const runner = createReactionRunner({
      bus: createSessionEventBus(),
      store,
      bindings: [makeBinding({ target, isTriggerValid: async () => false })],
      nowMs: c.now,
      log: () => {},
    })

    await runner.reconcileOnBoot()

    expect(run).not.toHaveBeenCalled()
    const receipt = store.get(keyOf("exit:stale"))
    expect(receipt?.status).toBe("dead")
    expect(receipt?.lastError).toBe("stale_trigger")
  })

  it("moves a failed receipt at cap to dead at boot and leaves one not yet due alone", async () => {
    const c = clock()
    const cappedFile = join(tmp(), "receipts.json")
    const cappedKey = keyOf("exit:capped")
    const cappedRow: ReactionReceipt = {
      receiptKey: cappedKey,
      sessionId: "sess-1",
      event: EVENT,
      occurrenceId: "exit:capped",
      bindingId: "bind-1",
      actionId: "brain:ingest",
      configRevision: "cfg-1",
      status: "failed",
      attempt: 1,
      maxAttempts: 1,
      nextAttemptAt: c.now() + 1_000,
      lastError: "old failure",
      createdAt: c.now() - 10,
      lastAttemptAt: c.now() - 5,
      reactionDepth: 0,
      redaction: "url-v1",
    }
    writeFileSync(cappedFile, JSON.stringify({ [cappedKey]: cappedRow }) + "\n")
    const cappedStore = openStore(cappedFile, c)
    const cappedTarget = makeTarget()
    const cappedRunner = createReactionRunner({
      bus: createSessionEventBus(),
      store: cappedStore,
      bindings: [makeBinding({ target: cappedTarget.target })],
      nowMs: c.now,
      log: () => {},
    })
    await cappedRunner.reconcileOnBoot()
    expect(cappedTarget.run).not.toHaveBeenCalled()
    const capped = cappedStore.get(cappedKey)
    expect(capped?.status).toBe("dead")
    expect(capped?.lastError).toBe("max_attempts")

    const dueFile = join(tmp(), "receipts.json")
    const dueStore = openStore(dueFile, c)
    await dueStore.insertPending(pendingInput({ occurrenceId: "exit:notdue" }))
    await dueStore.markRunning(keyOf("exit:notdue"))
    await dueStore.markFailed(keyOf("exit:notdue"), "later", c.now() + 60_000)
    const dueTarget = makeTarget()
    const dueRunner = createReactionRunner({
      bus: createSessionEventBus(),
      store: dueStore,
      bindings: [makeBinding({ target: dueTarget.target })],
      nowMs: c.now,
      log: () => {},
    })
    await dueRunner.reconcileOnBoot()

    expect(dueTarget.run).not.toHaveBeenCalled()
    const notDue = dueStore.get(keyOf("exit:notdue"))
    expect(notDue?.status).toBe("failed")
    expect(notDue?.nextAttemptAt).toBe(c.now() + 60_000)
  })

  it("leaves receipts of an unknown binding untouched and logs it once", async () => {
    const c = clock()
    const file = join(tmp(), "receipts.json")
    const store = openStore(file, c)
    await store.insertPending(pendingInput({ occurrenceId: "exit:ghost1", bindingId: "ghost" }))
    await store.insertPending(pendingInput({ occurrenceId: "exit:ghost2", bindingId: "ghost" }))
    const logs: string[] = []
    const { target, run } = makeTarget()
    const runner = createReactionRunner({
      bus: createSessionEventBus(),
      store,
      bindings: [makeBinding({ target })],
      nowMs: c.now,
      log: line => logs.push(line),
    })

    await runner.reconcileOnBoot()

    expect(run).not.toHaveBeenCalled()
    expect(store.get(keyOf("exit:ghost1", "ghost"))?.status).toBe("pending")
    expect(store.get(keyOf("exit:ghost2", "ghost"))?.status).toBe("pending")
    expect(logs.filter(line => line.includes("unknown binding ghost")).length).toBe(1)
  })

  it("maxConcurrent 1 keeps two occurrences from overlapping", async () => {
    let inFlight = 0
    let maxInFlight = 0
    let enteredCount = 0
    let notifyEntered: (() => void) | undefined
    const releases: Array<() => void> = []
    const run = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      enteredCount += 1
      notifyEntered?.()
      notifyEntered = undefined
      await new Promise<void>(resolve => {
        releases.push(resolve)
      })
      inFlight -= 1
      return { ok: true, outcomeRef: "ref" }
    })
    const target: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: run as unknown as ReactionTarget["run"],
    }
    const { runner } = setup({ bindings: [makeBinding({ target })], maxConcurrent: 1 })

    const firstEntered = new Promise<void>(resolve => {
      notifyEntered = resolve
    })
    const firstEvent = completed({ occurrenceId: "exit:a" })
    const secondEvent = completed({ occurrenceId: "exit:b" })
    const first = runner.handleEvent(firstEvent, "exit:a")
    const second = runner.handleEvent(secondEvent, "exit:b")

    await firstEntered
    expect(enteredCount).toBe(1)
    expect(maxInFlight).toBe(1)

    const secondEntered = new Promise<void>(resolve => {
      notifyEntered = resolve
    })
    releases.shift()?.()
    await secondEntered
    expect(maxInFlight).toBe(1)
    releases.shift()?.()
    await Promise.all([first, second])

    expect(run).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBe(1)
  })

  it("a throwing isTriggerValid or a throwing bus consumer does not propagate", async () => {
    const c = clock()
    const file = join(tmp(), "receipts.json")
    const store = openStore(file, c)
    await store.insertPending(pendingInput({ occurrenceId: "exit:trigger" }))
    const triggerTarget = makeTarget()
    const triggerRunner = createReactionRunner({
      bus: createSessionEventBus(),
      store,
      bindings: [
        makeBinding({
          target: triggerTarget.target,
          isTriggerValid: () => {
            throw new Error("trigger check exploded")
          },
        }),
      ],
      nowMs: c.now,
      log: () => {},
    })
    await expect(triggerRunner.reconcileOnBoot()).resolves.toBeUndefined()
    expect(triggerTarget.run).not.toHaveBeenCalled()

    const bus = createSessionEventBus()
    const consumerTarget = makeTarget()
    const busRunner = createReactionRunner({
      bus,
      store: openStore(join(tmp(), "receipts.json"), c),
      bindings: [
        makeBinding({
          target: consumerTarget.target,
          occurrenceIdOf: () => {
            throw new Error("consumer exploded")
          },
        }),
      ],
      nowMs: c.now,
      log: () => {},
    })
    busRunner.start()
    expect(() => bus.emit(completed())).not.toThrow()
    busRunner.stop()
  })

  it("starts and stops the retry tick idempotently", async () => {
    const c = clock()
    const file = join(tmp(), "receipts.json")
    const store = openStore(file, c)
    const key = keyOf("exit:tick")
    await store.insertPending(pendingInput({ occurrenceId: "exit:tick" }))
    await store.markRunning(key)
    await store.markFailed(key, "retry me", c.now())

    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve
    })
    const run = vi.fn(async () => {
      notifyStarted?.()
      return { ok: true, outcomeRef: "tick-ref" }
    })
    const target: ReactionTarget = {
      actionId: "brain:ingest",
      idempotent: true,
      run: run as unknown as ReactionTarget["run"],
    }

    let intervalCallback: (() => void) | undefined
    const handle = { fake: true } as unknown as ReturnType<typeof setInterval>
    const setIntervalMock = vi.fn((callback: () => void, _ms: number) => {
      intervalCallback = callback
      return handle
    })
    const clearIntervalMock = vi.fn()
    const bus = createSessionEventBus()
    const runner = createReactionRunner({
      bus,
      store,
      bindings: [makeBinding({ target })],
      nowMs: c.now,
      retryIntervalMs: 1_234,
      setInterval: setIntervalMock as unknown as typeof setInterval,
      clearInterval: clearIntervalMock as unknown as typeof clearInterval,
      log: () => {},
    })

    runner.start()
    runner.start()
    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    expect(setIntervalMock.mock.calls[0]?.[1]).toBe(1_234)
    expect(intervalCallback).toBeDefined()

    intervalCallback?.()
    await started
    await flush()
    expect(store.get(key)?.status).toBe("done")

    runner.stop()
    expect(clearIntervalMock).toHaveBeenCalledTimes(1)
    const rowsBefore = store.rows().length
    bus.emit(completed({ occurrenceId: "exit:after-stop" }))
    await flush()
    expect(store.rows().length).toBe(rowsBefore)
  })
})
