import { describe, expect, it } from "vitest"
import { createReviewExecutionShare, shareKeyOf } from "../review-execution-share.js"

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms))

/** An execution the test releases by hand. */
function gate<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("createReviewExecutionShare", () => {
  it("three simultaneous acquires of one key run ONE execution (one owner, two joiners)", async () => {
    const share = createReviewExecutionShare()
    const g = gate<string>()
    let executed = 0
    const args = (laneId: string) => ({
      key: "k",
      laneId,
      deadline: Date.now() + 5_000,
      execute: async () => {
        executed++
        return g.promise
      },
      retain: () => true,
    })
    const runs = [share.run(args("a")), share.run(args("b")), share.run(args("c"))]
    await tick()
    expect(share.stats()).toEqual({ inFlight: 1, retained: 0 })
    g.resolve("verdict")
    const [a, b, c] = await Promise.all(runs)
    expect(executed).toBe(1)
    expect([a, b, c].map((r) => (r.kind === "value" ? r.value : "?"))).toEqual(["verdict", "verdict", "verdict"])
    const marks = [a, b, c].map((r) => r.mark)
    expect(marks[0]).toMatchObject({ role: "owner", ownerLane: "a" })
    expect(marks[1]).toMatchObject({ role: "joiner", ownerLane: "a" })
    expect(marks[2]).toMatchObject({ role: "joiner", ownerLane: "a" })
    expect(new Set(marks.map((m) => m?.executionId)).size).toBe(1)
  })

  it("an owner nobody joined carries no mark", async () => {
    const share = createReviewExecutionShare()
    const r = await share.run({ key: "solo", laneId: "a", deadline: Date.now() + 1_000, execute: async () => 1, retain: () => false })
    expect(r).toEqual({ kind: "value", value: 1, mark: undefined })
  })

  it("distinct keys never share", async () => {
    const share = createReviewExecutionShare()
    let executed = 0
    const run = (key: string, laneId: string) =>
      share.run({ key, laneId, deadline: Date.now() + 1_000, execute: async () => ++executed, retain: () => false })
    const rs = await Promise.all([run("k1", "a"), run("k2", "b"), run(shareKeyOf(["x"]), "c")])
    expect(executed).toBe(3)
    expect(rs.every((r) => r.kind === "value" && r.mark === undefined)).toBe(true)
  })

  it("a retained success is reused by a later lane without running again", async () => {
    const share = createReviewExecutionShare()
    let executed = 0
    const args = (laneId: string) => ({
      key: "k",
      laneId,
      deadline: Date.now() + 1_000,
      execute: async () => ({ blocked: true, n: ++executed }),
      retain: () => true,
    })
    await share.run(args("a"))
    const later = await share.run(args("b"))
    expect(executed).toBe(1)
    expect(later).toMatchObject({ kind: "value", value: { blocked: true, n: 1 }, mark: { role: "joiner", ownerLane: "a" } })
    expect(share.stats()).toEqual({ inFlight: 0, retained: 1 })
  })

  it("a failure is shared only with participants already in flight; a later lane runs for itself", async () => {
    const share = createReviewExecutionShare()
    const g = gate<string>()
    let executed = 0
    const args = (laneId: string, work: () => Promise<string>) => ({
      key: "k",
      laneId,
      deadline: Date.now() + 5_000,
      execute: async () => {
        executed++
        return work()
      },
      retain: (v: string) => v === "ok",
    })
    const owner = share.run(args("a", () => g.promise))
    const joiner = share.run(args("b", async () => "never"))
    await tick()
    g.resolve("failed")
    expect(await owner).toMatchObject({ kind: "value", value: "failed" })
    expect(await joiner).toMatchObject({ kind: "value", value: "failed", mark: { role: "joiner" } })
    expect(share.stats()).toEqual({ inFlight: 0, retained: 0 })
    const later = await share.run(args("c", async () => "ok"))
    expect(executed).toBe(2)
    expect(later).toMatchObject({ kind: "value", value: "ok" })
  })

  it("a rejected execution rejects every participant and is forgotten", async () => {
    const share = createReviewExecutionShare()
    const g = gate<string>()
    const args = (laneId: string) => ({ key: "k", laneId, deadline: Date.now() + 5_000, execute: () => g.promise, retain: () => true })
    const a = share.run(args("a"))
    const b = share.run(args("b"))
    await tick()
    g.reject(new Error("boom"))
    await expect(a).rejects.toThrow("boom")
    await expect(b).rejects.toThrow("boom")
    expect(share.stats()).toEqual({ inFlight: 0, retained: 0 })
  })

  it("cancelling the owner does not kill the execution while a joiner still waits", async () => {
    const share = createReviewExecutionShare()
    const g = gate<string>()
    let aborted = false
    const ownerCtl = new AbortController()
    const owner = share.run({
      key: "k",
      laneId: "a",
      signal: ownerCtl.signal,
      deadline: Date.now() + 5_000,
      execute: async (signal) => {
        signal.addEventListener("abort", () => (aborted = true))
        return g.promise
      },
      retain: () => true,
    })
    const joiner = share.run({ key: "k", laneId: "b", deadline: Date.now() + 5_000, execute: async () => "never", retain: () => true })
    await tick()
    ownerCtl.abort()
    expect(await owner).toMatchObject({ kind: "left", why: "cancelled", mark: { role: "owner" } })
    expect(aborted).toBe(false)
    g.resolve("verdict")
    expect(await joiner).toMatchObject({ kind: "value", value: "verdict" })
  })

  it("aborts the execution only when every participant has left, then forgets it", async () => {
    const share = createReviewExecutionShare()
    const ctlA = new AbortController()
    const ctlB = new AbortController()
    let aborted = false
    const cancelled = "cancelled-result"
    const run = (laneId: string, signal: AbortSignal) =>
      share.run({
        key: "k",
        laneId,
        signal,
        deadline: Date.now() + 5_000,
        execute: (execSignal) =>
          new Promise<string>((resolve) => {
            execSignal.addEventListener("abort", () => {
              aborted = true
              resolve(cancelled)
            })
          }),
        retain: () => false,
      })
    const a = run("a", ctlA.signal)
    const b = run("b", ctlB.signal)
    await tick()
    ctlA.abort()
    await tick()
    expect(aborted).toBe(false)
    ctlB.abort()
    // The last one out receives the execution's own cancelled result.
    expect(await b).toMatchObject({ kind: "value", value: cancelled })
    expect(await a).toMatchObject({ kind: "left", why: "cancelled" })
    expect(aborted).toBe(true)
    expect(share.stats()).toEqual({ inFlight: 0, retained: 0 })
  })

  it("a joiner leaves at its own deadline without extending or killing the owner", async () => {
    const share = createReviewExecutionShare()
    const g = gate<string>()
    let aborted = false
    const owner = share.run({
      key: "k",
      laneId: "a",
      deadline: Date.now() + 5_000,
      execute: async (signal) => {
        signal.addEventListener("abort", () => (aborted = true))
        return g.promise
      },
      retain: () => true,
    })
    const joiner = await share.run({ key: "k", laneId: "b", deadline: Date.now() + 30, execute: async () => "never", retain: () => true })
    expect(joiner).toMatchObject({ kind: "left", why: "deadline", mark: { role: "joiner", ownerLane: "a" } })
    expect(aborted).toBe(false)
    g.resolve("verdict")
    expect(await owner).toMatchObject({ kind: "value", value: "verdict" })
  })

  it("an already-aborted participant never starts or joins an execution", async () => {
    const share = createReviewExecutionShare()
    const ctl = new AbortController()
    ctl.abort()
    let executed = 0
    const r = await share.run({ key: "k", laneId: "a", signal: ctl.signal, deadline: Date.now() + 1_000, execute: async () => ++executed, retain: () => true })
    expect(r).toMatchObject({ kind: "left", why: "cancelled" })
    expect(executed).toBe(0)
    expect(share.stats()).toEqual({ inFlight: 0, retained: 0 })
  })

  it("a lane arriving while an abandoned execution winds down starts a fresh one", async () => {
    const share = createReviewExecutionShare()
    const ctl = new AbortController()
    const g = gate<string>()
    let executed = 0
    const first = share.run({
      key: "k",
      laneId: "a",
      signal: ctl.signal,
      deadline: Date.now() + 5_000,
      execute: async () => {
        executed++
        return g.promise
      },
      retain: () => true,
    })
    await tick()
    ctl.abort()
    await tick()
    const second = share.run({ key: "k", laneId: "b", deadline: Date.now() + 5_000, execute: async () => `fresh-${++executed}`, retain: () => true })
    g.resolve("late")
    await first
    expect(await second).toMatchObject({ kind: "value", value: "fresh-2" })
  })
})
