/**
 * Contract tests for a voice billing gate, framework-free:
 *
 *   for (const c of voiceBillingGateConformanceCases(ctx)) it(c.name, c.run)
 *
 * A host runs them against its own gate (its rules decide amounts and refusals)
 * on every upgrade of the kit. They check what no gate may break: a refused
 * call opens nothing, a call that was authorized is always settled exactly
 * once (end, cutoff, engine failure, failed close), and a failing checkpoint
 * does not end a live call.
 */
import { guardVoiceCall, type GuardedVoiceCall, type VoiceBillingGate, type VoiceEndReason } from "../billing-gate.js"

export interface VoiceGateConformanceContext<Hold, Ctx> {
  /** The gate under test, over a journal where `canPay` can start a call and `cannotPay` cannot. */
  gate: () => VoiceBillingGate<Hold, Ctx>
  canPay: Ctx
  cannotPay: Ctx
}

export interface VoiceGateConformanceCase {
  name: string
  run: () => Promise<void>
}

class GateConformanceError extends Error {}
const check = (c: unknown, msg: string): void => {
  if (!c) throw new GateConformanceError(msg)
}

export function voiceBillingGateConformanceCases<Hold, Ctx>(ctx: VoiceGateConformanceContext<Hold, Ctx>): VoiceGateConformanceCase[] {
  function spied() {
    const g = ctx.gate()
    const log = { settles: [] as VoiceEndReason[], authorizeCalls: 0 }
    const wrapped: VoiceBillingGate<Hold, Ctx> = {
      ...g,
      pollIntervalMs: 5,
      onAuthorize: async c => {
        log.authorizeCalls++
        return g.onAuthorize(c)
      },
      onSettle: async (c, h, e) => {
        log.settles.push(e.reason)
        return g.onSettle(c, h, e)
      },
    }
    return { wrapped, log }
  }
  const call = (over: Partial<GuardedVoiceCall> & { opened?: string[] } = {}): GuardedVoiceCall => ({
    start: async () => void over.opened?.push("start"),
    close: async () => undefined,
    ...over,
  })
  return [
    {
      name: "VGATE-1 a call the account cannot pay is refused before anything is opened",
      run: async () => {
        const { wrapped, log } = spied()
        const opened: string[] = []
        const r = await guardVoiceCall(wrapped, ctx.cannotPay, call({ opened }))
        check(!r.started, "a refused call started")
        check(opened.length === 0, "the engine was opened for a refused call")
        check(log.settles.length === 0, "a refused call was settled")
      },
    },
    {
      name: "VGATE-2 an authorized call is settled exactly once when it ends",
      run: async () => {
        const { wrapped, log } = spied()
        await guardVoiceCall(wrapped, ctx.canPay, call({ ended: Promise.resolve("ended") }))
        check(log.settles.length === 1 && log.settles[0] === "ended", `settles: ${JSON.stringify(log.settles)}`)
      },
    },
    {
      name: "VGATE-3 an authorized call is settled when the engine fails to start",
      run: async () => {
        const { wrapped, log } = spied()
        await guardVoiceCall(wrapped, ctx.canPay, call({ start: async () => { throw new Error("socket") } }))
        check(log.settles.length === 1 && log.settles[0] === "error", `settles: ${JSON.stringify(log.settles)}`)
      },
    },
    {
      name: "VGATE-4 an authorized call is settled when closing the engine fails",
      run: async () => {
        const { wrapped, log } = spied()
        await guardVoiceCall(wrapped, ctx.canPay, call({ ended: Promise.resolve("ended"), close: async () => { throw new Error("x") } }))
        check(log.settles.length === 1, `settles: ${JSON.stringify(log.settles)}`)
      },
    },
    {
      name: "VGATE-5 a failing checkpoint does not end a live call",
      run: async () => {
        const { wrapped, log } = spied()
        let failures = 0
        const g: VoiceBillingGate<Hold, Ctx> = { ...wrapped, onCheckpoint: async () => { failures++; throw new Error("api down") } }
        let end!: (r: VoiceEndReason) => void
        const ended = new Promise<VoiceEndReason>(res => (end = res))
        const p = guardVoiceCall(g, ctx.canPay, call({ ended }))
        await new Promise(r => setTimeout(r, 40))
        end("ended")
        const r = await p
        check(r.started && r.endReason === "ended", "the call was ended by a failing checkpoint")
        check(failures >= 2, "the checkpoint was not retried")
        check(log.settles.length === 1, "the call was not settled once")
      },
    },
  ]
}
