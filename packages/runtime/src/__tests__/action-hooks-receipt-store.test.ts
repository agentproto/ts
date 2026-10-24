/**
 * ReactionReceiptStore: durable creation, the pending/running/done/failed/dead
 * state machine, redaction, retention and load validation. Every test drives an
 * injected clock; none sleeps.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildReactionReceiptKey,
  createReactionReceiptStore,
  ReceiptTransitionError,
  RECEIPT_REDACTION_REVISION,
  type NewReactionReceipt,
  type ReactionReceiptKey,
  type ReactionReceiptStore,
  type ReactionReceiptStoreOptions,
} from "../action-hooks/index.js"

const realSetTimeout = setTimeout

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise<void>(resolve => realSetTimeout(resolve, 5))
  }
  throw new Error("condition was not met in time")
}

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "receipts-"))
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
    set: (value: number): void => {
      t = value
    },
  }
}

const parts = (over: Partial<ReactionReceiptKey> = {}): ReactionReceiptKey => ({
  sessionId: "sess-1",
  event: "session:exited",
  occurrenceId: "exit:1",
  bindingId: "bind-1",
  ...over,
})
const keyOf = (over: Partial<ReactionReceiptKey> = {}): string => buildReactionReceiptKey(parts(over))
const input = (over: Partial<NewReactionReceipt> = {}): NewReactionReceipt => ({
  ...parts(),
  actionId: "session:spawn",
  configRevision: "cfg-1",
  maxAttempts: 3,
  reactionDepth: 0,
  ...over,
})

function setup(over: Partial<ReactionReceiptStoreOptions> = {}) {
  const dir = tmp()
  const file = join(dir, "receipts.json")
  const c = clock()
  const logs: string[] = []
  const store = createReactionReceiptStore({
    filePath: file,
    nowMs: c.now,
    debounceMs: 60_000,
    log: line => logs.push(line),
    ...over,
  })
  return { dir, file, c, logs, store }
}

function reopen(file: string, c: ReturnType<typeof clock>, over: Partial<ReactionReceiptStoreOptions> = {}) {
  return createReactionReceiptStore({ filePath: file, nowMs: c.now, debounceMs: 60_000, log: () => {}, ...over })
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    return (err as ReceiptTransitionError).code
  }
  throw new Error("expected the promise to reject")
}

const readRows = (file: string): Record<string, { status: string; completedAt?: number; outcomeRef?: string }> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    { status: string; completedAt?: number; outcomeRef?: string }
  >

describe("ReactionReceiptStore", () => {
  it("insertPending is durable before it resolves: a fresh store sees the pending row", async () => {
    const { file, c, store } = setup()
    await store.insertPending(input())
    // The first instance is abandoned without flushSync, like a crash.
    const second = reopen(file, c)
    const row = second.get(keyOf())
    expect(row?.status).toBe("pending")
    expect(row?.attempt).toBe(0)
    expect(second.rows()).toHaveLength(1)
  })

  it("writes pretty JSON with a trailing newline at mode 0600", async () => {
    const { file, store } = setup()
    await store.insertPending(input())
    const raw = readFileSync(file, "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + "\n")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const row = readRows(file)[keyOf()] as unknown as { redaction: string; status: string }
    expect(row.status).toBe("pending")
    expect(row.redaction).toBe(RECEIPT_REDACTION_REVISION)
  })

  it("dedupes sequential and concurrent insertPending calls and never resets a running row", async () => {
    const { store } = setup()
    const first = await store.insertPending(input())
    const second = await store.insertPending(input())
    expect(second).toEqual(first)

    const concurrentKey = keyOf({ bindingId: "bind-2" })
    const [left, right] = await Promise.all([
      store.insertPending(input({ bindingId: "bind-2" })),
      store.insertPending(input({ bindingId: "bind-2" })),
    ])
    expect(left.receiptKey).toBe(concurrentKey)
    expect(right).toEqual(left)
    expect(store.rows()).toHaveLength(2)

    await store.markRunning(keyOf())
    const whileRunning = await store.insertPending(input())
    expect(whileRunning.status).toBe("running")
    expect(whileRunning.attempt).toBe(1)
    expect(store.rows()).toHaveLength(2)
  })

  it("rejects a bad key segment and writes nothing", async () => {
    const { file, store } = setup()
    await expect(store.insertPending(input({ sessionId: "bad/id" }))).rejects.toThrow(/Invalid occurrence key/)
    expect(store.rows()).toHaveLength(0)
    expect(existsSync(file)).toBe(false)
  })

  it("insertPending whose persist fails rejects and leaves no row in memory", async () => {
    const dir = tmp()
    const blocker = join(dir, "blocked")
    writeFileSync(blocker, "not a directory")
    const store = createReactionReceiptStore({
      filePath: join(blocker, "receipts.json"),
      nowMs: clock().now,
      debounceMs: 60_000,
      log: () => {},
    })
    await expect(store.insertPending(input())).rejects.toThrow()
    expect(store.rows()).toHaveLength(0)
  })

  it("markRunning is durable: a fresh store sees running, attempt 1 and the injected start time", async () => {
    const { file, c, store } = setup()
    await store.insertPending(input())
    c.advance(5_000)
    await store.markRunning(keyOf())
    const second = reopen(file, c)
    const row = second.get(keyOf())
    expect(row?.status).toBe("running")
    expect(row?.attempt).toBe(1)
    expect(row?.startedAt).toBe(1_005_000)
  })

  it("concurrent markRunning has exactly one winner; redrive is the explicit exception", async () => {
    const { store } = setup()
    await store.insertPending(input())
    const results = await Promise.allSettled([store.markRunning(keyOf()), store.markRunning(keyOf())])
    const fulfilled = results.filter(r => r.status === "fulfilled")
    const rejected = results.filter(r => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason
    expect(reason).toBeInstanceOf(ReceiptTransitionError)
    expect((reason as ReceiptTransitionError).code).toBe("already_running")

    await store.markRunning(keyOf(), { redrive: true })
    expect(store.get(keyOf())?.attempt).toBe(2)
  })

  it("markRunning rejects terminal done/dead rows and unknown keys with distinct codes", async () => {
    const { store } = setup()
    const doneKey = keyOf({ occurrenceId: "done" })
    await store.insertPending(input({ occurrenceId: "done" }))
    await store.markRunning(doneKey)
    await store.markDone(doneKey, undefined)
    expect(await codeOf(store.markRunning(doneKey))).toBe("terminal")

    const deadKey = keyOf({ occurrenceId: "dead" })
    await store.insertPending(input({ occurrenceId: "dead" }))
    await store.markDead(deadKey, "non-retryable")
    expect(await codeOf(store.markRunning(deadKey))).toBe("terminal")

    expect(await codeOf(store.markRunning("sess-1/session:exited/missing/bind-1"))).toBe("not_found")
  })

  it("markRunning whose persist fails restores status, attempt and startedAt and rethrows", async () => {
    const dir = tmp()
    const nested = join(dir, "nested")
    const file = join(nested, "receipts.json")
    const c = clock()
    const store = createReactionReceiptStore({ filePath: file, nowMs: c.now, debounceMs: 60_000, log: () => {} })
    await store.insertPending(input())
    // Break the parent so the next durable write fails.
    rmSync(nested, { recursive: true, force: true })
    writeFileSync(nested, "not a directory")
    c.advance(1_000)
    await expect(store.markRunning(keyOf())).rejects.toThrow()
    const row = store.get(keyOf())
    expect(row?.status).toBe("pending")
    expect(row?.attempt).toBe(0)
    expect(row?.startedAt).toBeUndefined()
  })

  it("markDone sets completedAt and outcomeRef and is debounced until flushSync or the timer", async () => {
    vi.useFakeTimers()
    try {
      const { file, c, store } = setup()
      const timerKey = keyOf({ occurrenceId: "timer" })
      await store.insertPending(input({ occurrenceId: "timer" }))
      await store.markRunning(timerKey)
      c.advance(1_000)
      await store.markDone(timerKey, "outcome:timer")
      expect(readRows(file)[timerKey]!.status).toBe("running")
      await vi.runAllTimersAsync()
      await waitFor(() => readRows(file)[timerKey]?.status === "done")
      const persisted = readRows(file)[timerKey]!
      expect(persisted.status).toBe("done")
      expect(persisted.completedAt).toBe(c.now())
      expect(persisted.outcomeRef).toBe("outcome:timer")

      const flushKey = keyOf({ occurrenceId: "flush" })
      await store.insertPending(input({ occurrenceId: "flush" }))
      await store.markRunning(flushKey)
      await store.markDone(flushKey, undefined)
      expect(readRows(file)[flushKey]!.status).toBe("running")
      store.flushSync()
      expect(readRows(file)[flushKey]!.status).toBe("done")
    } finally {
      vi.useRealTimers()
    }
  })

  it("markDone from pending rejects not_running", async () => {
    const { store } = setup()
    await store.insertPending(input())
    expect(await codeOf(store.markDone(keyOf(), undefined))).toBe("not_running")
  })

  it("markFailed below the cap redacts the URL and schedules a retry that markRunning accepts", async () => {
    const { c, store } = setup()
    await store.insertPending(input())
    await store.markRunning(keyOf())
    c.advance(1_000)
    const retryAt = c.now() + 30_000
    await store.markFailed(keyOf(), "target failed at https://host.example/path?token=SECRET", retryAt)
    const row = store.get(keyOf())
    expect(row?.status).toBe("failed")
    expect(row?.lastError).not.toContain("SECRET")
    expect(row?.lastError).not.toContain("/path")
    expect(row?.lastError).toContain("https://host.example")
    expect(row?.lastAttemptAt).toBe(c.now())
    expect(row?.nextAttemptAt).toBe(retryAt)

    c.advance(30_000)
    await store.markRunning(keyOf())
    expect(store.get(keyOf())?.status).toBe("running")
    expect(store.get(keyOf())?.attempt).toBe(2)
    expect(store.get(keyOf())?.nextAttemptAt).toBeUndefined()
  })

  it("markFailed at the attempt cap moves the row to dead durably with completedAt", async () => {
    const { file, c, store } = setup()
    await store.insertPending(input({ maxAttempts: 1 }))
    await store.markRunning(keyOf())
    c.advance(2_000)
    await store.markFailed(keyOf(), "exhausted", undefined)
    const second = reopen(file, c)
    const row = second.get(keyOf())
    expect(row?.status).toBe("dead")
    expect(row?.completedAt).toBe(1_002_000)
    expect(row?.nextAttemptAt).toBeUndefined()
  })

  it("markDead whose durable write fails restores the running row and can be retried", async () => {
    const dir = tmp()
    const nested = join(dir, "nested")
    const file = join(nested, "receipts.json")
    const c = clock()
    const store = createReactionReceiptStore({ filePath: file, nowMs: c.now, debounceMs: 60_000, log: () => {} })
    await store.insertPending(input())
    await store.markRunning(keyOf())
    rmSync(nested, { recursive: true, force: true })
    writeFileSync(nested, "not a directory")
    c.advance(1_000)
    await expect(store.markDead(keyOf(), "recursion_cap")).rejects.toThrow()
    const row = store.get(keyOf())
    expect(row?.status).toBe("running")
    expect(row?.completedAt).toBeUndefined()
    expect(row?.lastError).toBeUndefined()

    rmSync(nested, { force: true })
    mkdirSync(nested)
    await store.markDead(keyOf(), "recursion_cap")
    const second = reopen(file, c)
    expect(second.get(keyOf())?.status).toBe("dead")
  })

  it("markFailed at the cap whose durable write fails restores running and the retry commits dead", async () => {
    const dir = tmp()
    const nested = join(dir, "nested")
    const file = join(nested, "receipts.json")
    const c = clock()
    const store = createReactionReceiptStore({ filePath: file, nowMs: c.now, debounceMs: 60_000, log: () => {} })
    await store.insertPending(input({ maxAttempts: 1 }))
    await store.markRunning(keyOf())
    rmSync(nested, { recursive: true, force: true })
    writeFileSync(nested, "not a directory")
    c.advance(1_000)
    await expect(store.markFailed(keyOf(), "exhausted", undefined)).rejects.toThrow()
    const row = store.get(keyOf())
    expect(row?.status).toBe("running")
    expect(row?.completedAt).toBeUndefined()
    expect(row?.lastError).toBeUndefined()

    rmSync(nested, { force: true })
    mkdirSync(nested)
    await store.markFailed(keyOf(), "exhausted", undefined)
    expect(store.get(keyOf())?.status).toBe("dead")
    const second = reopen(file, c)
    expect(second.get(keyOf())?.status).toBe("dead")
  })

  it("markDead is durable and idempotent and terminal rows never come back", async () => {
    const { file, c, store } = setup()
    await store.insertPending(input())
    await store.markDead(keyOf(), "recursion_cap")
    const second = reopen(file, c)
    expect(second.get(keyOf())?.status).toBe("dead")
    await store.markDead(keyOf(), "recursion_cap")
    expect(store.get(keyOf())?.lastError).toBe("recursion_cap")
    expect(await codeOf(store.markRunning(keyOf()))).toBe("terminal")
  })

  it("sweep reaps old done rows, keeps young done and dead rows, and ages out non-terminal rows", async () => {
    const dir = tmp()
    const file = join(dir, "receipts.json")
    const c = clock(1_001_000)
    const store = createReactionReceiptStore({
      filePath: file,
      nowMs: c.now,
      debounceMs: 60_000,
      doneReapMs: 100_000,
      nonTerminalAgeOutMs: 200_000,
      log: () => {},
    })
    const finish = async (occurrenceId: string): Promise<string> => {
      const key = keyOf({ occurrenceId })
      await store.insertPending(input({ occurrenceId }))
      await store.markRunning(key)
      await store.markDone(key, undefined)
      return key
    }

    const doneOld = await finish("done-old")
    c.set(1_500_000)
    const deadRow = keyOf({ occurrenceId: "dead-row" })
    await store.insertPending(input({ occurrenceId: "dead-row" }))
    await store.markDead(deadRow, "stop")
    c.set(1_800_000)
    const pendingOld = keyOf({ occurrenceId: "pending-old" })
    await store.insertPending(input({ occurrenceId: "pending-old" }))
    c.set(2_000_000)
    const pendingYoung = keyOf({ occurrenceId: "pending-young" })
    await store.insertPending(input({ occurrenceId: "pending-young" }))
    c.set(2_050_000)
    const doneYoung = await finish("done-young")

    c.set(2_100_000)
    store.sweep()

    expect(store.get(doneOld)).toBeUndefined()
    expect(store.get(doneYoung)?.status).toBe("done")
    expect(store.get(deadRow)?.status).toBe("dead")
    const aged = store.get(pendingOld)
    expect(aged?.status).toBe("dead")
    expect(aged?.lastError).toBe("age_out")
    expect(aged?.completedAt).toBe(2_100_000)
    expect(store.get(pendingYoung)?.status).toBe("pending")
  })

  it("sweep evicts the oldest terminal rows until the row cap holds", async () => {
    const dir = tmp()
    const file = join(dir, "receipts.json")
    const c = clock(1_000_000)
    const big = createReactionReceiptStore({
      filePath: file,
      nowMs: c.now,
      debounceMs: 60_000,
      rowCap: 100,
      log: () => {},
    })
    const keys: string[] = []
    for (let i = 0; i < 5; i++) {
      c.set(1_000_000 + i * 10_000)
      const key = keyOf({ occurrenceId: `cap-${i}` })
      await big.insertPending(input({ occurrenceId: `cap-${i}` }))
      await big.markRunning(key)
      await big.markDone(key, undefined)
      keys.push(key)
    }
    big.flushSync()

    const small = createReactionReceiptStore({
      filePath: file,
      nowMs: c.now,
      debounceMs: 60_000,
      rowCap: 3,
      log: () => {},
    })
    expect(small.rows()).toHaveLength(5)
    small.sweep()
    expect(small.rows()).toHaveLength(3)
    expect(small.get(keys[0]!)).toBeUndefined()
    expect(small.get(keys[1]!)).toBeUndefined()
    expect(small.get(keys[2]!)).toBeDefined()
    expect(small.get(keys[3]!)).toBeDefined()
    expect(small.get(keys[4]!)).toBeDefined()
  })

  it("load drops rows with a stale key or a bogus status and keeps the valid row", async () => {
    const dir = tmp()
    const file = join(dir, "receipts.json")
    const c = clock()
    const seed = createReactionReceiptStore({ filePath: file, nowMs: c.now, debounceMs: 60_000, log: () => {} })
    await seed.insertPending(input())
    const validKey = keyOf()
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>
    const valid = parsed[validKey]
    const stale = { ...valid, receiptKey: "sess-1/session:exited/other/bind-1" }
    const bogus = { ...valid, receiptKey: "sess-1/session:exited/bogus-row/bind-1", occurrenceId: "bogus-row", status: "bogus" }
    writeFileSync(file, JSON.stringify({ stale, bogus, valid }, null, 2) + "\n")

    const logs: string[] = []
    const store = createReactionReceiptStore({
      filePath: file,
      nowMs: c.now,
      debounceMs: 60_000,
      log: line => logs.push(line),
    })
    expect(store.rows()).toHaveLength(1)
    expect(store.get(validKey)?.status).toBe("pending")
    expect(logs.filter(line => line.includes("dropped invalid row"))).toHaveLength(2)
  })

  it("load drops rows whose optional fields have the wrong type", async () => {
    const dir = tmp()
    const file = join(dir, "receipts.json")
    const c = clock()
    const seed = createReactionReceiptStore({ filePath: file, nowMs: c.now, debounceMs: 60_000, log: () => {} })
    await seed.insertPending(input())
    const validKey = keyOf()
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>
    const valid = parsed[validKey]
    const badCompleted = {
      ...valid,
      receiptKey: keyOf({ occurrenceId: "bad-completed" }),
      occurrenceId: "bad-completed",
      completedAt: "x",
    }
    const badError = {
      ...valid,
      receiptKey: keyOf({ occurrenceId: "bad-error" }),
      occurrenceId: "bad-error",
      lastError: 42,
    }
    writeFileSync(file, JSON.stringify({ [validKey]: valid, badCompleted, badError }, null, 2) + "\n")

    const logs: string[] = []
    const store = createReactionReceiptStore({
      filePath: file,
      nowMs: c.now,
      debounceMs: 60_000,
      log: line => logs.push(line),
    })
    expect(store.rows()).toHaveLength(1)
    expect(store.get(validKey)?.status).toBe("pending")
    expect(logs.filter(line => line.includes("dropped invalid row"))).toHaveLength(2)
  })

  it("get and rows return copies, not the live rows", async () => {
    const { store } = setup()
    await store.insertPending(input())
    const returned = store.get(keyOf())
    expect(returned).toBeDefined()
    returned!.status = "dead"
    returned!.sessionId = "mutated"
    expect(store.get(keyOf())?.status).toBe("pending")
    expect(store.get(keyOf())?.sessionId).toBe("sess-1")

    const list = store.rows()
    list[0]!.status = "dead"
    list.pop()
    expect(store.rows()).toHaveLength(1)
    expect(store.rows()[0]!.status).toBe("pending")
  })

  it("persists by default to the AGENTPROTO_HOME receipt file without an explicit filePath", async () => {
    const dir = tmp()
    const previous = process.env.AGENTPROTO_HOME
    process.env.AGENTPROTO_HOME = dir
    try {
      const store = createReactionReceiptStore({
        nowMs: clock().now,
        debounceMs: 60_000,
        log: () => {},
      })
      await store.insertPending(input())
      const expected = join(dir, "reaction-receipts.json")
      expect(store.path).toBe(expected)
      expect(existsSync(expected)).toBe(true)
      expect(readRows(expected)[keyOf()]!.status).toBe("pending")
    } finally {
      if (previous === undefined) delete process.env.AGENTPROTO_HOME
      else process.env.AGENTPROTO_HOME = previous
    }
  })

  it("persist:false never creates the file", async () => {
    const dir = tmp()
    const file = join(dir, "receipts.json")
    const store: ReactionReceiptStore = createReactionReceiptStore({
      filePath: file,
      persist: false,
      nowMs: clock().now,
      debounceMs: 60_000,
      log: () => {},
    })
    await store.insertPending(input())
    expect(store.rows()).toHaveLength(1)
    expect(existsSync(file)).toBe(false)
  })
})
