/**
 * ReactionRunner.health(): the synchronous read model over receipt rows and
 * the in-memory skip counters. Real runner, real receipt store, injected clock.
 */

import { describe, expect, it } from "vitest"

import { createSessionEventBus, type SessionCompletedEvent, type SessionEvent } from "../session-event-bus.js"
import {
  createReactionReceiptStore,
  createReactionRunner,
  type ReactionBinding,
  type ReactionReceiptStore,
  type ReactionRunnerOptions,
} from "../action-hooks/index.js"

const EVENT = "agentproto:session-completed"

function clock(start = 1_000_000): { now: () => number; set: (t: number) => void; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    set: value => {
      t = value
    },
    advance: ms => {
      t += ms
    },
  }
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

function makeBinding(over: Partial<ReactionBinding> = {}): ReactionBinding {
  return {
    bindingId: "bind-a",
    event: EVENT,
    actionId: "brain:ingest",
    configRevision: "cfg-1",
    maxAttempts: 3,
    reactionDepth: 0,
    occurrenceIdOf: (event: SessionEvent) =>
      event.type === EVENT ? (event as SessionCompletedEvent).occurrenceId : undefined,
    target: { actionId: "brain:ingest", idempotent: true, run: async () => ({ ok: true }) },
    ...over,
  }
}

async function insert(
  store: ReactionReceiptStore,
  bindingId: string,
  occurrenceId: string,
  over: { createdAt?: number; reactionDepth?: number } = {},
): Promise<string> {
  const row = await store.insertPending({
    sessionId: "sess-1",
    event: EVENT,
    occurrenceId,
    bindingId,
    actionId: "brain:ingest",
    configRevision: "cfg-1",
    maxAttempts: 3,
    reactionDepth: over.reactionDepth ?? 0,
    ...(over.createdAt !== undefined ? { createdAt: over.createdAt } : {}),
  })
  return row.receiptKey
}

async function doneAfter(
  store: ReactionReceiptStore,
  c: ReturnType<typeof clock>,
  key: string,
  base: number,
  durationMs: number,
): Promise<void> {
  c.set(base)
  await store.markRunning(key)
  c.set(base + durationMs)
  await store.markDone(key, undefined)
}

describe("reaction runner health", () => {
  it("reads counts, queue age, latency, depth, retries, dead reasons, orphans, skips and leaves status unchanged", async () => {
    const c = clock(1_000_000)
    const store = createReactionReceiptStore({ persist: false, nowMs: c.now, log: () => {} })
    const bus = createSessionEventBus()
    const bindA = makeBinding()
    const bindB = makeBinding({ bindingId: "bind-b" })
    const bindSkip = makeBinding({
      bindingId: "bind-skip",
      shouldHandle: () => false,
    })
    const options: ReactionRunnerOptions = {
      bus,
      store,
      bindings: [bindSkip],
      nowMs: c.now,
      log: () => {},
      trace: () => {},
    }
    const runner = createReactionRunner(options)

    await runner.handleEvent(completed({ occurrenceId: "exit:skip" }), "exit:skip")
    expect(runner.health().bindings).toEqual([
      {
        bindingId: "bind-skip",
        event: EVENT,
        counts: { pending: 0, running: 0, done: 0, failed: 0, dead: 0 },
        maxDepth: 0,
        retries: 0,
        deadReasons: {},
        skipped: 1,
      },
    ])

    const pendingKey = await insert(store, "bind-a", "exit:pending", { createdAt: 1_000 })
    c.set(1_000)
    const failedKey = await insert(store, "bind-a", "exit:failed", { createdAt: 900 })
    c.set(1_500)
    await store.markRunning(failedKey)
    c.set(1_600)
    await store.markFailed(failedKey, "retry me", 9_999)

    const doneKeys: string[] = []
    const durations = [10, 20, 30, 40, 100]
    for (let i = 0; i < durations.length; i++) {
      const key = await insert(store, "bind-a", `exit:done-${i}`, { createdAt: 10_000 + i * 10_000 })
      doneKeys.push(key)
      await doneAfter(store, c, key, 10_000 + i * 10_000 + 5, durations[i] as number)
    }

    const depthKey = await insert(store, "bind-a", "exit:depth", {
      createdAt: 50_000,
      reactionDepth: 3,
    })
    c.set(50_000)
    await store.markRunning(depthKey)
    c.set(50_010)
    await store.markFailed(depthKey, "first", 99_999)
    c.set(50_020)
    await store.markRunning(depthKey)
    c.set(50_030)
    await store.markFailed(depthKey, "second", 99_999)
    c.set(50_040)
    await store.markRunning(depthKey)
    c.set(50_140)
    await store.markDone(depthKey, undefined)

    const backwardsKey = await insert(store, "bind-a", "exit:backwards", { createdAt: 60_000 })
    c.set(60_000)
    await store.markRunning(backwardsKey)
    c.set(59_000)
    await store.markDone(backwardsKey, undefined)

    const recursionKey = await insert(store, "bind-a", "exit:recursion", {
      createdAt: 70_000,
      reactionDepth: 4,
    })
    c.set(70_000)
    await store.markDead(recursionKey, "recursion_cap")

    const exhaustedKey = await insert(store, "bind-a", "exit:exhausted", { createdAt: 80_000 })
    c.set(80_000)
    await store.markDead(exhaustedKey, "max_attempts")

    const bKey = await insert(store, "bind-b", "exit:b", { createdAt: 90_000 })
    await doneAfter(store, c, bKey, 90_000, 50)

    await insert(store, "bind-orphan", "exit:orphan", { createdAt: 85_000 })

    c.set(90_050)
    const before = store.rows()
    const health = runner.health()
    expect(store.rows()).toEqual(before)

    expect(health.generatedAt).toBe(90_050)
    expect(health.started).toBe(false)
    expect(health.maxReactionDepth).toBe(4)
    expect(health.maxConcurrent).toBe(4)
    expect(health.totals).toEqual({
      receipts: 13,
      pending: 2,
      running: 0,
      done: 8,
      failed: 1,
      dead: 2,
    })
    expect(health.bindings.map(binding => binding.bindingId)).toEqual(["bind-skip"])
    expect(health.bindings[0]?.skipped).toBe(1)

    runner.replaceBindings([bindA, bindB])
    const after = runner.health()
    expect(after.bindings.map(binding => binding.bindingId)).toEqual(["bind-a", "bind-b"])

    const a = after.bindings[0]
    expect(a?.counts).toEqual({ pending: 1, running: 0, done: 7, failed: 1, dead: 2 })
    expect(a?.oldestQueuedAgeMs).toBe(90_050 - 900)
    expect(a?.latencyMs).toEqual({ count: 6, p50: 30, p95: 100, max: 100 })
    expect(a?.maxDepth).toBe(4)
    expect(a?.retries).toBe(2)
    expect(a?.deadReasons).toEqual({ recursion_cap: 1, max_attempts: 1 })
    expect(a?.lastError).toBe("max_attempts")
    expect(a?.skipped).toBe(0)

    const b = after.bindings[1]
    expect(b?.counts).toEqual({ pending: 0, running: 0, done: 1, failed: 0, dead: 0 })
    expect(b?.oldestQueuedAgeMs).toBeUndefined()
    expect(b?.latencyMs).toEqual({ count: 1, p50: 50, p95: 50, max: 50 })
    expect(b?.maxDepth).toBe(0)
    expect(b?.retries).toBe(0)
    expect(b?.deadReasons).toEqual({})
    expect(b?.lastError).toBeUndefined()

    expect(after.orphans).toEqual([
      {
        bindingId: "bind-orphan",
        counts: { pending: 1, running: 0, done: 0, failed: 0, dead: 0 },
      },
    ])
    expect(after.bindings.some(binding => binding.bindingId === "bind-orphan")).toBe(false)

    expect(runner.status()).toEqual([
      { bindingId: "bind-a", pending: 1, running: 0, failed: 1, dead: 2, lastError: "max_attempts" },
      { bindingId: "bind-b", pending: 0, running: 0, failed: 0, dead: 0 },
    ])

    expect(pendingKey).toContain("exit:pending")
    expect(doneKeys).toHaveLength(5)
  })
})
