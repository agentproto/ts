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
  CloudflaredRunner,
  cloudflaredOnPath,
  type CloudflaredRunnerDeps,
} from "./cloudflared-runner.js"
import type {
  ProviderStartOptions,
  ProviderStartResult,
  RemoteProvider,
  TunnelHealth,
  TunnelIdentity,
  TunnelProviderHandle,
} from "./types.js"

// Kept here for existing importers; the implementation moved to the shared runner.
export { probeHostname, makeCloudflaredSpawner, type ProbeResult } from "./cloudflared-runner.js"

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

export interface CloudflareManagedDeps extends CloudflaredRunnerDeps {
  /** Cloudflare API fetch (also the probe fetch unless `probeFetch` is set). */
  fetch?: FetchLike
  /** Token resolver. Defaults to env/file/keychain/stored resolution. */
  resolveToken?: TokenResolver
  apiBaseUrl?: string
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
  let runner: CloudflaredRunner | null = null
  let service: string | null = null
  let hostnames: string[] = []
  let rawLog: ((line: string) => void) | undefined

  const log = (line: string): void => {
    rawLog?.(runner ? runner.redact(line) : line)
  }

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
      if (runner) throw new Error("cloudflare-managed: provider already started")
      rawLog = opts.onLog
      const eng = engine()
      // Fail on config / zone problems before touching anything remote.
      eng.validateHostnames(tunnel.hostnames)
      const r = new CloudflaredRunner({
        ...deps,
        ...(deps.probeFetch || deps.fetch ? { probeFetch: deps.probeFetch ?? fetchImpl } : {}),
      })
      await r.preflight()

      service = `http://${opts.target.host}:${opts.target.port}`
      hostnames = tunnel.hostnames.map(normalizeHost)
      const rec = await eng.reconcile({ key: tunnel.key, hostnames }, service)

      runner = r
      try {
        r.start({
          token: rec.token,
          hostnames,
          workspace: opts.workspace,
          label: managedTunnelName(tunnel.key),
          ...(opts.onLog ? { onLog: opts.onLog } : {}),
          ...(opts.onHealth ? { onHealth: opts.onHealth } : {}),
        })
      } catch (err) {
        runner = null
        throw new Error(`cloudflare-managed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return { publicUrl: `https://${hostnames[0]}`, pid: r.pid, tunnelId: rec.tunnelId }
    },

    async stop(): Promise<void> {
      const r = runner
      runner = null
      service = null
      if (r) await r.stop()
    },

    async destroy(tunnel: TunnelIdentity): Promise<void> {
      await engine().destroy({ key: tunnel.key, hostnames: tunnel.hostnames })
    },

    async addHostname(tunnel: TunnelIdentity, hostname: string): Promise<void> {
      const h = normalizeHost(hostname)
      const next = [h, ...tunnel.hostnames.map(normalizeHost).filter(x => x !== h)]
      // Running → route with the live origin; stopped → keep the remote one.
      await engine().reconcile({ key: tunnel.key, hostnames: next }, service)
      if (runner) {
        hostnames = next
        runner.setHostnames(next)
      }
    },

    async removeHostname(tunnel: TunnelIdentity, hostname: string): Promise<void> {
      const h = normalizeHost(hostname)
      await engine().removeHostname({ key: tunnel.key, hostnames: tunnel.hostnames }, h)
      if (runner) {
        hostnames = hostnames.filter(x => x !== h)
        runner.setHostnames(hostnames)
      }
    },

    health: () => runner?.health() ?? null,
    probeNow: async () => (runner ? runner.probeNow() : null),
  }
}
