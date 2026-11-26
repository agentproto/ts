import { describe, expect, it } from "vitest"
import { guardVoiceCall, type VoiceBillingGate, type VoiceBalanceDirective, type VoiceEndReason } from "../billing-gate.js"

interface Hold { id: string }

function harness(over: Partial<VoiceBillingGate<Hold, { call: string }>> = {}) {
  const log: string[] = []
  const settled: Array<{ reason: VoiceEndReason; elapsed: number }> = []
  const gate: VoiceBillingGate<Hold, { call: string }> = {
    pollIntervalMs: 10,
    onAuthorize: async () => (log.push("authorize"), { ok: true, hold: { id: "h1" } }),
    onCheckpoint: async () => ({ action: "continue" }),
    onSettle: async (_c, _h, end) => {
      log.push("settle")
      settled.push({ reason: end.reason, elapsed: end.elapsedSeconds })
    },
    ...over,
  }
  return { gate, log, settled }
}

describe("guardVoiceCall", () => {
  it("reserves before the call opens, settles after it ends", async () => {
    const { gate, log, settled } = harness()
    let end!: (r: VoiceEndReason) => void
    const ended = new Promise<VoiceEndReason>(res => (end = res))
    const p = guardVoiceCall(gate, { call: "c" }, {
      start: async () => void log.push("start"),
      close: async () => void log.push("close"),
      ended,
    })
    await new Promise(r => setTimeout(r, 5))
    end("ended")
    const r = await p
    expect(r).toMatchObject({ started: true, endReason: "ended" })
    expect(log).toEqual(["authorize", "start", "close", "settle"])
    expect(settled).toHaveLength(1)
  })

  it("refuses the call when the balance is insufficient: nothing is opened, nothing to settle", async () => {
    const { gate, log } = harness({ onAuthorize: async () => ({ ok: false, reason: "insufficient_funds" }) })
    const r = await guardVoiceCall(gate, { call: "c" }, { start: async () => void log.push("start"), close: async () => void log.push("close") })
    expect(r).toEqual({ started: false, reason: "insufficient_funds" })
    expect(log).toEqual([])
  })

  it("refuses by default when the gate itself fails; goes on when onGateError is open", async () => {
    const boom = async () => { throw new Error("db down") }
    const closed = harness({ onAuthorize: boom })
    expect(await guardVoiceCall(closed.gate, { call: "c" }, { start: async () => undefined, close: async () => undefined })).toEqual({ started: false, reason: "gate_error" })
    const open = harness({ onAuthorize: boom, onGateError: "open" })
    const r = await guardVoiceCall(open.gate, { call: "c" }, { start: async () => undefined, close: async () => undefined, ended: Promise.resolve("ended") })
    expect(r.started).toBe(true)
    expect(open.settled).toHaveLength(0)
  })

  it("settles with reason error when the engine fails to start (the hold is not left open)", async () => {
    const { gate, settled } = harness()
    const r = await guardVoiceCall(gate, { call: "c" }, { start: async () => { throw new Error("socket") }, close: async () => undefined })
    expect(r).toMatchObject({ started: true, endReason: "error" })
    expect(settled.map(s => s.reason)).toEqual(["error"])
  })

  it("settles with reason error when close throws", async () => {
    const { gate, settled } = harness()
    await guardVoiceCall(gate, { call: "c" }, { start: async () => undefined, close: async () => { throw new Error("x") }, ended: Promise.resolve("ended") })
    expect(settled.map(s => s.reason)).toEqual(["error"])
  })

  it("cuts the call off at zero credit after the grace delay, with the farewell", async () => {
    const farewells: VoiceBalanceDirective[] = []
    const { gate, settled } = harness({
      onCheckpoint: async () => ({ action: "cutoff", graceMs: 20, farewell: { reason: "balance_depleted" } }),
    })
    const t0 = Date.now()
    const r = await guardVoiceCall(gate, { call: "c" }, {
      start: async () => undefined,
      close: async () => undefined,
      onFarewell: d => void farewells.push(d),
    })
    expect(r).toMatchObject({ started: true, endReason: "cutoff" })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    expect(farewells[0]).toMatchObject({ action: "cutoff" })
    expect(settled.map(s => s.reason)).toEqual(["cutoff"])
  })

  it("warns without ending, keeps polling, and survives a failing checkpoint", async () => {
    let n = 0
    const warned: string[] = []
    const { gate } = harness({
      onCheckpoint: async () => {
        n++
        if (n === 1) throw new Error("api 500")
        if (n === 2) return { action: "warn", farewell: { reason: "low_balance" } }
        return { action: "continue" }
      },
    })
    let end!: (r: VoiceEndReason) => void
    const ended = new Promise<VoiceEndReason>(res => (end = res))
    const p = guardVoiceCall(gate, { call: "c" }, { start: async () => undefined, close: async () => undefined, ended, onFarewell: d => void warned.push(d.action) })
    await new Promise(r => setTimeout(r, 80))
    end("ended")
    expect((await p).started).toBe(true)
    expect(n).toBeGreaterThanOrEqual(3)
    expect(warned).toEqual(["warn"])
  })

  it("a failing settle does not throw: the hold is left for the sweep", async () => {
    const { gate } = harness({ onSettle: async () => { throw new Error("db") } })
    const r = await guardVoiceCall(gate, { call: "c" }, { start: async () => undefined, close: async () => undefined, ended: Promise.resolve("mic-idle") })
    expect(r).toMatchObject({ started: true, endReason: "mic-idle" })
  })

  it("fails closed on a decision outside the type: authorize refuses, a bad checkpoint cuts off", async () => {
    const bad = harness({ onAuthorize: (async () => ({ nope: true })) as never })
    expect(await guardVoiceCall(bad.gate, { call: "c" }, { start: async () => undefined, close: async () => undefined })).toEqual({ started: false, reason: "invalid_decision" })
    const cut = harness({ onCheckpoint: (async () => ({ action: "maybe" })) as never })
    const r = await guardVoiceCall(cut.gate, { call: "c" }, { start: async () => undefined, close: async () => undefined })
    expect(r).toMatchObject({ started: true, endReason: "cutoff" })
    expect(cut.settled.map(s => s.reason)).toEqual(["cutoff"])
  })
})
