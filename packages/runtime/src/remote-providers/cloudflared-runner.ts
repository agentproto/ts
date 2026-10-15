/**
 * Shared runtime for tunnels whose Cloudflare side is managed remotely
 * (`config_src: "cloudflare"`): run `cloudflared tunnel run` under a
 * {@link ProcessSupervisor} with the connector token in `TUNNEL_TOKEN`,
 * probe the public hostnames, and fold both into a {@link TunnelHealth}.
 *
 * Used by `cloudflare-managed` (the daemon calls the Cloudflare API itself)
 * and `cloudflare-provisioned` (a remote provisioning service calls it and
 * hands back only the connector token). Neither knows how the other got
 * its token — this module only runs and watches the connector.
 */

import { spawn, execFile } from "node:child_process"
import { closeSync, openSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

import type { FetchLike } from "./cloudflare-api.js"
import {
  ProcessSupervisor,
  type ProcessSpawner,
  type ProcessSupervisorOptions,
  type SupervisedProcess,
} from "./process-supervisor.js"
import type { TunnelHealth } from "./types.js"

const execFileAsync = promisify(execFile)

/** Statuses Cloudflare's edge returns when the tunnel/origin is broken. */
const EDGE_FAILURE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])

export interface ProbeResult {
  hostname: string
  ok: boolean
  reason?: string
}

/**
 * Probe a public hostname with an unsigned request. Any answer from the app
 * itself (2xx-4xx, incl. the guard's 401 or the app's 404) means the
 * tunnel works; a Cloudflare edge 5xx (502/530/1033…) or a network failure
 * means it doesn't.
 */
export async function probeHostname(
  fetchImpl: FetchLike,
  hostname: string,
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`https://${hostname}/`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (EDGE_FAILURE_STATUSES.has(res.status)) {
      return { hostname, ok: false, reason: `edge returned ${res.status}` }
    }
    return { hostname, ok: true }
  } catch (err) {
    return {
      hostname,
      ok: false,
      reason: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export interface CloudflaredRunnerDeps {
  /** Health-probe fetch. Defaults to the global fetch. */
  probeFetch?: FetchLike
  /** Process spawner. Defaults to the real `cloudflared` spawner. */
  spawner?: ProcessSpawner
  /** Health probe period. Default 60s; 0 disables periodic probes. */
  healthIntervalMs?: number
  probeTimeoutMs?: number
  /** Supervisor tuning (backoff, crash-loop cap, clock seams). */
  supervisor?: Partial<Omit<ProcessSupervisorOptions, "spawner" | "request">>
  /** Pre-flight binary check. Skipped when a custom spawner is injected. */
  checkBinary?: () => Promise<boolean>
}

export interface CloudflaredRunnerStart {
  /** Connector token. SECRET — env only, scrubbed from every emitted line. */
  token: string
  hostnames: string[]
  /** Workspace for the sentinel config + log (real spawner only). */
  workspace: string
  /** File-name label for the sentinel config + log. */
  label: string
  onLog?: (line: string) => void
  onHealth?: (health: TunnelHealth) => void
}

/** One supervised connector + its health loop. Not reusable after stop(). */
export class CloudflaredRunner {
  private readonly deps: CloudflaredRunnerDeps
  private readonly probeFetch: FetchLike
  private supervisor: ProcessSupervisor | null = null
  private secret: string | null = null
  private hostnames: string[] = []
  private probes: ProbeResult[] | null = null
  private supDetail = ""
  private cancelHealth: (() => void) | null = null
  private lastHealth: TunnelHealth | null = null
  private onHealth: ((h: TunnelHealth) => void) | undefined
  private rawLog: ((line: string) => void) | undefined
  private cleanup: (() => void) | null = null

  constructor(deps: CloudflaredRunnerDeps = {}) {
    this.deps = deps
    this.probeFetch = deps.probeFetch ?? (globalThis.fetch as unknown as FetchLike)
  }

  get running(): boolean {
    return this.supervisor !== null
  }

  get pid(): number | null {
    return this.supervisor?.pid ?? null
  }

  /** Throws with install hints when cloudflared is missing (real spawner only). */
  async preflight(): Promise<void> {
    if (this.deps.spawner) return
    const ok = this.deps.checkBinary ? await this.deps.checkBinary() : await cloudflaredOnPath()
    if (!ok) throw new Error(CLOUDFLARED_MISSING)
  }

  redact(line: string): string {
    return this.secret ? line.split(this.secret).join("[redacted]") : line
  }

  log(line: string): void {
    this.rawLog?.(this.redact(line))
  }

  start(opts: CloudflaredRunnerStart): void {
    if (this.supervisor) throw new Error("cloudflared runner already started")
    this.rawLog = opts.onLog
    this.onHealth = opts.onHealth
    this.secret = opts.token
    this.hostnames = [...opts.hostnames]

    let spawner = this.deps.spawner
    if (!spawner) {
      const real = makeCloudflaredSpawner(opts.workspace, opts.label)
      spawner = real.spawner
      this.cleanup = real.cleanup
    }
    const sup = new ProcessSupervisor({
      ...this.deps.supervisor,
      spawner,
      // The token rides in the env only (cloudflared reads TUNNEL_TOKEN).
      request: { args: ["tunnel", "--no-autoupdate", "run"], env: { TUNNEL_TOKEN: opts.token } },
      onState: (state, detail) => {
        this.supDetail = detail
        this.log(`[cloudflared] ${state}: ${detail}`)
        if (this.supervisor) this.emitHealth()
      },
      onLog: line => this.log(line),
    })
    this.supervisor = sup
    try {
      sup.start()
    } catch (err) {
      this.supervisor = null
      const msg = this.redact(err instanceof Error ? err.message : String(err))
      this.secret = null
      throw new Error(`failed to spawn cloudflared: ${msg}`)
    }
    this.emitHealth()
    void this.probeNow()
    const interval = this.deps.healthIntervalMs ?? 60_000
    if (interval > 0) {
      const t = setInterval(() => void this.probeNow(), interval)
      t.unref?.()
      this.cancelHealth = () => clearInterval(t)
    }
  }

  /** Replace the probed hostname set (swap) and re-probe. */
  setHostnames(hostnames: string[]): void {
    this.hostnames = [...hostnames]
    if (this.supervisor) void this.probeNow()
  }

  health(): TunnelHealth | null {
    return this.lastHealth
  }

  async probeNow(): Promise<TunnelHealth | null> {
    if (!this.supervisor) return null
    const targets = [...this.hostnames]
    const results = await Promise.all(
      targets.map(h => probeHostname(this.probeFetch, h, this.deps.probeTimeoutMs)),
    )
    if (!this.supervisor) return null
    this.probes = results
    return this.emitHealth()
  }

  async stop(): Promise<void> {
    this.cancelHealth?.()
    this.cancelHealth = null
    const sup = this.supervisor
    this.supervisor = null
    this.probes = null
    this.lastHealth = null
    if (sup) await sup.stop()
    this.cleanup?.()
    this.cleanup = null
    this.secret = null
  }

  private emitHealth(): TunnelHealth | null {
    const sup = this.supervisor
    if (!sup) return null
    const at = new Date().toISOString()
    let h: TunnelHealth
    if (sup.state === "failed") {
      h = { state: "error", reason: `cloudflared ${this.supDetail}`, checkedAt: at }
    } else if (sup.state === "restarting") {
      h = { state: "degraded", reason: `cloudflared ${this.supDetail}`, checkedAt: at }
    } else if (!this.probes) {
      h = { state: "degraded", reason: "awaiting first health probe", checkedAt: at }
    } else {
      const bad = this.probes.filter(p => !p.ok)
      h = bad.length
        ? {
            state: "degraded",
            reason: bad.map(p => `${p.hostname}: ${p.reason}`).join("; "),
            checkedAt: at,
          }
        : { state: "active", checkedAt: at }
    }
    if (this.probes) h.hostnames = this.probes.map(p => ({ ...p }))
    if (h.reason) h.reason = this.redact(h.reason)
    this.lastHealth = h
    this.onHealth?.(h)
    return h
  }
}

export const CLOUDFLARED_MISSING =
  "cloudflared not found on PATH. Install it first:\n" +
  "  macOS:    brew install cloudflared\n" +
  "  Linux:    https://pkg.cloudflare.com/index.html\n" +
  "  Windows:  winget install --id Cloudflare.cloudflared"

export async function cloudflaredOnPath(): Promise<boolean> {
  try {
    await execFileAsync("cloudflared", ["--version"], { timeout: 3_000 })
    return true
  } catch {
    return false
  }
}

/**
 * The production spawner: `cloudflared tunnel --config <sentinel> …` with
 * stdout/stderr redirected to an owner-only log file (a pipe can wedge
 * cloudflared under a busy event loop — see cloudflared-spawn.ts) and the
 * sentinel config shielding us from `~/.cloudflared/config.yml`.
 */
export function makeCloudflaredSpawner(
  workspace: string,
  label: string,
): { spawner: ProcessSpawner; cleanup: () => void } {
  const dir = join(workspace, ".agentproto")
  const configPath = join(dir, `cloudflared-${label}.yml`)
  const logPath = join(dir, `cloudflared-${label}.log`)
  const spawner: ProcessSpawner = req => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      configPath,
      "# generated by agentproto-runtime — sentinel for a remotely-managed tunnel\n" +
        "no-autoupdate: true\nloglevel: info\n",
      { encoding: "utf8", mode: 0o600 },
    )
    const fd = openSync(logPath, "a", 0o600)
    chmodSync(logPath, 0o600)
    let child
    try {
      const [first, ...rest] = req.args
      child = spawn("cloudflared", [first ?? "tunnel", "--config", configPath, ...rest], {
        stdio: ["ignore", fd, fd],
        shell: false,
        env: { ...process.env, ...req.env },
      })
    } finally {
      closeSync(fd)
    }
    let exited = false
    const listeners: Array<(c: number | null, s: NodeJS.Signals | null) => void> = []
    const fire = (c: number | null, s: NodeJS.Signals | null): void => {
      if (exited) return
      exited = true
      listeners.forEach(l => l(c, s))
    }
    child.once("exit", (c, s) => fire(c, s))
    child.once("error", () => fire(null, null))
    const proc: SupervisedProcess = {
      pid: child.pid ?? null,
      kill: sig => {
        child.kill(sig)
      },
      onExit: cb => {
        listeners.push(cb)
      },
    }
    return proc
  }
  const cleanup = (): void => {
    for (const p of [configPath, logPath]) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* noop */
      }
    }
  }
  return { spawner, cleanup }
}
