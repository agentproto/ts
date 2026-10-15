/**
 * Keeps one long-running child (here: `cloudflared tunnel run`) alive —
 * restart on crash with exponential backoff, give up after a crash loop.
 *
 * The spawner is injected so tests drive supervision with a fake process
 * (cloudflared isn't installed in CI). Secrets go through `env`, never
 * `args`: argv is world-readable via `ps`, a child's environment is not.
 */

export interface SupervisedProcess {
  readonly pid: number | null
  kill(signal?: NodeJS.Signals): void
  /** Called exactly once when the process ends (or fails to start). */
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

export interface SpawnRequest {
  args: readonly string[]
  /** Extra env for the child. May hold secrets — never log it. */
  env: Record<string, string>
}

export type ProcessSpawner = (req: SpawnRequest) => SupervisedProcess

export type SupervisorState = "running" | "restarting" | "failed" | "stopped"

export interface ProcessSupervisorOptions {
  spawner: ProcessSpawner
  request: SpawnRequest
  /** First restart delay. Default 1s. */
  initialBackoffMs?: number
  /** Backoff ceiling. Default 60s. */
  maxBackoffMs?: number
  /** Give up after this many restarts inside `crashWindowMs`. Default 5. */
  maxRestarts?: number
  /** Crash-loop window. Default 5 min. */
  crashWindowMs?: number
  /** A run this long resets the backoff. Default 60s. */
  stableAfterMs?: number
  onState?: (state: SupervisorState, detail: string) => void
  onLog?: (line: string) => void
  /** Clock + timer seams for tests. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => () => void
}

const defaultSetTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

export class ProcessSupervisor {
  private readonly opts: ProcessSupervisorOptions
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => () => void
  private proc: SupervisedProcess | null = null
  private startedAt = 0
  private backoffMs: number
  private restartTimes: number[] = []
  private cancelRestart: (() => void) | null = null
  private exitWaiters: Array<() => void> = []
  private _state: SupervisorState = "stopped"
  private _restarts = 0

  constructor(opts: ProcessSupervisorOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.setTimer = opts.setTimer ?? defaultSetTimer
    this.backoffMs = opts.initialBackoffMs ?? 1_000
  }

  get state(): SupervisorState {
    return this._state
  }

  get restarts(): number {
    return this._restarts
  }

  get pid(): number | null {
    return this.proc?.pid ?? null
  }

  /** Spawn the child. Throws if the spawner throws synchronously. */
  start(): void {
    if (this._state === "running" || this._state === "restarting") return
    this.restartTimes = []
    this._restarts = 0
    this.backoffMs = this.opts.initialBackoffMs ?? 1_000
    this.spawnOnce()
  }

  /** Stop the child and cancel any pending restart. Idempotent. */
  async stop(): Promise<void> {
    this.cancelRestart?.()
    this.cancelRestart = null
    const proc = this.proc
    this.setState("stopped", "stopped")
    if (!proc) return
    const exited = new Promise<void>(resolve => this.exitWaiters.push(resolve))
    try {
      proc.kill("SIGTERM")
    } catch {
      /* already dead */
    }
    const cancelKill = this.setTimer(() => {
      try {
        proc.kill("SIGKILL")
      } catch {
        /* noop */
      }
    }, 3_000)
    await exited
    cancelKill()
  }

  private spawnOnce(): void {
    const proc = this.opts.spawner(this.opts.request)
    this.proc = proc
    this.startedAt = this.now()
    this.setState("running", `pid ${proc.pid ?? "?"}`)
    proc.onExit((code, signal) => this.handleExit(proc, code, signal))
  }

  private handleExit(
    proc: SupervisedProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.proc !== proc) return
    this.proc = null
    const waiters = this.exitWaiters
    this.exitWaiters = []
    waiters.forEach(w => w())
    if (this._state === "stopped") return

    const now = this.now()
    const stableAfter = this.opts.stableAfterMs ?? 60_000
    if (now - this.startedAt >= stableAfter) {
      this.backoffMs = this.opts.initialBackoffMs ?? 1_000
    }
    const window = this.opts.crashWindowMs ?? 5 * 60_000
    this.restartTimes = this.restartTimes.filter(t => now - t < window)
    const maxRestarts = this.opts.maxRestarts ?? 5
    const why = `exited (code=${code ?? "?"} signal=${signal ?? "-"})`
    this.opts.onLog?.(`[supervisor] child ${why}`)
    if (this.restartTimes.length >= maxRestarts) {
      this.setState(
        "failed",
        `crash loop: ${this.restartTimes.length} restarts within ${Math.round(window / 1000)}s, last ${why}`,
      )
      return
    }
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 60_000)
    this.setState("restarting", `${why}; restarting in ${delay}ms`)
    this.cancelRestart = this.setTimer(() => {
      this.cancelRestart = null
      if (this._state !== "restarting") return
      this.restartTimes.push(this.now())
      this._restarts++
      try {
        this.spawnOnce()
      } catch (err) {
        this.setState(
          "failed",
          `respawn failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }, delay)
  }

  private setState(state: SupervisorState, detail: string): void {
    this._state = state
    this.opts.onState?.(state, detail)
  }
}
