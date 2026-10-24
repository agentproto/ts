/**
 * LlmEndpointRegistry — supervised-sidecar manager for the
 * `@agentproto/llm-endpoint` proxy gateway.
 *
 * The daemon spawns the llm-endpoint bin as a CHILD PROCESS (never an
 * in-process import — the runtime package has zero dependency on
 * @agentproto/llm-endpoint, exactly like it never imports cloudflared).
 * This is the single-sidecar analog of {@link TunnelRegistry}: one endpoint,
 * one port, an in-memory descriptor that tracks pid / port / status /
 * startedAt, and a start / stop / status lifecycle exposed over MCP.
 *
 * Lifecycle (mirrors RemoteController's singleton style — created fresh each
 * boot, state in memory; the child dies with the daemon so there is nothing
 * to reconcile on restart):
 *   start(input) → assemble env, spawn `node <bin> serve`, health-probe to
 *                  readiness, store descriptor. Idempotent: a call while the
 *                  endpoint is already running+healthy returns the existing
 *                  descriptor without spawning (like `start_browser`).
 *   status()     → descriptor + live `GET /v1/models` health probe.
 *   stop()       → SIGTERM the child, mark stopped (mirrors tunnel stop).
 *   shutdown()   → stop the child on daemon exit.
 *
 * Env on spawn (see {@link assembleLlmEndpointEnv}): the provider API keys
 * via `injectProviderKeysIntoEnv` (the same store llm-endpoint's own cli.ts
 * reads), `LLM_ENDPOINT_PORT` (default 18090), and `LLM_ENDPOINT_ACCESS_TOKENS`
 * when configured. Explicit env passed to `start` always wins.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { createRequire } from "node:module"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { injectProviderKeysIntoEnv } from "./providers-store.js"
import { injectLlmEndpointLinksIntoEnv } from "./llm-endpoint-links-store.js"

export type LlmEndpointStatus = "starting" | "running" | "stopped" | "error"

/** The `llm_endpoint_status` MCP contract — see {@link LlmEndpointRegistry.status}. */
export interface LlmEndpointStatusReport {
  running: boolean
  pid: number | null
  port: number | null
  baseUrl: string | null
  healthy: boolean
  startedAt: string | null
  status: LlmEndpointStatus | "never-started"
  /** Who is actually serving this endpoint. `"daemon"` — this registry's own
   *  spawn (or nothing at all). `"external"` — a healthy process on the same
   *  port that this registry did NOT spawn (e.g. a launchd KeepAlive
   *  sidecar); `pid` is unknown (always `null`) and `injectedProviders`, if
   *  present, was DERIVED by probing `/v1/models` rather than read off our
   *  own key-injection bookkeeping. */
  owner: "daemon" | "external"
  /** Whether upstream links persisted via `llm_endpoint_set_upstream_link`
   *  are actually applied to the process answering this port. Always
   *  `false` for `owner:"external"` — this registry never spawned it, so it
   *  never injected `LLM_ENDPOINT_PROFILE_<UPSTREAM>`; the operator must
   *  configure the external service's own env directly. */
  linksApplied: boolean
  lastError?: string
  injectedProviders?: string[]
  linkedProviders?: string[]
  /** `@agentproto/llm-endpoint`'s own package version, read from the
   *  resolved bin's `package.json` — best-effort, present only for
   *  `owner:"daemon"` (the version of the code this registry would spawn /
   *  did spawn). Undefined when unresolvable, or for `owner:"external"`
   *  (an adopted process exposes no version of its own to probe). */
  version?: string
}

/** Built-in default port — matches llm-endpoint's own `LLM_ENDPOINT_PORT` default. */
export const DEFAULT_LLM_ENDPOINT_PORT = 18090

export interface LlmEndpointDescriptor {
  pid: number | null
  port: number
  baseUrl: string
  status: LlmEndpointStatus
  startedAt: string
  stoppedAt?: string
  lastError?: string
  /** Provider names whose keys were injected into the child's env (never values). */
  injectedProviders?: string[]
  /** Upstream names mapped to an auth-profile link (`LLM_ENDPOINT_PROFILE_<P>`)
   *  in the child's env. Profile IDS, not secrets — but only the provider names
   *  are surfaced here, mirroring `injectedProviders`. */
  linkedProviders?: string[]
  /**
   * Only populated on the value returned by {@link LlmEndpointRegistry.start}
   * (never stored on the in-memory descriptor): `true` when the call reused an
   * already-running/starting child instead of spawning — so the caller can
   * tell a fresh `start` (new port/tokens applied) from a no-op idempotent hit
   * (old descriptor returned, nothing new applied). Mirrors `start_browser`.
   */
  wasAlreadyRunning?: boolean
}

export interface StartLlmEndpointInput {
  /** Port for the proxy. Defaults to LLM_ENDPOINT_PORT env, then 18090. */
  port?: number
  /** Value for `LLM_ENDPOINT_ACCESS_TOKENS` (comma/space-separated token list). */
  accessTokens?: string
  /** Extra env for the spawn. Explicit env always wins over injected keys/port. */
  env?: Record<string, string>
  /** Override the bin path (else resolved / `LLM_ENDPOINT_BIN`). */
  binPath?: string
}

/**
 * A spawned endpoint child. The registry keeps this as its live process and
 * drives it through `stop()`. Extracted as an interface so the spawn is a
 * test seam (mirrors TunnelRegistry's `pickProviderForTest`): tests override
 * {@link LlmEndpointRegistry.launch} to return a mock without a real process.
 */
export interface EndpointProcess {
  readonly pid: number | null
  /** SIGTERM (+ SIGKILL backstop). Idempotent — safe on an already-dead child. */
  stop(): Promise<void>
}

export interface LaunchOptions {
  binPath: string
  env: NodeJS.ProcessEnv
  port: number
  /** Absolute path for the child's stdout+stderr log file. */
  logPath: string
  onLog?: (line: string) => void
  /** Invoked once if the child exits (before an explicit stop). */
  onExit?: (info: { code: number | null; signal: string | null }) => void
}

export interface LlmEndpointRegistryOptions {
  /** Scratch dir for the child's log file. Defaults to ~/.agentproto. */
  workspace?: string
  onLog?: (line: string) => void
  /** Bin path override (else auto-resolved / `LLM_ENDPOINT_BIN`). */
  binPath?: string
  /**
   * Env-key injector — defaults to `injectProviderKeysIntoEnv`. Injected so
   * env assembly is unit-testable without touching the on-disk providers store.
   */
  injectKeys?: (env: NodeJS.ProcessEnv) => Promise<string[]>
  /**
   * Per-upstream link injector — defaults to `injectLlmEndpointLinksIntoEnv`.
   * Injected (like `injectKeys`) so env assembly is unit-testable without
   * touching the on-disk links store.
   */
  injectLinks?: (env: NodeJS.ProcessEnv) => Promise<string[]>
  /** This daemon's own loopback base URL + per-boot bearer, injected into
   *  EVERY spawn (including a crash-restart, which calls `start()` with no
   *  args) as `LLM_ENDPOINT_DAEMON_URL` / `LLM_ENDPOINT_DAEMON_TOKEN` — see
   *  `assembleLlmEndpointEnv`'s `daemonCallback` doc comment. Constructor-
   *  level (not a per-`start()` `env` override) precisely so it survives a
   *  restart the caller didn't supply args for. */
  daemonCallback?: { baseUrl: string; token: string }
  /** Max time `start` waits for the freshly-spawned child to answer health. */
  readyTimeoutMs?: number
  /** Poll interval for the readiness/health wait. */
  pollIntervalMs?: number
  /** Health-probe timeout for a single `GET /v1/models` request. */
  healthProbeTimeoutMs?: number
  /**
   * Crash-restart policy for an unexpected exit of an already-`running`
   * (i.e. previously healthy) child — never for a crash during the initial
   * startup window (that's surfaced synchronously as a thrown `start()`
   * error, the caller's to handle) and never for a `stop()`-driven exit.
   * Exponential backoff capped by a rolling-window retry limit — mirrors
   * the `restartPolicy` shape documented for agent-cli sessions (`on`,
   * `maxRetries`, `windowMs`, `baseDelayMs`, `factor`, `maxDelayMs`) in
   * spirit, not by reusing that exact type. Set `maxRetries: 0` to disable
   * (today's behavior — stay `error` until something calls `start()` again).
   */
  crashRestart?: {
    /** Max restart attempts within `windowMs` before giving up and staying
     *  `error`. Default 5. `0` disables crash-restart entirely. */
    maxRetries?: number
    /** Rolling window over which `maxRetries` is counted. Default 5 minutes. */
    windowMs?: number
    /** Delay before the first restart attempt. Default 1s. */
    baseDelayMs?: number
    /** Multiplier applied to the delay after each attempt. Default 2. */
    factor?: number
    /** Upper bound on the computed delay. Default 30s. */
    maxDelayMs?: number
  }
}

/**
 * Assemble the child's env: base env → provider keys (`injectProviderKeysIntoEnv`,
 * which never overwrites a pre-set var) → per-upstream profile links
 * (`injectLlmEndpointLinksIntoEnv`, `LLM_ENDPOINT_PROFILE_<P>=<profileId>`, also
 * never overwriting a pre-set var) → `LLM_ENDPOINT_PORT` → optional
 * `LLM_ENDPOINT_ACCESS_TOKENS` → explicit `env` overrides last (explicit wins).
 *
 * The link injection sits AFTER the provider keys and BEFORE the explicit-env
 * merge, so an explicit `LLM_ENDPOINT_PROFILE_*` passed to `start` still wins,
 * exactly like an explicit provider key does. A link maps an upstream to a
 * named auth-profile the proxy reads via `resolveUpstreamCredential`.
 *
 * The effective port honors an explicit `LLM_ENDPOINT_PORT` in `explicitEnv`
 * first, then the `port` arg, then the default — and is returned so the
 * descriptor and the child's env can never drift.
 */
export async function assembleLlmEndpointEnv(input: {
  port?: number
  accessTokens?: string
  explicitEnv?: Record<string, string>
  baseEnv?: NodeJS.ProcessEnv
  injectKeys?: (env: NodeJS.ProcessEnv) => Promise<string[]>
  injectLinks?: (env: NodeJS.ProcessEnv) => Promise<string[]>
  /**
   * This DAEMON's own loopback base URL (`http://127.0.0.1:<daemon port>`)
   * and per-boot bearer — injected as `LLM_ENDPOINT_DAEMON_URL` /
   * `LLM_ENDPOINT_DAEMON_TOKEN` so the sidecar can call back into THIS
   * daemon's `/devices/:id/exec-stream` to route a `<endpoint>@<device>`
   * model (DEVICES-PLAN item 2) — a different daemon than whatever
   * `LLM_ENDPOINT_PORT` the sidecar itself binds. Absent when the caller
   * (e.g. a standalone `agentproto llm gateway` invocation with no daemon)
   * has nothing to inject.
   */
  daemonCallback?: { baseUrl: string; token: string }
}): Promise<{
  env: NodeJS.ProcessEnv
  port: number
  injectedProviders: string[]
  linkedProviders: string[]
}> {
  const env: NodeJS.ProcessEnv = { ...(input.baseEnv ?? process.env) }
  const inject = input.injectKeys ?? injectProviderKeysIntoEnv
  const injectedProviders = await inject(env)
  // Per-upstream profile links, after keys, before the explicit-env merge —
  // an explicit LLM_ENDPOINT_PROFILE_* override still wins (injected via a seam
  // so env assembly is unit-testable without touching the on-disk links store).
  const injectLinks = input.injectLinks ?? injectLlmEndpointLinksIntoEnv
  const linkedProviders = await injectLinks(env)

  // Effective port: an explicit LLM_ENDPOINT_PORT in the override env wins,
  // then the `port` arg, then the built-in default. Resolved up front so the
  // descriptor names the port the child actually binds.
  const explicitPortRaw = input.explicitEnv?.LLM_ENDPOINT_PORT
  const explicitPort =
    explicitPortRaw != null ? Number.parseInt(explicitPortRaw, 10) : NaN
  const port =
    Number.isFinite(explicitPort) && explicitPort > 0
      ? explicitPort
      : input.port ?? DEFAULT_LLM_ENDPOINT_PORT

  env.LLM_ENDPOINT_PORT = String(port)
  if (input.accessTokens != null && input.accessTokens !== "") {
    env.LLM_ENDPOINT_ACCESS_TOKENS = input.accessTokens
  }
  if (input.daemonCallback) {
    env.LLM_ENDPOINT_DAEMON_URL = input.daemonCallback.baseUrl
    env.LLM_ENDPOINT_DAEMON_TOKEN = input.daemonCallback.token
  }
  // Explicit env wins over the injected keys/tokens above…
  if (input.explicitEnv) {
    for (const [k, v] of Object.entries(input.explicitEnv)) env[k] = v
  }
  // …but re-assert the resolved port so env and descriptor stay in lock-step
  // even if explicitEnv carried a differently-formatted LLM_ENDPOINT_PORT.
  env.LLM_ENDPOINT_PORT = String(port)

  return { env, port, injectedProviders, linkedProviders }
}

/**
 * Locate the llm-endpoint bin without a package dependency (the same stance
 * as cloudflared — an external binary found at spawn time, with an override):
 *   1. explicit `override` arg / `LLM_ENDPOINT_BIN` env,
 *   2. Node resolution of `@agentproto/llm-endpoint` (published/hoisted layouts),
 *   3. the monorepo sibling relative to this module's built location.
 * Returns the first path that exists; throws a clear, actionable error rather
 * than handing back a non-existent path that would spawn a dead child.
 */
export function resolveLlmEndpointBin(override?: string): string {
  const explicit = override ?? process.env.LLM_ENDPOINT_BIN
  if (explicit) {
    // An explicit override must exist — otherwise the spawn fails opaquely
    // ("exited code=1") and the operator can't tell the path was wrong.
    if (!existsSync(explicit)) {
      const src = override != null ? "binPath override" : "LLM_ENDPOINT_BIN env"
      throw new Error(
        `llm-endpoint bin not found at ${JSON.stringify(explicit)} (from ${src}).`,
      )
    }
    return explicit
  }

  // Node resolution — works when the package is installed & resolvable here.
  try {
    const req = createRequire(import.meta.url)
    const pkgJson = req.resolve("@agentproto/llm-endpoint/package.json")
    const bin = join(dirname(pkgJson), "dist", "cli.mjs")
    if (existsSync(bin)) return bin
  } catch {
    // not resolvable from the runtime package — fall through to the sibling.
  }

  // Monorepo sibling: this module builds into <root>/packages/runtime/dist,
  // llm-endpoint sits alongside at <root>/packages/llm-endpoint/dist/cli.mjs.
  const hereDir = dirname(fileURLToPath(import.meta.url))
  const sibling = resolve(hereDir, "..", "..", "llm-endpoint", "dist", "cli.mjs")
  if (!existsSync(sibling)) {
    throw new Error(
      "llm-endpoint bin not found (is @agentproto/llm-endpoint built? run " +
        `pnpm build). Tried node resolution of @agentproto/llm-endpoint and ` +
        `the monorepo sibling at ${JSON.stringify(sibling)}. Set LLM_ENDPOINT_BIN ` +
        "or pass binPath to override.",
    )
  }
  return sibling
}

export class LlmEndpointRegistry {
  private desc: LlmEndpointDescriptor | null = null
  private proc: EndpointProcess | null = null
  private exited = false
  /**
   * In-flight `start` promise. Set synchronously at the very top of `start`
   * before any `await`, cleared in its `finally`. Guarantees no two
   * `launch()` calls are ever in flight for one registry: concurrent callers
   * (and re-entrant idempotent hits) join this same promise instead of racing
   * past the null-check and spawning a second, orphan-prone child.
   */
  private starting: Promise<LlmEndpointDescriptor> | undefined
  private readonly workspace: string
  private readonly onLog: ((line: string) => void) | undefined
  private readonly binPath: string | undefined
  private readonly injectKeys:
    | ((env: NodeJS.ProcessEnv) => Promise<string[]>)
    | undefined
  private readonly injectLinks:
    | ((env: NodeJS.ProcessEnv) => Promise<string[]>)
    | undefined
  private readonly daemonCallback: { baseUrl: string; token: string } | undefined
  private readonly readyTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly healthProbeTimeoutMs: number
  private readonly crashRestartMaxRetries: number
  private readonly crashRestartWindowMs: number
  private readonly crashRestartBaseDelayMs: number
  private readonly crashRestartFactor: number
  private readonly crashRestartMaxDelayMs: number
  /** Timestamps (ms) of recent crash-restart attempts, pruned to the
   *  rolling window on each unexpected exit. */
  private restartAttempts: number[] = []
  private restartTimer: NodeJS.Timeout | undefined
  /** Memoized result of {@link resolveVersionBestEffort} — `null` once a
   *  resolution attempt fails, so a permanently-unresolvable bin doesn't
   *  re-read the filesystem on every `status()` call. */
  private cachedVersion: string | null | undefined

  constructor(opts: LlmEndpointRegistryOptions = {}) {
    this.workspace = opts.workspace ?? homedir()
    this.onLog = opts.onLog
    this.binPath = opts.binPath
    this.injectKeys = opts.injectKeys
    this.injectLinks = opts.injectLinks
    this.daemonCallback = opts.daemonCallback
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 6_000
    this.pollIntervalMs = opts.pollIntervalMs ?? 200
    this.healthProbeTimeoutMs = opts.healthProbeTimeoutMs ?? 3_000
    this.crashRestartMaxRetries = opts.crashRestart?.maxRetries ?? 5
    this.crashRestartWindowMs = opts.crashRestart?.windowMs ?? 5 * 60_000
    this.crashRestartBaseDelayMs = opts.crashRestart?.baseDelayMs ?? 1_000
    this.crashRestartFactor = opts.crashRestart?.factor ?? 2
    this.crashRestartMaxDelayMs = opts.crashRestart?.maxDelayMs ?? 30_000
  }

  /**
   * Ensure the proxy is running. Idempotent: if it is already running and a
   * live health probe passes (or still `starting`), returns the existing
   * descriptor without spawning a second child (mirrors `start_browser`'s
   * wasAlreadyRunning).
   *
   * Concurrency-safe: a start already in flight is joined rather than
   * duplicated, so two concurrent calls can never both spawn — a second child
   * would race for the port and one would be orphaned, outliving daemon
   * shutdown with the injected credentials still in its env.
   */
  async start(input: StartLlmEndpointInput = {}): Promise<LlmEndpointDescriptor> {
    // In-flight dedup — set synchronously, before any `await`. A concurrent
    // (or re-entrant) caller joins the same promise instead of spawning again.
    if (this.starting) {
      const desc = await this.starting
      return { ...desc, wasAlreadyRunning: true }
    }
    const p = this.startInternal(input)
    this.starting = p
    try {
      return await p
    } finally {
      this.starting = undefined
    }
  }

  private async startInternal(
    input: StartLlmEndpointInput,
  ): Promise<LlmEndpointDescriptor> {
    // Idempotent fast-path — already up and answering.
    if (this.proc && this.desc && this.desc.status === "running") {
      if (await this.probeHealth(this.desc.baseUrl)) {
        return { ...this.desc, wasAlreadyRunning: true }
      }
      // Stale descriptor (child gone/unhealthy) — tear it down and respawn.
      await this.stopInternal()
    }
    // Still coming up from a prior call that timed out its readiness window —
    // the child is live and booting, so don't spawn a second one.
    if (this.proc && this.desc && this.desc.status === "starting") {
      return { ...this.desc, wasAlreadyRunning: true }
    }

    // Resolve (and validate) the bin first — fail fast before assembling env
    // / injecting provider keys into a spawn that could never launch.
    const binPath = resolveLlmEndpointBin(input.binPath ?? this.binPath)
    const { env, port, injectedProviders, linkedProviders } = await assembleLlmEndpointEnv({
      ...(input.port != null ? { port: input.port } : {}),
      ...(input.accessTokens != null ? { accessTokens: input.accessTokens } : {}),
      ...(input.env ? { explicitEnv: input.env } : {}),
      ...(this.injectKeys ? { injectKeys: this.injectKeys } : {}),
      ...(this.injectLinks ? { injectLinks: this.injectLinks } : {}),
      ...(this.daemonCallback ? { daemonCallback: this.daemonCallback } : {}),
    })
    const baseUrl = `http://127.0.0.1:${port}`

    const startedAt = new Date().toISOString()
    this.exited = false
    this.desc = {
      pid: null,
      port,
      baseUrl,
      status: "starting",
      startedAt,
      injectedProviders,
      linkedProviders,
    }

    const logDir = join(this.workspace, ".agentproto")
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, `llm-endpoint-${port}.log`)

    let proc: EndpointProcess
    try {
      proc = await this.launch({
        binPath,
        env,
        port,
        logPath,
        ...(this.onLog ? { onLog: this.onLog } : {}),
        onExit: info => {
          this.exited = true
          // Only surface an unexpected exit; a `stop()` clears `this.proc`
          // first so a stop-driven exit doesn't flip the descriptor to error.
          if (this.proc && this.desc && this.desc.status !== "stopped") {
            // Captured BEFORE overwriting below — only a crash of an
            // already-`running` (previously healthy) child schedules a
            // crash-restart. A crash during the startup window is instead
            // surfaced synchronously as a thrown `start()` error (see the
            // readiness loop below), which the caller (e.g. boot autostart)
            // already handles; auto-restarting it here too would race that.
            const wasRunning = this.desc.status === "running"
            this.desc.status = "error"
            this.desc.pid = null
            // Surface the captured log tail so the real reason is visible
            // instead of an opaque `exited (code=1)` — mirrors cloudflared-spawn.
            this.desc.lastError =
              `llm-endpoint exited (code=${info.code ?? "?"}, signal=${info.signal ?? "-"}).\n` +
              `llm-endpoint output (tail):\n${tailFile(logPath, 20)}`
            this.onLog?.(`[llm-endpoint] ${this.desc.lastError}`)
            if (wasRunning) this.scheduleCrashRestart()
          }
        },
      })
    } catch (err) {
      this.desc.status = "error"
      this.desc.lastError = err instanceof Error ? err.message : String(err)
      throw err
    }

    this.proc = proc
    this.desc.pid = proc.pid

    // Bounded readiness wait — poll health until the child answers, it exits
    // early, or the window elapses. On timeout the child is left `starting`
    // (still booting) and callers poll `status`, mirroring start_browser.
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      if (this.exited) {
        // onExit already flipped the descriptor to `error`.
        throw new Error(this.desc.lastError ?? "llm-endpoint exited during startup")
      }
      if (await this.probeHealth(baseUrl)) {
        this.desc.status = "running"
        return { ...this.desc, wasAlreadyRunning: false }
      }
      if (Date.now() >= deadline) break
      await delay(this.pollIntervalMs)
    }

    return { ...this.desc, wasAlreadyRunning: false }
  }

  /** Current descriptor (in-memory), or undefined if never started. */
  get(): LlmEndpointDescriptor | undefined {
    return this.desc ? { ...this.desc } : undefined
  }

  /**
   * Descriptor + a live health probe. Shape matches the MCP `llm_endpoint_status`
   * contract: {running, pid, port, baseUrl, healthy, startedAt}.
   *
   * D5: `running:false` together with `healthy:true` must never both be
   * reported — that self-contradiction is exactly what happened when a
   * launchd-owned (or otherwise externally-spawned) llm-endpoint already
   * held the port: OUR spawn attempt lost the race (EADDRINUSE), recorded
   * `status:"error"` (⇒ `running:false`), while the live health probe below
   * runs regardless of `status` and answers `true` against the OTHER,
   * perfectly healthy process. Rather than reporting our own failed spawn as
   * the whole truth, ADOPT: when we're not running but the port answers
   * healthy, report `running:true, owner:"external"` (pid unknown — it isn't
   * ours), and derive the served provider list by probing `/v1/models`
   * itself (our own `injectedProviders` bookkeeping is about keys WE
   * injected, which is meaningless for a process we never spawned).
   */
  async status(): Promise<LlmEndpointStatusReport> {
    const version = this.resolveVersionBestEffort()
    if (!this.desc) {
      return {
        running: false,
        pid: null,
        port: null,
        baseUrl: null,
        healthy: false,
        startedAt: null,
        status: "never-started",
        owner: "daemon",
        linksApplied: false,
        ...(version ? { version } : {}),
      }
    }
    const running = this.desc.status === "running" || this.desc.status === "starting"
    const healthy =
      this.desc.status === "stopped"
        ? false
        : await this.probeHealth(this.desc.baseUrl)
    if (!running && healthy) {
      const servedProviders = await this.probeModels(this.desc.baseUrl)
      return {
        running: true,
        pid: null,
        port: this.desc.port,
        baseUrl: this.desc.baseUrl,
        healthy: true,
        startedAt: null,
        status: "running",
        owner: "external",
        // Persisted upstream links (`llm_endpoint_set_upstream_link`) are
        // injected only into a env THIS registry assembles for ITS OWN
        // spawn — an externally-owned process was never spawned by us, so
        // they were never applied to it. The operator must configure the
        // service's own env directly.
        linksApplied: false,
        ...(servedProviders.length > 0 ? { injectedProviders: servedProviders } : {}),
      }
    }
    return {
      running,
      pid: this.desc.pid,
      port: this.desc.port,
      baseUrl: this.desc.baseUrl,
      healthy,
      startedAt: this.desc.startedAt,
      status: this.desc.status,
      owner: "daemon",
      linksApplied: running,
      ...(this.desc.lastError ? { lastError: this.desc.lastError } : {}),
      ...(this.desc.injectedProviders
        ? { injectedProviders: this.desc.injectedProviders }
        : {}),
      ...(this.desc.linkedProviders
        ? { linkedProviders: this.desc.linkedProviders }
        : {}),
      ...(version ? { version } : {}),
    }
  }

  /** SIGTERM the child and mark the descriptor stopped. Idempotent. */
  async stop(): Promise<boolean> {
    if (!this.desc) return false
    if (this.desc.status === "stopped") return true
    await this.stopInternal()
    return true
  }

  /** Called on daemon exit — stop the child if it's live. */
  async shutdown(): Promise<void> {
    if (this.proc) await this.stopInternal()
  }

  /**
   * Schedule a restart after an unexpected exit of a previously-`running`
   * child. Exponential backoff (`baseDelayMs * factor^attempt`, capped at
   * `maxDelayMs`), bounded by `maxRetries` attempts within the rolling
   * `windowMs` window — once exceeded, gives up and stays `error` until an
   * operator (or the lazy self-heal in `spawnAgentSession`) calls `start()`
   * again. The scheduled retry itself goes through the public `start()`,
   * so it's subject to the same in-flight dedup as any other caller.
   */
  private scheduleCrashRestart(): void {
    if (this.crashRestartMaxRetries <= 0) return
    const now = Date.now()
    this.restartAttempts = this.restartAttempts.filter(
      t => now - t < this.crashRestartWindowMs,
    )
    if (this.restartAttempts.length >= this.crashRestartMaxRetries) {
      this.onLog?.(
        `[llm-endpoint] crash-restart: giving up after ${this.restartAttempts.length} ` +
          `attempt(s) within ${this.crashRestartWindowMs}ms — staying "error". ` +
          "Call llm_endpoint_start (or `agentproto llm gateway restart`) to retry manually.",
      )
      return
    }
    const attempt = this.restartAttempts.length
    this.restartAttempts.push(now)
    const delay = Math.min(
      this.crashRestartBaseDelayMs * this.crashRestartFactor ** attempt,
      this.crashRestartMaxDelayMs,
    )
    this.onLog?.(
      `[llm-endpoint] unexpected exit of a running child — scheduling crash-restart ` +
        `attempt ${attempt + 1}/${this.crashRestartMaxRetries} in ${delay}ms`,
    )
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const timer = setTimeout(() => {
      this.restartTimer = undefined
      this.start().catch(err => {
        this.onLog?.(
          `[llm-endpoint] crash-restart attempt ${attempt + 1} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }, delay)
    timer.unref?.()
    this.restartTimer = timer
  }

  /**
   * Best-effort `@agentproto/llm-endpoint` package version, read from the
   * resolved bin's `package.json` (memoized — a permanently-unresolvable
   * bin, e.g. never built, shouldn't re-hit the filesystem on every
   * `status()` call). Returns `undefined` rather than throwing so a missing
   * bin never turns `status()` itself into a failure.
   */
  private resolveVersionBestEffort(): string | undefined {
    if (this.cachedVersion !== undefined) return this.cachedVersion ?? undefined
    try {
      const bin = resolveLlmEndpointBin(this.binPath)
      const pkgJsonPath = join(dirname(bin), "..", "package.json")
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: unknown }
      this.cachedVersion = typeof pkg.version === "string" ? pkg.version : null
    } catch {
      this.cachedVersion = null
    }
    return this.cachedVersion ?? undefined
  }

  private async stopInternal(): Promise<void> {
    // A deliberate stop cancels any pending crash-restart — the operator
    // asked for this to be down, a scheduled retry must not undo that.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const proc = this.proc
    // Clear `this.proc` before killing so the onExit callback treats the
    // resulting exit as expected (doesn't flip status to error).
    this.proc = null
    if (this.desc) {
      this.desc.status = "stopped"
      this.desc.stoppedAt = new Date().toISOString()
      this.desc.pid = null
    }
    if (proc) {
      try {
        await proc.stop()
      } catch {
        // best-effort — child may already be dead
      }
    }
  }

  // ── test seams ─────────────────────────────────────────────────────
  // Subclasses (tests) override `launch`/`probeHealth` to drive the state
  // machine without a real process — the same seam style TunnelRegistry uses
  // via `pickProviderForTest`.

  /** Spawn `node <bin> serve` with stdout+stderr redirected to a file. */
  protected async launch(opts: LaunchOptions): Promise<EndpointProcess> {
    // Redirect stdout+stderr to a file rather than a pipe — the same
    // back-pressure hazard cloudflared-spawn.ts documents: a busy daemon
    // event loop can stall a child whose pipe buffer fills. File writes
    // never block.
    // 0o600: the log can contain credential-adjacent request detail — match
    // the package's secret-file convention (agentproto-dir, remaining-quota-store).
    const logFd = openSync(opts.logPath, "a", 0o600)
    let child: ChildProcess
    try {
      child = spawn(process.execPath, [opts.binPath, "serve"], {
        env: opts.env,
        stdio: ["ignore", logFd, logFd],
        shell: false,
      })
    } finally {
      closeSync(logFd)
    }

    let onExitFired = false
    const fireExit = (code: number | null, signal: string | null): void => {
      if (onExitFired) return
      onExitFired = true
      opts.onExit?.({ code, signal })
    }
    child.once("error", err => {
      opts.onLog?.(`[llm-endpoint] spawn error: ${err.message}`)
      fireExit(null, null)
    })
    child.once("exit", (code, signal) => fireExit(code, signal))

    return {
      pid: child.pid ?? null,
      async stop(): Promise<void> {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill("SIGTERM")
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {
            /* noop */
          }
        }, 3_000)
        timer.unref()
        await new Promise<void>(res => {
          if (child.exitCode !== null) {
            clearTimeout(timer)
            res()
            return
          }
          child.once("exit", () => {
            clearTimeout(timer)
            res()
          })
        })
      },
    }
  }

  /** Probe `GET <baseUrl>/v1/models` — true on a 2xx. */
  protected async probeHealth(baseUrl: string): Promise<boolean> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.healthProbeTimeoutMs)
    try {
      const r = await fetch(`${baseUrl}/v1/models`, { signal: ac.signal })
      return r.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Fetch `GET <baseUrl>/v1/models` and extract the distinct `owned_by`
   * provider names from its OpenAI-style `{data:[{owned_by}]}` body — the
   * provider list for a process this registry did NOT spawn (D5 adoption),
   * so `injectedProviders` (the field the UI already reads) can still name
   * what an externally-owned endpoint is actually serving. Best-effort:
   * returns `[]` on any request/parse failure or shape mismatch rather than
   * throwing — the caller already knows `probeHealth` succeeded; this is
   * enrichment, not another readiness gate.
   */
  protected async probeModels(baseUrl: string): Promise<string[]> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.healthProbeTimeoutMs)
    try {
      const r = await fetch(`${baseUrl}/v1/models`, { signal: ac.signal })
      if (!r.ok) return []
      const body = (await r.json()) as { data?: Array<{ owned_by?: unknown }> }
      const owners = new Set<string>()
      for (const m of body.data ?? []) {
        if (typeof m.owned_by === "string" && m.owned_by.length > 0) owners.add(m.owned_by)
      }
      return [...owners].sort()
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(res => {
    const t = setTimeout(res, ms)
    if (t.unref) t.unref()
  })
}

/** Last `n` non-empty lines of the child's log file, for error surfacing. */
function tailFile(path: string, n: number): string {
  try {
    const lines = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(l => l.length > 0)
    return lines.slice(-n).join("\n") || "(no llm-endpoint output captured)"
  } catch {
    return "(no llm-endpoint output captured)"
  }
}
