/**
 * Deterministic managed-process runner for app `services:` (AIP-53 hosting).
 *
 * This replaces the previous supervision model, which spawned an LLM-prompted
 * owner SESSION (`spawnAgentSession` + `buildServiceOwnerPrompt`) whose agent
 * was trusted to run `entry` in a shell loop. The baseline is now the
 * `sessions` registry itself: this module spawns the service command as a
 * detached, non-PTY child process (`node:child_process.spawn`, `detached:
 * true`, pipes) and ADOPTS it in the registry (`registry.register`), so the
 * session list shows one `kind: "command"` row per live attempt — labels,
 * origin, argv, cwd, pid — with the registry wiring stdout/stderr into the
 * per-session output buffers (logs) and flipping `status` on exit.
 *
 * Restart is deterministic too: on an unexpected child exit the runner
 * respawns with exponential backoff (`baseDelayMs * factor^n`, capped at
 * `maxDelayMs`); when failures exceed `maxAttempts` inside `windowMs` it
 * stops and leaves the row (and the owner record) dead, so the next
 * install/boot ensure replaces it. There is still NO scheduler here.
 *
 * Structured declarations (`{ command, args, cwd }`) are preferred and run
 * argv-style with NO shell; a legacy `entry` string is run under
 * `sh -c <entry>` for shell compatibility (still one foreground process,
 * same group ⇒ group-kill cleanup covers it). Cleanup
 * (`killServiceProcess`) signals the child's PROCESS GROUP (`-pid` — the
 * spawn is a group leader), so grandchildren spawned by the service die with
 * it, then SIGKILLs anything that survived a grace poll.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from "node:fs"
import { dirname, join, resolve as nodeResolve } from "node:path"
import type { AppService } from "@agentproto/app-kit"
import { mintSessionId, APP_ID_ENV, SESSION_ID_ENV, type SessionsRegistry } from "./sessions.js"
import { serviceOwnerLabel } from "./app-services.js"

/**
 * Session ids of attempts that DIED but whose runner has a restart
 * dependency in flight (backoff timer scheduled). `ensureAppServiceOwners`'
 * `isOwnerAlive` consults this so a concurrent reinstall in the restart gap
 * sees "supervised — pending respawn" instead of double-spawning. Daemon
 * boot clears it naturally (no runners exist yet); `stop()` removes its
 * entries. Keyed by the registry row id.
 */
const restartPending = new Set<string>()

/** Is this registry row id a dead-but-restarting managed service attempt? */
export function isAppServicePendingRestart(sessionId: string): boolean {
  return restartPending.has(sessionId)
}

/** Absolute path of a service's durable log file (kept beside the app's
 *  daemon-owned state; the same `<stateDir>/services/` location the old
 *  owner-prompt pid files used). */
export function appServiceLogPath(stateDir: string, name: string): string {
  return join(stateDir, "services", `${name}.log`)
}

/** Fully-resolved, shell-free launch spec for one service process. */
export interface ServiceCommandSpec {
  /** Executable as argv[0] (or `sh` + `-c` + entry for a legacy command). */
  readonly argv: readonly string[]
  /** Absolute working directory for the child. */
  readonly cwd: string
}

/** One resolved service command, ready to spawn, plus its display string. */
export interface ResolvedServiceCommand {
  ok: true
  spec: ServiceCommandSpec
  /** Human-readable command line for the descriptor's `command` field. */
  display: string
  /** True when the legacy `entry` string is being routed through `sh -c`. */
  shell: boolean
}

export type ServiceCommandResolution =
  | ResolvedServiceCommand
  | { ok: false; error: string }

/**
 * Resolve a manifest `services:` entry into a concrete launch spec.
 * Structured `{ command, args, cwd }` is preferred and passed verbatim as
 * argv (never shell-interpreted); the legacy `entry` string runs under
 * `sh -c`. A relative `cwd` resolves against the app's installed `dir`.
 */
export function resolveServiceCommand(
  service: AppService,
  dir: string,
): ServiceCommandResolution {
  const cwd = resolveServiceCwd(service.cwd, dir)
  if (service.command !== undefined) {
    if (service.entry !== undefined) {
      return { ok: false, error: `service "${service.name}" declares both entry and command` }
    }
    const args = service.args ?? []
    return {
      ok: true,
      shell: false,
      spec: { argv: [service.command, ...args], cwd },
      display: [service.command, ...args].join(" "),
    }
  }
  if (service.entry === undefined) {
    return { ok: false, error: `service "${service.name}" declares neither entry nor command` }
  }
  return {
    ok: true,
    shell: true,
    spec: { argv: ["sh", "-c", service.entry], cwd },
    display: service.entry,
  }
}

function resolveServiceCwd(cwd: string | undefined, dir: string): string {
  return nodeResolve(dir, cwd ?? ".")
}

/** A live (or restarting) managed service process. */
export interface AppServiceProcess {
  /** Session id of the CURRENT attempt in the registry (fresh per respawn). */
  readonly sessionId: string
  /** Process-group leader pid of the current attempt, when known. */
  readonly pid: number | undefined
  /** The process' `/proc/<pid>/stat` start ticks at spawn time — the
   *  UNFORGEABLE identity token persisted with the owner record so a later
   *  boot reconcile signals the recorded pid ONLY if it still names the
   *  same live process (a recycled pid has different start ticks; see
   *  `isSameProcess`). */
  readonly startTicks: number | undefined
  /** True once stop() ran — no further spawn/restart will happen. */
  readonly disposed: boolean
  /** Stop the restart loop, kill the current process group, and flip the
   *  registry row to `killed` (`app_uninstall`'s cleanup). */
  stop(): Promise<void>
}

/** Restart policy for the deterministic supervisor. */
export interface AppServiceRestartPolicy {
  /** Unexpected exits inside `windowMs` tolerated before giving up. */
  maxAttempts: number
  baseDelayMs: number
  factor: number
  maxDelayMs: number
  /** Sliding window the attempt budget is measured in. */
  windowMs: number
}

export const DEFAULT_APP_SERVICE_RESTART_POLICY: AppServiceRestartPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 60_000,
  windowMs: 10 * 60_000,
}

/** Spawn one attempt's child. Injectable so unit tests never spawn a real
 *  process; the default goes through `node:child_process.spawn` with
 *  `detached: true` (own process group, killable as `-pid`). */
export type SpawnServiceChild = (
  spec: ServiceCommandSpec,
  opts: { id: string; env: Record<string, string> },
) => ChildProcess

/** Timer seam for the restart backoff — default `setTimeout`. Returns a
 *  canceler, invoked when the handle is stopped before the restart fires. */
export type ScheduleRestart = (fn: () => void, delayMs: number) => () => void

export interface StartAppServiceProcessDeps {
  registry: SessionsRegistry
  appId: string
  dir: string
  service: AppService
  /** Display label for the registry row. Defaults to
   *  `serviceOwnerLabel(appId, service.name)`. */
  label?: string
  workspaceSlug?: string
  /** Extra env on top of the daemon's process.env (e.g. PORT). */
  env?: Record<string, string>
  /** Append the child's stdout/stderr to this file in addition to the
   *  registry ring buffer (durable service log). Omitted = ring buffer only. */
  logFile?: string
  restart?: Partial<AppServiceRestartPolicy>
  spawnChild?: SpawnServiceChild
  schedule?: ScheduleRestart
  /** Clock seam (ms epoch) for the restart window — tests inject a fake. */
  now?: () => number
  /** Called after every successful (re)spawn so the caller can keep the
   *  persisted owner record (`sessionId`/`pid`) pointing at the LIVE
   *  attempt — uninstall then kills the right process group, not a dead
   *  ancestor attempt. */
  onRespawn?: (attempt: number, info: { sessionId: string; pid?: number; startTicks?: number }) => void
  /** Where a restart-exhausted / failed runner reports for ops. */
  onError?: (message: string) => void
}

export type StartAppServiceProcessResult =
  | { ok: true; handle: AppServiceProcess }
  | { ok: false; error: string }

/**
 * Start one managed service process deterministically: resolve the command,
 * spawn it detached (no PTY, no shell for a structured command, no LLM),
 * adopt it in the sessions registry, and supervise it with backoff. Sync on
 * the first attempt: the returned handle's `sessionId`/`pid` are live the
 * moment this resolves (spawn failure other than an immediate ENOENT is
 * surfaced via the registry row's `error` status).
 */
export function startAppServiceProcess(
  deps: StartAppServiceProcessDeps,
): StartAppServiceProcessResult {
  const policy: AppServiceRestartPolicy = { ...DEFAULT_APP_SERVICE_RESTART_POLICY, ...deps.restart }
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? defaultSchedule
  const spawnChild: SpawnServiceChild =
    deps.spawnChild ?? spawnDetachedChild
  const resolved = resolveServiceCommand(deps.service, deps.dir)
  if (!resolved.ok) return resolved
  const spec = resolved.spec
  const label = deps.label ?? serviceOwnerLabel(deps.appId, deps.service.name)
  const origin = `app-service:${deps.appId}`

  let disposed = false
  let attempt = 0
  let failStamps: number[] = []
  const lastIds: string[] = []
  let current: { id: string; pid: number | undefined; startTicks: number | undefined } | undefined
  let cancelScheduled: (() => void) | undefined

  const baseEnv = (): Record<string, string> => ({
    ...(process.env as Record<string, string>),
    ...(deps.env ?? {}),
  })

  const handle = (): AppServiceProcess => ({
    // The CURRENT attempt's row id; between a child's death and its next
    // spawn this stays pinned to the most recent attempt so callers
    // (owner-record bookkeeping, `registry.get`) never see a blank handle.
    get sessionId() {
      return current?.id ?? lastIds[lastIds.length - 1] ?? ""
    },
    get pid() {
      return current?.pid
    },
    get startTicks() {
      return current?.startTicks
    },
    get disposed() {
      return disposed
    },
    stop() {
      return stop()
    },
  })

  const stop = async (): Promise<void> => {
    if (!disposed) disposed = true
    cancelScheduled?.()
    cancelScheduled = undefined
    for (const id of lastIds) restartPending.delete(id)
    const target = current
    current = undefined
    if (target !== undefined) {
      await killServiceProcess(target.pid)
      try {
        deps.registry.kill(target.id)
      } catch {
        // Row already gone — same best-effort cleanup contract.
      }
    }
  }

  const childSpawnIds = new WeakMap<ChildProcess, string>()

  /** One death per child: `error` (ENOENT & friends) and `exit` can both
   *  fire, and the observation must not double-drive the restart budget. */
  const settled = new WeakSet<ChildProcess>()
  const settleChild = (child: ChildProcess): void => {
    if (disposed || settled.has(child) || current === undefined || current.id !== childSpawnIds.get(child)) return
    settled.add(child)
    const diedId = current.id
    current = undefined
    failStamps.push(now())
    failStamps = failStamps.filter(ts => ts > now() - policy.windowMs)
    if (failStamps.length >= policy.maxAttempts) {
      const message =
        `[app-services] service "${deps.appId}:${deps.service.name}" gave up after ` +
        `${failStamps.length} exits within ${policy.windowMs}ms — no further restarts`
      console.warn(message)
      deps.onError?.(message)
      restartPending.delete(diedId)
      return
    }
    // A scheduled restart is in flight — the session id of the dead attempt
    // is marked PENDING-RESTART so a concurrent `isOwnerAlive` (reinstall
    // racing the restart gap) sees "supervised, do not replace".
    restartPending.add(diedId)
    const delay = Math.min(
      policy.baseDelayMs * Math.pow(policy.factor, failStamps.length - 1),
      policy.maxDelayMs,
    )
    cancelScheduled = schedule(() => {
      cancelScheduled = undefined
      if (disposed) return
      attempt += 1
      launchAttempt()
    }, delay)
  }

  const launchAttempt = (): void => {
    const id = mintSessionId()
    let child: ChildProcess
    try {
      child = spawnChild(spec, {
        id,
        env: { ...baseEnv(), [SESSION_ID_ENV]: id, [APP_ID_ENV]: deps.appId },
      })
    } catch (err) {
      const message = `${deps.service.name}: spawn failed: ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[app-services] ${message}`)
      deps.onError?.(message)
      return
    }
    let logStream: WriteStream | undefined
    if (deps.logFile !== undefined) {
      try {
        // Best-effort parent dir creation — the state dir may not exist yet.
        mkdirSync(dirname(deps.logFile), { recursive: true })
      } catch {
        // The stream's own error path below surfaces it; spawn proceeds.
      }
      try {
        logStream = createWriteStream(deps.logFile, { flags: "a" })
        logStream.on("error", () => undefined) // never crash the daemon on a bad log path
        child.stdout?.pipe(logStream)
        child.stderr?.pipe(logStream)
      } catch {
        // A failing log file must not fail the spawn; the ring buffer still logs.
        logStream = undefined
      }
    }
    childSpawnIds.set(child, id)
    lastIds.push(id)
    // Identity stamp for the owner record — read IMMEDIATELY after spawn
    // (the child is alive; start ticks are fixed at process birth anyway).
    const startTicks = child.pid != null ? readProcessStartTicks(child.pid) : undefined
    current = { id, pid: child.pid ?? undefined, startTicks }
    const trail = attempt === 0 ? "" : ` (restart #${attempt})`
    try {
      deps.registry.register({
        child,
        id,
        workspaceSlug: deps.workspaceSlug ?? "default",
        command: `${resolved.display}${trail}`,
        label,
        origin,
        argv: [...spec.argv],
        cwd: spec.cwd,
      })
    } catch {
      // Registry refused (duplicate id — impossible with minted ids). The
      // child is still live and supervised by the exit handler below.
    }
    child.once("exit", () => {
      if (logStream !== undefined) logStream.end()
      settleChild(child)
    })
    child.once("error", () => {
      // ENOENT and friends fire `error` WITHOUT `exit` — settle now; the
      // `settled` guard makes a later `exit` a no-op.
      if (logStream !== undefined) logStream.end()
      settleChild(child)
    })
    deps.onRespawn?.(attempt, {
      sessionId: id,
      ...(child.pid !== null && child.pid !== undefined ? { pid: child.pid } : {}),
      ...(startTicks !== undefined ? { startTicks } : {}),
    })
  }

  launchAttempt()
  return { ok: true, handle: handle() }
}

function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const t = setTimeout(fn, delayMs)
  return () => clearTimeout(t)
}

// ── process identity (survives pid recycling) ───────────────────────────────

/**
 * The process' start ticks from `/proc/<pid>/stat` (field 22) — stable for
 * the lifetime of the machine's pid space, so a recycled pid never shares it
 * with its previous owner. `undefined` on a dead pid or a platform without
 * `/proc` — callers treat undefined as "identity unverifiable".
 */
export function readProcessStartTicks(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
    // The comm field may contain spaces AND parentheses — split on the LAST
    // ')' so field 22 is counted from the right.
    const close = raw.lastIndexOf(")")
    if (close < 0) return undefined
    const fields = raw.slice(close + 2).trim().split(/\s+/)
    // After comm, field 3 is the first entry; starttime is field 22 → index 19.
    const ticks = Number.parseInt(fields[19] ?? "", 10)
    return Number.isFinite(ticks) ? ticks : undefined
  } catch {
    return undefined
  }
}

/**
 * Decide whether a RECORDED service pid (from a previous daemon or an older
 * record) may still be signalled on-sight. A bare recorded pid must NEVER be
 * trusted blindly: pid recycling hands the SAME number to an unrelated
 * process, and the boot re-ensure would SIGTERM that stranger. Verdicts:
 *
 *   - no/invalid pid — skip;
 *   - start ticks recorded AND matching the live process' — kill (identity
 *     proven);
 *   - start ticks recorded and NOT matching — skip (recycled pid);
 *   - start ticks recorded but unreadable now — skip (identity
 *     unverifiable; per the audit contract never signal blind);
 *   - no start ticks in the record AND `/proc` is unavailable at all on
 *     this platform — kill (no stamp was ever possible; the pid is the only
 *     handle — non-Linux degradation);
 *   - no start ticks in the record but `/proc` says the pid IS live — skip
 *     + log: a stamped record would have proven it, without one this could
 *     be anybody's process.
 */
export function assessRecordedServicePid(
  pid: number | undefined,
  startTicks: number | undefined,
): { kill: boolean; reason: string } {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return { kill: false, reason: "no usable recorded pid" }
  }
  const current = readProcessStartTicks(pid)
  if (startTicks === undefined) {
    if (current === undefined) {
      // Either the pid is dead (nothing to signal anyway) or this platform
      // never exposes start ticks — the recorded pid is the only handle.
      return { kill: true, reason: "identity opaque (no /proc reading available)" }
    }
    return {
      kill: false,
      reason: `record lacks a start-ticks stamp and pid ${pid} is live — skip (possible recycled pid)`,
    }
  }
  if (current === undefined) {
    return { kill: false, reason: `cannot verify identity of pid ${pid} — skip` }
  }
  if (current !== startTicks) {
    return {
      kill: false,
      reason: `pid ${pid} was recycled (start ticks ${startTicks} ≠ ${current}) — skip`,
    }
  }
  return { kill: true, reason: "start-ticks identity match" }
}

/** The default child spawn: detached (own process group — the pid is the
 *  pgid `killServiceProcess` signals), stdin closed, stdout/stderr piped. */
function spawnDetachedChild(
  spec: ServiceCommandSpec,
  opts: { id: string; env: Record<string, string> },
): ChildProcess {
  const [bin, ...args] = spec.argv
  if (!bin) throw new Error("empty service argv")
  return spawn(bin, args, {
    cwd: spec.cwd,
    env: opts.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/**
 * Kill a service's process group (and its leader). `spawnDetachedChild`
 * makes the service child its own group leader, so `-pid` reaches every
 * descendant (`sh -c`, node, whatever the service forked). SIGTERM first,
 * then SIGKILL anything still alive after `graceMs` (default 500). Never
 * throws — ESRCH (already gone) / EPERM (not ours) are the common benign
 * cases, and a cleanup path must not fail on a stale pid.
 */
export async function killServiceProcess(
  pid: number | undefined,
  opts?: { graceMs?: number; pollMs?: number },
): Promise<void> {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal)
    } catch {
      // Group already reaped; fall back to the leader only.
    }
    try {
      process.kill(pid, signal)
    } catch {
      // Leader gone.
    }
  }
  const groupAlive = (): boolean => {
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
  }
  signalGroup("SIGTERM")
  const graceMs = opts?.graceMs ?? 500
  const pollMs = opts?.pollMs ?? 50
  const deadline = Date.now() + graceMs
  while (groupAlive() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs))
  }
  if (groupAlive()) signalGroup("SIGKILL")
}
