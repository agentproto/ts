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
  DNS_NOT_VISIBLE,
  defaultPublicDns,
  systemLookup as systemDnsLookup,
  waitForPublicDns,
  type DohResult,
  type PublicDns,
} from "./dns-resolver.js"
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

/** Public-DNS resolution + pinned transport for one probe. */
export interface ProbeDnsOptions {
  resolve(hostname: string): Promise<DohResult>
  /** Connect to the resolved address while keeping SNI/Host for `hostname`. */
  pinnedFetch?(hostname: string, address: string): FetchLike
  /** System resolver, used only when DoH itself is unreachable. */
  systemLookup?(hostname: string): Promise<string[]>
}

/**
 * Probe a public hostname with an unsigned request. Any answer from the app
 * itself (2xx-4xx, incl. the guard's 401 or the app's 404) means the
 * tunnel works; a Cloudflare edge 5xx (502/530/1033…) or a network failure
 * means it doesn't.
 *
 * With `dns`, the address comes from DNS-over-HTTPS and the connection is
 * pinned to it, so a negative answer cached by the host's system resolver
 * can never decide the verdict. The system resolver is a fallback only for
 * a DoH outage, after the hostname was confirmed visible at creation time.
 */
export async function probeHostname(
  fetchImpl: FetchLike,
  hostname: string,
  timeoutMs = 10_000,
  dns?: ProbeDnsOptions,
): Promise<ProbeResult> {
  let requestFetch = fetchImpl
  if (dns) {
    let resolution: DohResult
    try {
      resolution = await dns.resolve(hostname)
    } catch (err) {
      resolution = { kind: "unreachable", error: err instanceof Error ? err.message : String(err) }
    }
    if (resolution.kind === "no-answer") {
      return { hostname, ok: false, reason: DNS_NOT_VISIBLE }
    }
    if (resolution.kind === "answer") {
      const address = resolution.addresses[0]
      if (address && dns.pinnedFetch) requestFetch = dns.pinnedFetch(hostname, address)
    } else {
      try {
        const addresses = dns.systemLookup
          ? await dns.systemLookup(hostname)
          : await systemDnsLookup(hostname)
        const address = addresses[0]
        if (!address) return { hostname, ok: false, reason: `unreachable: no address for ${hostname}` }
        if (dns.pinnedFetch) requestFetch = dns.pinnedFetch(hostname, address)
      } catch (err) {
        return {
          hostname,
          ok: false,
          reason: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
  }
  try {
    const res = await requestFetch(`https://${hostname}/`, {
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
  /**
   * Public-DNS gate + pinned probe transport. Omit for the production DoH
   * resolver; `false` keeps the legacy system-resolver behaviour (tests).
   */
  publicDns?: PublicDns | false
  /** Total budget waiting for public DNS before `start()` returns. Default 60s. */
  dnsVisibleTimeoutMs?: number
  /** Background re-check period once the create wait gave up. Default 5s. */
  dnsRetryDelayMs?: number
  /** Clock / sleep seams for the DNS gate (tests). */
  dnsSleep?: (ms: number) => Promise<void>
  dnsRetrySleep?: (ms: number) => Promise<void>
  dnsNow?: () => number
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
  /**
   * The hostname was not visible on public DNS when the provider finished
   * waiting: report the pending reason and keep re-checking in the background.
   */
  dnsPending?: boolean
}

/** One supervised connector + its health loop. Not reusable after stop(). */
export class CloudflaredRunner {
  private readonly deps: CloudflaredRunnerDeps
  private readonly probeFetch: FetchLike
  private readonly publicDns: PublicDns | null
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
  private dnsPending = false
  private dnsWaitToken: { cancelled: boolean } | null = null

  constructor(deps: CloudflaredRunnerDeps = {}) {
    this.deps = deps
    this.probeFetch = deps.probeFetch ?? (globalThis.fetch as unknown as FetchLike)
    this.publicDns = deps.publicDns === false ? null : (deps.publicDns ?? defaultPublicDns())
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
    this.dnsPending = this.publicDns !== null && opts.dnsPending === true
    this.emitHealth()
    if (this.dnsPending) this.startDnsWait()
    else void this.probeNow()
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

  /**
   * Wait (bounded) until every hostname has a public A/AAAA answer. Called by
   * the providers before `start()` so the very first probe and the user's
   * first browser request never race the zone's propagation.
   */
  async awaitPublicDns(hostnames: string[]): Promise<boolean> {
    const dns = this.publicDns
    if (!dns) return true
    for (const hostname of hostnames) {
      const result = await waitForPublicDns(hostname, {
        resolve: h => dns.resolve(h),
        timeoutMs: this.deps.dnsVisibleTimeoutMs ?? 60_000,
        ...(this.deps.dnsSleep ? { sleep: this.deps.dnsSleep } : {}),
        ...(this.deps.dnsNow ? { now: this.deps.dnsNow } : {}),
      })
      if (result.kind !== "answer") return false
    }
    return true
  }

  async probeNow(): Promise<TunnelHealth | null> {
    if (!this.supervisor) return null
    if (this.dnsPending) {
      const visible = await this.checkDnsVisible(this.hostnames)
      if (!visible) return this.emitHealth()
      this.dnsPending = false
    }
    const targets = [...this.hostnames]
    const dns = this.publicDns
    const dnsOpts: ProbeDnsOptions | undefined = dns
      ? {
          resolve: h => dns.resolve(h),
          pinnedFetch: (h, address) => dns.pinnedFetch(h, address),
          systemLookup: h => dns.systemLookup(h),
        }
      : undefined
    const results = await Promise.all(
      targets.map(h => probeHostname(this.probeFetch, h, this.deps.probeTimeoutMs, dnsOpts)),
    )
    if (!this.supervisor) return null
    this.probes = results
    return this.emitHealth()
  }

  async stop(): Promise<void> {
    this.cancelHealth?.()
    this.cancelHealth = null
    if (this.dnsWaitToken) this.dnsWaitToken.cancelled = true
    this.dnsWaitToken = null
    this.dnsPending = false
    const sup = this.supervisor
    this.supervisor = null
    this.probes = null
    this.lastHealth = null
    if (sup) await sup.stop()
    this.cleanup?.()
    this.cleanup = null
    this.secret = null
  }

  private async checkDnsVisible(hostnames: string[]): Promise<boolean> {
    const dns = this.publicDns
    if (!dns) return true
    for (const hostname of hostnames) {
      const result = await dns.resolve(hostname).catch(
        (err: unknown): DohResult => ({
          kind: "unreachable",
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      if (result.kind !== "answer") return false
    }
    return true
  }

  private startDnsWait(): void {
    const token = { cancelled: false }
    this.dnsWaitToken = token
    const delay = this.deps.dnsRetryDelayMs ?? 5_000
    const sleep =
      this.deps.dnsRetrySleep ??
      this.deps.dnsSleep ??
      ((ms: number) =>
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, ms)
          timer.unref?.()
        }))
    void (async () => {
      while (!token.cancelled && this.supervisor && this.dnsPending) {
        await sleep(delay)
        if (token.cancelled || !this.supervisor) return
        await this.probeNow()
      }
    })()
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
    } else if (this.dnsPending) {
      h = { state: "degraded", reason: DNS_NOT_VISIBLE, checkedAt: at }
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
