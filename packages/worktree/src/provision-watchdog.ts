/**
 * Boot timeouts for a worktree provisioning.
 *
 * Incident 2026-11-02: a session whose repo declares a long `worktree.setup`
 * hook (clone nested repos, then a 1.3 GB `pnpm install`, ~10-13 min) sat in
 * `starting` with no output at all, so an operator could not tell a slow
 * setup from a hung one; a genuinely hung hook (a `git fetch` waiting on ssh)
 * would sit there forever. Two bounds fix both halves without killing a
 * legitimately slow setup:
 *
 *   - STALL: no output from the setup/deps process for `stallTimeoutMs`
 *     (default 2 min). A slow install that keeps printing never trips it.
 *   - MAX: the heavy segment ran longer than `maxMs` (default 30 min) in
 *     total, output or not.
 *
 * Either bound aborts a private controller whose signal is merged with the
 * caller's, so the existing tree-kill in `exec.ts` takes the whole process
 * group down, and the failure carries the phase, elapsed time and the last
 * output lines. `0` disables a bound.
 */

import type { ProvisionPhase } from "./provision-scheduler.js"

export const DEFAULT_PROVISION_STALL_TIMEOUT_MS = 120_000
export const DEFAULT_PROVISION_MAX_MS = 30 * 60_000

/** Env overrides; win over the `worktrees.*` config fields. */
export const PROVISION_STALL_TIMEOUT_ENV = "AGENTPROTO_WORKTREES_PROVISION_STALL_TIMEOUT_MS"
export const PROVISION_MAX_ENV = "AGENTPROTO_WORKTREES_PROVISION_MAX_MS"

/** Resolved bounds; `0` = that bound is off. */
export interface ProvisionTimeouts {
  stallTimeoutMs: number
  maxMs: number
}

export const DEFAULT_PROVISION_TIMEOUTS: ProvisionTimeouts = Object.freeze({
  stallTimeoutMs: DEFAULT_PROVISION_STALL_TIMEOUT_MS,
  maxMs: DEFAULT_PROVISION_MAX_MS,
})

/** A non-negative integer number of milliseconds (`0` = off); else undefined. */
function parseMs(raw: unknown): number | undefined {
  if (typeof raw === "string" && raw.trim() !== "") raw = Number(raw)
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return undefined
  return raw
}

/**
 * Resolve the bounds for one provisioning. Precedence per field: the spawn's
 * own value (`agent_start.worktree.stallTimeoutMs` / `maxMs`) > env >
 * `worktrees.provisionStallTimeoutMs` / `provisionMaxMs` config > default.
 * Never throws: an invalid value falls through to the next source.
 */
export function resolveProvisionTimeouts(
  section: unknown,
  perSpawn: { stallTimeoutMs?: number; maxMs?: number } = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProvisionTimeouts {
  const cfg = section !== null && typeof section === "object" ? (section as Record<string, unknown>) : {}
  return {
    stallTimeoutMs:
      parseMs(perSpawn.stallTimeoutMs) ??
      parseMs(env[PROVISION_STALL_TIMEOUT_ENV]) ??
      parseMs(cfg["provisionStallTimeoutMs"]) ??
      DEFAULT_PROVISION_STALL_TIMEOUT_MS,
    maxMs:
      parseMs(perSpawn.maxMs) ??
      parseMs(env[PROVISION_MAX_ENV]) ??
      parseMs(cfg["provisionMaxMs"]) ??
      DEFAULT_PROVISION_MAX_MS,
  }
}

/** Thrown (as the abort reason) when a bound trips. `message` is the full,
 *  operator-facing failure text. */
export class ProvisionTimeoutError extends Error {
  readonly kind: "stall" | "max"
  readonly phase: ProvisionPhase
  readonly elapsedMs: number
  constructor(kind: "stall" | "max", phase: ProvisionPhase, elapsedMs: number, message: string) {
    super(message)
    this.name = "ProvisionTimeoutError"
    this.kind = kind
    this.phase = phase
    this.elapsedMs = elapsedMs
  }
}

const OUTPUT_TAIL_LINES = 20

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, "0")}s`
}

export interface ProvisionWatchdogOptions extends ProvisionTimeouts {
  /** Where the full hook output was persisted, named in the failure text. */
  logPath?: string
  /** Test seam. */
  now?: () => number
}

export interface ProvisionWatchdog {
  /** Aborts when a bound trips; merge it with the caller's signal. */
  readonly signal: AbortSignal
  /** The trip, once one happened. */
  tripped(): ProvisionTimeoutError | undefined
  /** Record output: resets the stall clock and feeds the failure's tail. */
  output(text: string): void
  /** Enter a phase. `watched: false` pauses the stall clock for phases that
   *  run in-process and print nothing (`clone`, `copy`); `maxMs` still runs. */
  phase(phase: ProvisionPhase, watched: boolean): void
  stop(): void
}

/** Start the clocks. Call once the heavy segment actually begins running. */
export function startProvisionWatchdog(opts: ProvisionWatchdogOptions): ProvisionWatchdog {
  const now = opts.now ?? Date.now
  const startedAt = now()
  const controller = new AbortController()
  let current: ProvisionPhase = "setup"
  let watched = true
  let lastActivity = startedAt
  let trip: ProvisionTimeoutError | undefined
  let carry = ""
  const tail: string[] = []
  let stallTimer: NodeJS.Timeout | undefined
  let maxTimer: NodeJS.Timeout | undefined

  const fire = (kind: "stall" | "max"): void => {
    if (trip || controller.signal.aborted) return
    const elapsedMs = now() - startedAt
    const lines = carry ? [...tail, carry] : tail
    const last = lines.slice(-OUTPUT_TAIL_LINES)
    const why =
      kind === "stall"
        ? `no output for ${fmtDuration(opts.stallTimeoutMs)}`
        : `exceeded the ${fmtDuration(opts.maxMs)} provisioning cap`
    const hint =
      kind === "stall"
        ? "raise `stallTimeoutMs` (agent_start worktree option, or config worktrees.provisionStallTimeoutMs) if this setup is legitimately silent that long"
        : "raise `maxMs` (agent_start worktree option, or config worktrees.provisionMaxMs) if this setup legitimately needs longer"
    trip = new ProvisionTimeoutError(
      kind,
      current,
      elapsedMs,
      `worktree provisioning ${kind === "stall" ? "stalled" : "timed out"} in phase "${current}": ${why} ` +
        `(elapsed ${fmtDuration(elapsedMs)}); the process tree was killed. ` +
        `Last output:\n${last.length > 0 ? last.join("\n") : "(none)"}` +
        (opts.logPath ? `\n\n(full hook output: ${opts.logPath})` : "") +
        `\n(${hint})`,
    )
    controller.abort(trip)
    stop()
  }

  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = undefined
    if (opts.stallTimeoutMs <= 0 || trip) return
    const wait = Math.max(0, lastActivity + opts.stallTimeoutMs - now())
    stallTimer = setTimeout(() => {
      stallTimer = undefined
      if (!watched) return armStall()
      if (now() - lastActivity >= opts.stallTimeoutMs) return fire("stall")
      armStall()
    }, wait)
    stallTimer.unref()
  }

  function stop(): void {
    if (stallTimer) clearTimeout(stallTimer)
    if (maxTimer) clearTimeout(maxTimer)
    stallTimer = maxTimer = undefined
  }

  if (opts.maxMs > 0) {
    maxTimer = setTimeout(() => fire("max"), opts.maxMs)
    maxTimer.unref()
  }
  armStall()

  return {
    signal: controller.signal,
    tripped: () => trip,
    output(text) {
      lastActivity = now()
      const parts = (carry + text).split(/\r?\n|\r/)
      carry = parts.pop() ?? ""
      for (const line of parts) if (line.trim() !== "") tail.push(line)
      if (tail.length > OUTPUT_TAIL_LINES) tail.splice(0, tail.length - OUTPUT_TAIL_LINES)
      if (carry.length > 4096) carry = carry.slice(-4096)
    },
    phase(next, isWatched) {
      current = next
      watched = isWatched
      lastActivity = now()
      armStall()
    },
    stop,
  }
}
