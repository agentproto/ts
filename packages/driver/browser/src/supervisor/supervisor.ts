import { ToolError } from "@agentproto/tool"
import type {
  BrowserHealth,
  BrowserHostContext,
  BrowserInstance,
  BrowserLaunchOptions,
  BrowserProvider,
  BrowserState,
} from "../provider.js"
import { sweepOrphans, type OrphanSweepOptions } from "./orphan-sweep.js"

/** Injected time source; tests drive a fake one, so no real sleeps. */
export interface SupervisorClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: SupervisorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Launch budget shared with the camofox server default (120 s). */
export const DEFAULT_LAUNCH_BUDGET_MS = 120_000

export const BROWSER_CRASH_LOOPING_CODE = "browser:crash-looping" as const
export const BROWSER_LAUNCH_TIMEOUT_CODE = "browser:launch-timeout" as const

/** Thrown instead of launching once the instance is `crash-looping`. */
export class BrowserCrashLoopError extends ToolError {
  readonly failures: number
  constructor(failures: number, windowMs: number, lastError?: string) {
    super({
      code: BROWSER_CRASH_LOOPING_CODE,
      message:
        `browser is crash-looping: ${failures} failed starts within ${windowMs} ms; ` +
        `launches are paused until an explicit restart()` +
        (lastError ? ` (last error: ${lastError})` : ""),
      cause: { failures, windowMs },
    })
    this.name = "BrowserCrashLoopError"
    this.failures = failures
  }
}

/** A launch that outran the budget; counts as one failed start. */
export class BrowserLaunchTimeoutError extends ToolError {
  constructor(budgetMs: number) {
    super({
      code: BROWSER_LAUNCH_TIMEOUT_CODE,
      message: `browser launch exceeded its ${budgetMs} ms budget`,
      cause: { budgetMs },
    })
    this.name = "BrowserLaunchTimeoutError"
  }
}

/** `BrowserState` plus the two states only the supervisor can be in. */
export type SupervisorState = BrowserState | "down" | "stopped"

export interface BackendRestartEvent {
  previousBootId: string
  bootId: string
  lastRestartReason: string | null
  instance: BrowserInstance
}

export interface SupervisorStatus {
  state: SupervisorState
  /** Who declared `crash-looping`: the supervisor's own detector or the backend's `/health`. */
  crashLoopSource: "supervisor" | "backend" | null
  recentFailures: number
  bootId: string | null
  lastHealth: BrowserHealth | null
  instance: BrowserInstance | null
}

export interface BrowserSupervisorOptions {
  provider: BrowserProvider
  launchOptions?: BrowserLaunchOptions
  hostContext?: BrowserHostContext
  clock?: SupervisorClock
  /** Health probe interval. Default 10 000 ms. */
  healthIntervalMs?: number
  /** Consecutive failed probes before an automatic relaunch. Default 2. */
  unhealthyThreshold?: number
  /** Relaunch automatically when the backend is down. Default true. */
  autoRestart?: boolean
  /** One launch may take this long before it counts as failed. Default 120 000 ms. */
  launchBudgetMs?: number
  crashLoop?: {
    /** Failed starts within `windowMs` that flip to `crash-looping`. Default 3. */
    maxFailures?: number
    /** Default 300 000 ms. */
    windowMs?: number
    /** Pause between failed starts before the next attempt. Default 1 000 ms. */
    retryDelayMs?: number
  }
  /** Sweep leftover processes carrying this marker before relaunch and after stop. */
  orphanSweep?: OrphanSweepOptions
  onStateChange?: (state: SupervisorState, previous: SupervisorState) => void
  /** Fired when `/health` reports a different `bootId` than the last probe. */
  onBackendRestart?: (event: BackendRestartEvent) => void
  log?: (line: string) => void
}

export interface BrowserSupervisor {
  /** Launch (idempotent provider launch) and start the health loop. Rejects with {@link BrowserCrashLoopError} without launching when crash-looping. */
  start(): Promise<BrowserInstance>
  /** The only way out of `crash-looping`: clears the failure counters and relaunches. */
  restart(): Promise<BrowserInstance>
  /** Run one health probe now (the loop calls this on its interval). */
  checkNow(): Promise<void>
  stop(): Promise<void>
  status(): SupervisorStatus
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createBrowserSupervisor(opts: BrowserSupervisorOptions): BrowserSupervisor {
  const clock = opts.clock ?? systemClock
  const healthIntervalMs = opts.healthIntervalMs ?? 10_000
  const unhealthyThreshold = opts.unhealthyThreshold ?? 2
  const autoRestart = opts.autoRestart ?? true
  const launchBudgetMs = opts.launchBudgetMs ?? DEFAULT_LAUNCH_BUDGET_MS
  const maxFailures = opts.crashLoop?.maxFailures ?? 3
  const windowMs = opts.crashLoop?.windowMs ?? 300_000
  const retryDelayMs = opts.crashLoop?.retryDelayMs ?? 1_000
  const log = opts.log ?? opts.hostContext?.log ?? (() => {})

  let state: SupervisorState = "stopped"
  let crashLoopSource: "supervisor" | "backend" | null = null
  let failures: number[] = []
  let lastError: string | undefined
  let instance: BrowserInstance | null = null
  let bootId: string | null = null
  let lastHealth: BrowserHealth | null = null
  let unhealthy = 0
  let timer: unknown
  let closed = true
  let busy: Promise<unknown> | null = null
  /** Set only while a `launchOnce()` is in flight; lets `stop()` cancel it instead of waiting out the budget. */
  let currentLaunchAbort: AbortController | null = null
  /** The single in-flight `start()`/`restart()` launch, so concurrent callers share it instead of double-launching. */
  let pendingLaunch: Promise<BrowserInstance> | null = null

  function setState(next: SupervisorState): void {
    if (next === state) return
    const previous = state
    state = next
    if (next !== "crash-looping") crashLoopSource = null
    opts.onStateChange?.(next, previous)
  }

  function recentFailures(): number {
    const cutoff = clock.now() - windowMs
    failures = failures.filter((t) => t > cutoff)
    return failures.length
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => clock.setTimeout(resolve, ms))
  }

  async function sweep(): Promise<void> {
    if (!opts.orphanSweep) return
    const pids = await sweepOrphans(opts.orphanSweep)
    if (pids.length > 0) log(`swept orphan browser processes: ${pids.join(",")}`)
  }

  async function launchOnce(): Promise<BrowserInstance> {
    const abort = new AbortController()
    const external = opts.hostContext?.signal
    const onExternalAbort = (): void => abort.abort()
    external?.addEventListener("abort", onExternalAbort, { once: true })
    currentLaunchAbort = abort
    let budgetTimer: unknown
    const budget = new Promise<never>((_, reject) => {
      budgetTimer = clock.setTimeout(() => {
        abort.abort()
        reject(new BrowserLaunchTimeoutError(launchBudgetMs))
      }, launchBudgetMs)
    })
    const launched = opts.provider.launch(opts.launchOptions ?? {}, {
      ...opts.hostContext,
      signal: abort.signal,
    })
    try {
      return await Promise.race([launched, budget])
    } catch (err) {
      // A launch that finishes after its budget (or a cancelled one) must not leak a live browser.
      void launched.then((late) => late.stop().catch(() => {}), () => {})
      throw err
    } finally {
      clock.clearTimeout(budgetTimer)
      // Detach from the host's long-lived signal and stop treating this controller as
      // cancellable: a host abort *after* a successful launch must not kill a healthy browser.
      external?.removeEventListener("abort", onExternalAbort)
      if (currentLaunchAbort === abort) currentLaunchAbort = null
    }
  }

  async function launchLoop(): Promise<BrowserInstance> {
    setState("launching")
    for (;;) {
      try {
        const launched = await launchOnce()
        instance = launched
        bootId = null
        unhealthy = 0
        setState("running")
        return launched
      } catch (err) {
        lastError = errorMessage(err)
        failures.push(clock.now())
        log(`browser launch failed: ${lastError}`)
        const count = recentFailures()
        if (count >= maxFailures) {
          crashLoopSource = "supervisor"
          setState("crash-looping")
          throw new BrowserCrashLoopError(count, windowMs, lastError)
        }
        await sleep(retryDelayMs)
        if (closed) throw err
      }
    }
  }

  async function stopInstance(): Promise<void> {
    const old = instance
    instance = null
    if (old) await old.stop().catch((e: unknown) => log(`stop failed: ${errorMessage(e)}`))
  }

  function scheduleTick(): void {
    if (closed) return
    timer = clock.setTimeout(() => {
      void tick()
    }, healthIntervalMs)
  }

  async function tick(): Promise<void> {
    try {
      await probe()
    } finally {
      if (!(state === "crash-looping" && crashLoopSource === "supervisor")) scheduleTick()
    }
  }

  async function probe(): Promise<void> {
    if (closed || busy || !instance) return
    const current = instance
    let health: BrowserHealth
    try {
      health = await current.health()
    } catch (err) {
      health = { ok: false, reason: errorMessage(err) }
    }
    if (closed || instance !== current) return
    lastHealth = health
    const lifecycle = health.lifecycle
    if (lifecycle?.bootId) {
      if (bootId !== null && bootId !== lifecycle.bootId) {
        opts.onBackendRestart?.({
          previousBootId: bootId,
          bootId: lifecycle.bootId,
          lastRestartReason: lifecycle.lastRestartReason ?? null,
          instance: current,
        })
      }
      bootId = lifecycle.bootId
    }
    const reported = lifecycle?.browserState
    if (reported === "crash-looping") {
      // A state, not "down": restarting the backend does not help, only an explicit restart.
      unhealthy = 0
      if (state !== "crash-looping") {
        setState("crash-looping")
      }
      crashLoopSource = "backend"
      return
    }
    if (reported === "launching") {
      // Slow but progressing (the backend enforces its own budget): not a failure.
      unhealthy = 0
      setState("launching")
      return
    }
    if (health.ok) {
      unhealthy = 0
      setState(reported === "idle" ? "idle" : "running")
      return
    }
    unhealthy += 1
    setState("down")
    if (autoRestart && unhealthy >= unhealthyThreshold) {
      await run(async () => {
        await stopInstance()
        await sweep()
        await launchLoop()
      }).catch((e: unknown) => log(`recovery stopped: ${errorMessage(e)}`))
    }
  }

  // A mutex: every transition (start/restart/recovery) chains onto whatever is
  // currently in flight instead of racing it, so `instance`/`bootId` are never
  // clobbered by two launch loops running at once.
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = busy ?? Promise.resolve()
    const p: Promise<T> = previous.catch(() => {}).then(fn)
    const tracked: Promise<void> = p
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (busy === tracked) busy = null
      })
    busy = tracked
    return p
  }

  /** Run `fn` as the single tracked launch, so concurrent `start()`/`restart()` share it. */
  function beginLaunch(fn: () => Promise<BrowserInstance>): Promise<BrowserInstance> {
    if (pendingLaunch) return pendingLaunch
    const p = run(fn).finally(() => {
      if (pendingLaunch === p) pendingLaunch = null
    })
    pendingLaunch = p
    return p
  }

  return {
    async start() {
      if (state === "crash-looping" && crashLoopSource === "supervisor") {
        throw new BrowserCrashLoopError(recentFailures(), windowMs, lastError)
      }
      if (instance && !closed) return instance
      if (pendingLaunch) return pendingLaunch
      if (busy) {
        // A recovery tick (or a restart) is already launching; wait for it instead of
        // racing a second concurrent launch loop.
        await busy.catch(() => {})
        if (instance && !closed) return instance
        if (pendingLaunch) return pendingLaunch
      }
      closed = false
      const launched = beginLaunch(async () => {
        try {
          return await launchLoop()
        } catch (err) {
          if (state !== "crash-looping") closed = true
          throw err
        }
      })
      scheduleTick()
      return launched
    },

    async restart() {
      if (pendingLaunch) return pendingLaunch
      if (busy) await busy.catch(() => {})
      failures = []
      lastError = undefined
      if (timer !== undefined) clock.clearTimeout(timer)
      closed = false
      crashLoopSource = null
      const launched = beginLaunch(async () => {
        await stopInstance()
        await sweep()
        return launchLoop()
      })
      scheduleTick()
      return launched
    },

    checkNow: probe,

    async stop() {
      closed = true
      if (timer !== undefined) clock.clearTimeout(timer)
      // Cancel an in-flight launch instead of waiting out its full budget.
      currentLaunchAbort?.abort()
      await busy?.catch(() => {})
      await stopInstance()
      await sweep()
      setState("stopped")
    },

    status() {
      return {
        state,
        crashLoopSource,
        recentFailures: recentFailures(),
        bootId,
        lastHealth,
        instance,
      }
    },
  }
}
