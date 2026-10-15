/**
 * Managed Cloudflare Tunnel provider — `cloudflare-managed`.
 *
 * Where `cloudflare-named` RUNS a tunnel you provisioned by hand (BYO
 * credentials file, `hasApi: false`), this provider OWNS the whole thing
 * through the Cloudflare API: you declare `{ hostname, targetPort }`, it
 * creates the tunnel, its remote ingress and the proxied CNAME, runs
 * `cloudflared tunnel run` under a supervisor, probes the public hostname,
 * and deletes everything again on `destroy`. See
 * `cloudflare-managed-engine.ts` for the desired-state rules and the
 * ownership marking, `cloudflare-managed-config.ts` for the zone config.
 *
 * Secrets:
 *   - API tokens are resolved from per-zone `tokenRef`s at call time.
 *   - The tunnel connector token is fetched from the API on every start,
 *     held in memory only, and handed to cloudflared via `TUNNEL_TOKEN` in
 *     the child env — never argv (`ps` shows argv to every user), never
 *     persisted, and scrubbed from every log line this provider emits.
 *
 * `stop()` only stops cloudflared — the tunnel, ingress and DNS stay, so
 * the URL is stable across restarts and `start()` simply replays the
 * reconcile. `destroy()` is the delete.
 */

import { spawn } from "node:child_process"
import { execFile } from "node:child_process"
import { closeSync, openSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

import type { FetchLike } from "./cloudflare-api.js"
import {
  makeTokenResolver,
  normalizeHost,
  parseManagedZones,
  parseStoredTokens,
  type TokenResolver,
} from "./cloudflare-managed-config.js"
import { ManagedTunnelEngine, managedTunnelName } from "./cloudflare-managed-engine.js"
import {
  ProcessSupervisor,
  type ProcessSpawner,
  type ProcessSupervisorOptions,
  type SupervisedProcess,
} from "./process-supervisor.js"
import type {
  ProviderStartOptions,
  ProviderStartResult,
  RemoteProvider,
  TunnelHealth,
  TunnelIdentity,
  TunnelProviderHandle,
} from "./types.js"

const execFileAsync = promisify(execFile)

export const CLOUDFLARE_MANAGED_SLUG = "cloudflare-managed"

/** Stable, autostart-able, API-driven. */
export const MANAGED_CAPABILITIES = {
  stableUrl: true,
  autostart: true,
  customDomain: true,
  requiresAuth: true,
  hasApi: true,
} as const

export const MANAGED_SETUP_FIELDS = [
  {
    name: "zones",
    description:
      'cloudflare-managed: JSON array of zones the engine may write to, e.g. ' +
      '[{"zone":"example.com","accountId":"<id>","tokenRef":"env:CF_API_TOKEN","maxLabels":1}]. ' +
      "tokenRef is a REFERENCE (env:<VAR> | file:<0600 path> | keychain:<path> | stored:<key>), never a raw token.",
    required: true,
    sensitive: false,
  },
  {
    name: "zoneTokens",
    description:
      'cloudflare-managed: optional JSON object {"<key>":"<api token>"} kept only in the 0600 creds ' +
      'file, referenced from a zone as tokenRef "stored:<key>".',
    required: false,
    sensitive: true,
  },
] as const

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

export interface CloudflareManagedDeps {
  /** Cloudflare API + health-probe fetch. Defaults to the global fetch. */
  fetch?: FetchLike
  /** Separate fetch for health probes (defaults to `fetch`). */
  probeFetch?: FetchLike
  /** Process spawner. Defaults to the real `cloudflared` spawner. */
  spawner?: ProcessSpawner
  /** Token resolver. Defaults to env/file/keychain/stored resolution. */
  resolveToken?: TokenResolver
  /** Health probe period. Default 60s; 0 disables periodic probes. */
  healthIntervalMs?: number
  probeTimeoutMs?: number
  /** Supervisor tuning (backoff, crash-loop cap, clock seams). */
  supervisor?: Partial<Omit<ProcessSupervisorOptions, "spawner" | "request">>
  apiBaseUrl?: string
  /** Pre-flight binary check. Skipped when a custom spawner is injected. */
  checkBinary?: () => Promise<boolean>
}

type ManagedProvider = RemoteProvider &
  TunnelProviderHandle & {
    /** Current health, or null when not started (tests / diagnostics). */
    health(): TunnelHealth | null
    /** Run one health probe round now. */
    probeNow(): Promise<TunnelHealth | null>
  }

export function cloudflareManagedTunnelProvider(
  creds: Record<string, string> | null | undefined,
  deps: CloudflareManagedDeps = {},
): ManagedProvider {
  const fetchImpl: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const probeFetch = deps.probeFetch ?? fetchImpl

  let supervisor: ProcessSupervisor | null = null
  let secret: string | null = null
  let service: string | null = null
  let hostnames: string[] = []
  let probes: ProbeResult[] | null = null
  let supDetail = ""
  let cancelHealth: (() => void) | null = null
  let lastHealth: TunnelHealth | null = null
  let onHealth: ((h: TunnelHealth) => void) | undefined
  let cleanup: (() => void) | null = null
  let rawLog: ((line: string) => void) | undefined

  const redact = (line: string): string =>
    secret ? line.split(secret).join("[redacted]") : line
  const log = (line: string): void => rawLog?.(redact(line))

  const engine = (): ManagedTunnelEngine => {
    const zones = parseManagedZones(creds?.zones)
    return new ManagedTunnelEngine({
      zones,
      resolveToken:
        deps.resolveToken ??
        makeTokenResolver({ storedTokens: parseStoredTokens(creds?.zoneTokens) }),
      fetch: fetchImpl,
      ...(deps.apiBaseUrl ? { apiBaseUrl: deps.apiBaseUrl } : {}),
      onLog: log,
    })
  }

  const emitHealth = (): TunnelHealth | null => {
    if (!supervisor) return null
    const at = new Date().toISOString()
    let h: TunnelHealth
    if (supervisor.state === "failed") {
      h = { state: "error", reason: `cloudflared ${supDetail}`, checkedAt: at }
    } else if (supervisor.state === "restarting") {
      h = { state: "degraded", reason: `cloudflared ${supDetail}`, checkedAt: at }
    } else if (!probes) {
      h = { state: "degraded", reason: "awaiting first health probe", checkedAt: at }
    } else {
      const bad = probes.filter(p => !p.ok)
      h = bad.length
        ? {
            state: "degraded",
            reason: bad.map(p => `${p.hostname}: ${p.reason}`).join("; "),
            checkedAt: at,
          }
        : { state: "active", checkedAt: at }
    }
    if (probes) h.hostnames = probes.map(p => ({ ...p }))
    if (h.reason) h.reason = redact(h.reason)
    lastHealth = h
    onHealth?.(h)
    return h
  }

  const probeAll = async (): Promise<TunnelHealth | null> => {
    if (!supervisor) return null
    const targets = [...hostnames]
    const results = await Promise.all(
      targets.map(h => probeHostname(probeFetch, h, deps.probeTimeoutMs)),
    )
    if (!supervisor) return null
    probes = results
    return emitHealth()
  }

  return {
    id: "managed",
    slug: CLOUDFLARE_MANAGED_SLUG,
    name: "Cloudflare Managed Tunnel",
    version: "builtin",
    description:
      "Cloudflare tunnel created, routed (DNS) and deleted through the Cloudflare API — stable hostname on your zones.",
    requiresSetup: true,
    capabilities: { ...MANAGED_CAPABILITIES },
    setupFields: MANAGED_SETUP_FIELDS,

    validateSetup(fields: Record<string, string>): void {
      const zones = parseManagedZones(fields.zones)
      const stored = parseStoredTokens(fields.zoneTokens)
      for (const z of zones) {
        if (z.tokenRef.startsWith("stored:") && !(z.tokenRef.slice(7) in stored)) {
          throw new Error(
            `cloudflare-managed: zone "${z.zone}" references ${z.tokenRef} but zoneTokens has no such key`,
          )
        }
      }
    },

    async check(): Promise<boolean> {
      try {
        parseManagedZones(creds?.zones)
      } catch {
        return false
      }
      return deps.checkBinary ? deps.checkBinary() : cloudflaredOnPath()
    },

    async start(opts: ProviderStartOptions): Promise<ProviderStartResult> {
      const tunnel = opts.tunnel
      if (!tunnel || tunnel.hostnames.length === 0) {
        throw new Error('cloudflare-managed requires a "hostname" (e.g. app.example.com)')
      }
      if (supervisor) throw new Error("cloudflare-managed: provider already started")
      rawLog = opts.onLog
      onHealth = opts.onHealth
      const eng = engine()
      // Fail on config / zone problems before touching anything remote.
      eng.validateHostnames(tunnel.hostnames)
      if (!deps.spawner) {
        const ok = deps.checkBinary ? await deps.checkBinary() : await cloudflaredOnPath()
        if (!ok) throw new Error(CLOUDFLARED_MISSING)
      }

      service = `http://${opts.target.host}:${opts.target.port}`
      hostnames = tunnel.hostnames.map(normalizeHost)
      const rec = await eng.reconcile({ key: tunnel.key, hostnames }, service)
      secret = rec.token

      let spawner = deps.spawner
      if (!spawner) {
        const real = makeCloudflaredSpawner(opts.workspace, managedTunnelName(tunnel.key))
        spawner = real.spawner
        cleanup = real.cleanup
      }
      const sup = new ProcessSupervisor({
        ...deps.supervisor,
        spawner,
        // The token rides in the env only (cloudflared reads TUNNEL_TOKEN).
        request: { args: ["tunnel", "--no-autoupdate", "run"], env: { TUNNEL_TOKEN: rec.token } },
        onState: (state, detail) => {
          supDetail = detail
          log(`[cloudflare-managed] cloudflared ${state}: ${detail}`)
          if (supervisor) emitHealth()
        },
        onLog: log,
      })
      supervisor = sup
      try {
        sup.start()
      } catch (err) {
        supervisor = null
        secret = null
        throw new Error(
          `cloudflare-managed: failed to spawn cloudflared: ${redact(err instanceof Error ? err.message : String(err))}`,
        )
      }
      emitHealth()
      void probeAll()
      const interval = deps.healthIntervalMs ?? 60_000
      if (interval > 0) {
        const t = setInterval(() => void probeAll(), interval)
        t.unref?.()
        cancelHealth = () => clearInterval(t)
      }

      return {
        publicUrl: `https://${hostnames[0]}`,
        pid: sup.pid,
        tunnelId: rec.tunnelId,
      }
    },

    async stop(): Promise<void> {
      cancelHealth?.()
      cancelHealth = null
      const sup = supervisor
      supervisor = null
      probes = null
      lastHealth = null
      if (sup) await sup.stop()
      cleanup?.()
      cleanup = null
      secret = null
      service = null
    },

    async destroy(tunnel: TunnelIdentity): Promise<void> {
      await engine().destroy({ key: tunnel.key, hostnames: tunnel.hostnames })
    },

    async addHostname(tunnel: TunnelIdentity, hostname: string): Promise<void> {
      const h = normalizeHost(hostname)
      const next = [h, ...tunnel.hostnames.map(normalizeHost).filter(x => x !== h)]
      // Running → route with the live origin; stopped → keep the remote one.
      await engine().reconcile({ key: tunnel.key, hostnames: next }, service)
      if (supervisor) {
        hostnames = next
        void probeAll()
      }
    },

    async removeHostname(tunnel: TunnelIdentity, hostname: string): Promise<void> {
      const h = normalizeHost(hostname)
      await engine().removeHostname(
        { key: tunnel.key, hostnames: tunnel.hostnames },
        h,
      )
      if (supervisor) {
        hostnames = hostnames.filter(x => x !== h)
        void probeAll()
      }
    },

    health: () => lastHealth,
    probeNow: probeAll,
  }
}

const CLOUDFLARED_MISSING =
  "cloudflared not found on PATH. Install it first:\n" +
  "  macOS:    brew install cloudflared\n" +
  "  Linux:    https://pkg.cloudflare.com/index.html\n" +
  "  Windows:  winget install --id Cloudflare.cloudflared"

async function cloudflaredOnPath(): Promise<boolean> {
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
