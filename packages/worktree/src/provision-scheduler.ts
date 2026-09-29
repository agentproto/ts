/**
 * Daemon-wide scheduler for the HEAVY phases of worktree provisioning
 * (`cloneGlobs`, `depsCmd`, `copyGlobs`, the `worktree.setup` hooks).
 *
 * Incident 2026-09-28: five `agent_start({worktree})` spawns provisioned at
 * once, each ran a full `pnpm install` against one pnpm store on one SSD, the
 * load average hit 170, and every install took ~14 min instead of ~4 while the
 * sessions sat in `starting` looking stalled. The cure is admission control:
 * at most N heavy segments run at once, the rest wait in a queue that can be
 * observed and cancelled.
 *
 * One provisioning takes ONE slot for its whole heavy segment (clone → deps →
 * copy → setup) rather than one per phase, so a half-built worktree never
 * re-queues behind newer arrivals. `git worktree add` and the cheap steps
 * around it stay outside the slot.
 *
 * Dispatch order is FIFO with a fair-share tiebreak: among the waiters whose
 * repo is under its cap, the next one is the waiter whose CALLER currently
 * holds the fewest running slots, oldest first on ties. One caller that
 * spawns ten worktrees therefore cannot starve another caller's single spawn,
 * and with a single caller this is plain FIFO.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { cpus, homedir, loadavg } from "node:os"
import { basename, resolve } from "node:path"

/** Default cap on concurrently running heavy segments. */
export const DEFAULT_PROVISION_CONCURRENCY = 2

/** Env override for the global cap; wins over `worktrees.provisionConcurrency`. */
export const PROVISION_CONCURRENCY_ENV = "AGENTPROTO_WORKTREES_PROVISION_CONCURRENCY"

/** The phases a provisioning moves through, in order. `worktree` is the
 *  unthrottled `git worktree add` + cheap prep; the rest are the heavy ones. */
export type ProvisionPhase = "worktree" | "clone" | "deps" | "copy" | "setup"

/** Resolved, validated scheduler limits. `Infinity` means "no cap". */
export interface ProvisionLimits {
  /** Max heavy segments running at once, across every repo. */
  concurrency: number
  /** Extra per-repo caps (also bounded by `concurrency`). Keys are absolute
   *  repo-root paths or bare repo directory names. */
  perRepo: Readonly<Record<string, number>>
  /** Load guard: hold back a new heavy segment while the 1-minute load
   *  average exceeds `cores x loadFactor`. `0` = off (the default). */
  loadFactor: number
}

export const DEFAULT_PROVISION_LIMITS: ProvisionLimits = Object.freeze({
  concurrency: DEFAULT_PROVISION_CONCURRENCY,
  perRepo: Object.freeze({}),
  loadFactor: 0,
})

/** A non-negative integer cap; `0` means unlimited. Anything else is invalid. */
function parseCap(raw: unknown): number | undefined {
  if (typeof raw === "string" && raw.trim() !== "") raw = Number(raw)
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return undefined
  return raw === 0 ? Infinity : raw
}

/** `~/x` expands, anything with a path separator resolves absolute, a bare
 *  name stays a repo-directory-name key. */
function normalizeRepoKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2))
  if (trimmed.includes("/") || trimmed.includes("\\")) return resolve(trimmed)
  return trimmed
}

/**
 * Parse the `worktrees` section of `~/.agentproto/config.json` (plus env)
 * into {@link ProvisionLimits}. Never throws: an invalid value falls back to
 * the default for that field so a typo can't take provisioning down.
 *
 *   - `provisionConcurrency`: integer >= 0 (`0` = unlimited). Env
 *     `AGENTPROTO_WORKTREES_PROVISION_CONCURRENCY` wins over the config field.
 *   - `provisionConcurrencyByRepo`: `{ "<repo path or dir name>": cap }`.
 *   - `provisionLoadFactor`: number > 0 enables the load guard.
 */
export function parseProvisionLimits(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProvisionLimits {
  const section = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const concurrency =
    parseCap(env[PROVISION_CONCURRENCY_ENV]) ??
    parseCap(section["provisionConcurrency"]) ??
    DEFAULT_PROVISION_CONCURRENCY

  const perRepo: Record<string, number> = {}
  const byRepo = section["provisionConcurrencyByRepo"]
  if (byRepo !== null && typeof byRepo === "object" && !Array.isArray(byRepo)) {
    for (const [key, value] of Object.entries(byRepo as Record<string, unknown>)) {
      const cap = parseCap(value)
      if (cap !== undefined && key.trim() !== "") perRepo[normalizeRepoKey(key)] = cap
    }
  }

  const factor = section["provisionLoadFactor"]
  const loadFactor = typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 0
  return { concurrency, perRepo, loadFactor }
}

/** Thrown when a provisioning is cancelled: while queued (its slot request is
 *  dropped) or while running (its child process tree is killed). */
export class ProvisionCancelledError extends Error {
  constructor(message = "worktree provisioning cancelled") {
    super(message)
    this.name = "ProvisionCancelledError"
  }
}

/** Progress a provisioning reports to whoever spawned it. `queued` repeats
 *  whenever the projected position moves. */
export type ProvisionProgress =
  | { kind: "queued"; position: number; phase: ProvisionPhase }
  | { kind: "started"; phase: ProvisionPhase }
  | { kind: "phase"; phase: ProvisionPhase }
  | { kind: "done"; outcome: "ok" | "failed" | "cancelled" }

/** Ambient, per-provisioning context. Carried through `AsyncLocalStorage`
 *  because the `worktree.provision` tool contract has no room for callbacks,
 *  and the runner's own abort signal is bound to the tool's 30s default
 *  timeout, which must never cancel a multi-minute install. */
export interface ProvisionRunContext {
  /** Whose spawn this is, for fair-share. Typically the parent session id. */
  callerKey?: string
  /** Cancels this provisioning (queued or running). */
  signal?: AbortSignal
  onProgress?: (progress: ProvisionProgress) => void
}

const contextStore = new AsyncLocalStorage<ProvisionRunContext>()

export function runWithProvisionContext<T>(ctx: ProvisionRunContext, fn: () => T): T {
  return contextStore.run(ctx, fn)
}

export function currentProvisionContext(): ProvisionRunContext | undefined {
  return contextStore.getStore()
}

export interface AcquireRequest {
  /** Absolute repo root; matched against `perRepo` caps. */
  repoKey: string
  callerKey?: string
  signal?: AbortSignal
  /** Called with the projected 1-based queue position when this request
   *  starts waiting and whenever its position changes. Never called when the
   *  slot is granted immediately. */
  onQueued?: (position: number) => void
}

/** A held slot. `release` is idempotent. */
export interface ProvisionLease {
  release(): void
}

export interface SchedulerOptions {
  limits?: ProvisionLimits
  /** Test seams. */
  loadavg1?: () => number
  cpuCount?: () => number
  /** How often a load-guarded queue re-checks the load. Default 5000ms. */
  loadPollMs?: number
}

interface Waiter {
  seq: number
  repoKey: string
  callerKey: string
  signal: AbortSignal | undefined
  onQueued: ((position: number) => void) | undefined
  lastPosition: number
  grant: (lease: ProvisionLease) => void
  reject: (err: Error) => void
  detach: () => void
}

interface RunningSlot {
  repoKey: string
  callerKey: string
}

export interface SchedulerSnapshot {
  running: number
  queued: number
  limit: number
}

export class ProvisionScheduler {
  private limits: ProvisionLimits
  private readonly queue: Waiter[] = []
  private readonly running = new Set<RunningSlot>()
  private seq = 0
  private loadTimer: NodeJS.Timeout | undefined
  private readonly loadavg1: () => number
  private readonly cpuCount: () => number
  private readonly loadPollMs: number

  constructor(opts: SchedulerOptions = {}) {
    this.limits = opts.limits ?? DEFAULT_PROVISION_LIMITS
    this.loadavg1 = opts.loadavg1 ?? (() => loadavg()[0] ?? 0)
    this.cpuCount = opts.cpuCount ?? (() => cpus().length || 1)
    this.loadPollMs = opts.loadPollMs ?? 5000
  }

  /** Replace the limits (config is re-read per provision). Raising a cap
   *  admits waiters immediately; lowering one never interrupts a running
   *  segment, it just delays the next admission. */
  configure(limits: ProvisionLimits): void {
    this.limits = limits
    this.pump()
  }

  snapshot(): SchedulerSnapshot {
    return { running: this.running.size, queued: this.queue.length, limit: this.limits.concurrency }
  }

  /**
   * Request a heavy-phase slot. Resolves with a lease once admitted; rejects
   * with {@link ProvisionCancelledError} when `signal` aborts first (the
   * queue entry is dropped, so a cancelled spawn never occupies a slot).
   */
  acquire(req: AcquireRequest): Promise<ProvisionLease> {
    if (req.signal?.aborted) return Promise.reject(new ProvisionCancelledError())
    return new Promise<ProvisionLease>((resolvePromise, rejectPromise) => {
      const waiter: Waiter = {
        seq: this.seq++,
        repoKey: req.repoKey,
        callerKey: req.callerKey ?? "anonymous",
        signal: req.signal,
        onQueued: req.onQueued,
        lastPosition: 0,
        grant: resolvePromise,
        reject: rejectPromise,
        detach: () => {},
      }
      if (req.signal) {
        const onAbort = (): void => {
          const idx = this.queue.indexOf(waiter)
          if (idx === -1) return
          this.queue.splice(idx, 1)
          waiter.reject(new ProvisionCancelledError("worktree provisioning cancelled while queued"))
          this.pump()
        }
        req.signal.addEventListener("abort", onAbort, { once: true })
        waiter.detach = () => req.signal!.removeEventListener("abort", onAbort)
      }
      this.queue.push(waiter)
      this.pump()
    })
  }

  private repoCap(repoKey: string): number {
    const { perRepo } = this.limits
    const own = (key: string): number | undefined =>
      Object.hasOwn(perRepo, key) ? perRepo[key] : undefined
    return Math.min(own(repoKey) ?? own(basename(repoKey)) ?? Infinity, this.limits.concurrency)
  }

  private runningFor(match: (slot: RunningSlot) => boolean): number {
    let n = 0
    for (const slot of this.running) if (match(slot)) n++
    return n
  }

  /** Waiters in the order they would be admitted absent per-repo caps. */
  private projectedOrder(): Waiter[] {
    const held = new Map<string, number>()
    for (const slot of this.running) held.set(slot.callerKey, (held.get(slot.callerKey) ?? 0) + 1)
    const remaining = [...this.queue]
    const ordered: Waiter[] = []
    while (remaining.length > 0) {
      let best = 0
      for (let i = 1; i < remaining.length; i++) {
        if ((held.get(remaining[i]!.callerKey) ?? 0) < (held.get(remaining[best]!.callerKey) ?? 0)) best = i
      }
      const [next] = remaining.splice(best, 1)
      ordered.push(next!)
      held.set(next!.callerKey, (held.get(next!.callerKey) ?? 0) + 1)
    }
    return ordered
  }

  private loadGuardBlocks(): boolean {
    const { loadFactor } = this.limits
    if (loadFactor <= 0) return false
    // Never block an idle scheduler: at least one segment must always be able
    // to run, or a permanently loaded host would deadlock the queue.
    if (this.running.size === 0) return false
    return this.loadavg1() > this.cpuCount() * loadFactor
  }

  private pump(): void {
    for (;;) {
      if (this.queue.length === 0) break
      if (this.running.size >= this.limits.concurrency) break
      if (this.loadGuardBlocks()) {
        this.armLoadTimer()
        break
      }
      const next = this.projectedOrder().find(
        (w) =>
          this.runningFor((s) => s.repoKey === w.repoKey) < this.repoCap(w.repoKey),
      )
      if (!next) break
      this.queue.splice(this.queue.indexOf(next), 1)
      next.detach()
      const slot: RunningSlot = { repoKey: next.repoKey, callerKey: next.callerKey }
      this.running.add(slot)
      let released = false
      next.grant({
        release: () => {
          if (released) return
          released = true
          this.running.delete(slot)
          this.pump()
        },
      })
    }
    this.notifyPositions()
  }

  private notifyPositions(): void {
    this.projectedOrder().forEach((waiter, idx) => {
      const position = idx + 1
      if (position === waiter.lastPosition) return
      waiter.lastPosition = position
      try {
        waiter.onQueued?.(position)
      } catch {
        // An observer must never break scheduling.
      }
    })
  }

  private armLoadTimer(): void {
    if (this.loadTimer) return
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined
      this.pump()
    }, this.loadPollMs)
    this.loadTimer.unref()
  }
}

/** The process-wide (daemon-wide) scheduler every worktree provisioning shares. */
export const provisionScheduler = new ProvisionScheduler()
