/**
 * Balance guard for a metered voice call: authorize before the vendor sockets
 * open, poll while the call runs, settle when it ends, whatever the reason.
 *
 * The kit does not price anything and does not know what a balance is. The
 * host injects the three hooks (typically over `createHolds` from
 * `@agentproto/billing/spend`) and calls `guardVoiceCall` around its engine.
 *
 *   onAuthorize  before `start`: `ok:false` means no call, nothing was opened
 *   onCheckpoint every `pollIntervalMs`: continue, warn (spoken heads-up) or
 *                cutoff (wind the call down after `graceMs`)
 *   onSettle     once, in a `finally`: the hold is settled or released even
 *                after an error, a cutoff or a crash of the engine
 */
import type { VoiceUsage } from "./types.js"

export interface VoiceFarewell {
  reason: string
  /** What the caller hears or reads. */
  text?: string
  /** What the brain is told to say before the call ends. */
  directive?: string
}

export type VoiceBalanceDirective =
  | { action: "continue" }
  | { action: "warn"; farewell?: VoiceFarewell }
  | { action: "cutoff"; farewell?: VoiceFarewell; graceMs?: number }

export type VoiceAuthDecision<Hold> = { ok: true; hold?: Hold } | { ok: false; reason: string }

export type VoiceEndReason = "ended" | "cutoff" | "error" | "mic-idle" | "crash"

export interface VoiceCallProgress {
  elapsedSeconds: number
  usage?: VoiceUsage | undefined
}

export interface VoiceBillingGate<Hold = unknown, Ctx = unknown> {
  onAuthorize(ctx: Ctx): Promise<VoiceAuthDecision<Hold>>
  onCheckpoint(ctx: Ctx, hold: Hold, progress: VoiceCallProgress): Promise<VoiceBalanceDirective>
  onSettle(ctx: Ctx, hold: Hold, end: VoiceCallProgress & { reason: VoiceEndReason }): Promise<void>
  /** Default 15 000. */
  pollIntervalMs?: number
  /**
   * What an error thrown by `onAuthorize` means. `closed` (default): no
   * reservation, no call. `open`: the call goes on without a hold.
   */
  onGateError?: "closed" | "open"
}

/** The engine a host wraps: its own start, close and usage read. */
export interface GuardedVoiceCall {
  start(): Promise<void>
  /** Close the engine; must make `getUsage` final. Called once. */
  close(): Promise<void>
  getUsage?(): VoiceUsage | undefined
  /** Called on `warn` and on `cutoff` (before the grace delay). */
  onFarewell?(directive: VoiceBalanceDirective): void | Promise<void>
  /**
   * Resolves when the call ended by itself (hang-up, mic idle), with the reason.
   * Pass it: without it `guardVoiceCall` only returns on a cutoff, so a call
   * that never reaches its cutoff would never return.
   */
  ended?: Promise<VoiceEndReason>
}

export interface GuardOptions {
  now?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(t: unknown): void
  log?(msg: string, extra?: Record<string, unknown>): void
}

export type GuardResult = { started: false; reason: string } | { started: true; endReason: VoiceEndReason; seconds: number }

export async function guardVoiceCall<Hold, Ctx>(
  gate: VoiceBillingGate<Hold, Ctx>,
  ctx: Ctx,
  call: GuardedVoiceCall,
  opts: GuardOptions = {},
): Promise<GuardResult> {
  const now = opts.now ?? Date.now
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = opts.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  const log = opts.log ?? (() => undefined)

  let decision: VoiceAuthDecision<Hold>
  try {
    decision = await gate.onAuthorize(ctx)
  } catch (err) {
    log("authorize failed", { error: err instanceof Error ? err.message : String(err) })
    if ((gate.onGateError ?? "closed") === "closed") return { started: false, reason: "gate_error" }
    decision = { ok: true }
  }
  if (!decision.ok) return { started: false, reason: decision.reason }
  const hold = decision.hold as Hold | undefined

  const startedAt = now()
  const elapsed = () => Math.max(0, (now() - startedAt) / 1000)
  let reason: VoiceEndReason = "ended"
  let timer: unknown
  let cutTimer: unknown
  let stopped = false
  let wake: (() => void) | undefined
  const cutoffRequested = new Promise<void>(res => {
    wake = res
  })

  const poll = () => {
    if (stopped || hold === undefined) return
    void (async () => {
      try {
        const d = await gate.onCheckpoint(ctx, hold, { elapsedSeconds: elapsed(), usage: call.getUsage?.() })
        if (stopped) return
        if (d.action === "warn") await call.onFarewell?.(d)
        if (d.action === "cutoff") {
          reason = "cutoff"
          await call.onFarewell?.(d)
          cutTimer = setT(() => wake?.(), d.graceMs ?? 0)
          return
        }
      } catch (err) {
        // A failing checkpoint never kills a live call: the next poll retries.
        log("checkpoint failed", { error: err instanceof Error ? err.message : String(err) })
      }
      if (!stopped) timer = setT(poll, gate.pollIntervalMs ?? 15_000)
    })()
  }

  try {
    await call.start()
    timer = setT(poll, gate.pollIntervalMs ?? 15_000)
    const selfEnded = call.ended ? call.ended.then(r => ({ r })) : new Promise<never>(() => undefined)
    const winner = await Promise.race([cutoffRequested.then(() => ({ r: "cutoff" as VoiceEndReason })), selfEnded])
    reason = winner.r
  } catch (err) {
    log("call failed", { error: err instanceof Error ? err.message : String(err) })
    reason = "error"
  } finally {
    stopped = true
    if (timer !== undefined) clearT(timer)
    if (cutTimer !== undefined) clearT(cutTimer)
    let usage: VoiceUsage | undefined
    try {
      await call.close()
    } catch (err) {
      log("close failed", { error: err instanceof Error ? err.message : String(err) })
      if (reason === "ended") reason = "error"
    }
    try {
      usage = call.getUsage?.()
    } catch {
      usage = undefined
    }
    if (hold !== undefined) {
      try {
        await gate.onSettle(ctx, hold, { elapsedSeconds: elapsed(), usage, reason })
      } catch (err) {
        // The hold stays open: the host's sweep releases it. Said loudly.
        log("settle failed, hold left for the sweep", { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return { started: true, endReason: reason, seconds: elapsed() }
}
