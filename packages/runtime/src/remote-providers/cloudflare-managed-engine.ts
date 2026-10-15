/**
 * Desired-state engine behind the `cloudflare-managed` tunnel provider.
 *
 * You declare `{ key, hostnames, service }`; `reconcile` makes Cloudflare
 * match it and is safe to replay on every start:
 *
 *   1. find the tunnel `agentproto-managed-<key>` (list FIRST, never
 *      duplicate) or create it with `config_src: "cloudflare"`;
 *   2. fetch its connector token (secret — returned, never stored/logged);
 *   3. PUT the remote ingress: one `{hostname, service}` rule per hostname,
 *      then the final `http_status:404` catch-all;
 *   4. upsert a proxied CNAME `hostname → <tunnel-id>.cfargotunnel.com` per
 *      hostname — only when no record exists, or the existing one carries
 *      the engine's ownership comment. Anything else is an error.
 *
 * `destroy` undoes it in order: CNAMEs (only the engine's own, pointing at
 * THIS tunnel), then stale connections, then the tunnel — every step
 * tolerating "already gone". `removeHostname` is the second half of a swap.
 *
 * Ownership: the engine only ever looks up tunnels by its prefixed name
 * and only edits/deletes DNS records carrying {@link MANAGED_DNS_COMMENT}.
 * A tunnel or record it didn't create is never touched.
 */

import {
  CloudflareApi,
  isNotFound,
  type CfDnsRecord,
  type CfIngressRule,
  type FetchLike,
} from "./cloudflare-api.js"
import {
  normalizeHost,
  resolveZoneForHostname,
  type ManagedZoneConfig,
  type TokenResolver,
} from "./cloudflare-managed-config.js"

export const MANAGED_TUNNEL_PREFIX = "agentproto-managed-"
export const MANAGED_DNS_COMMENT = "managed by agentproto tunnel engine"
/** Cloudflare's CNAME target domain for tunnels: `<uuid>.cfargotunnel.com`. */
export const TUNNEL_CNAME_DOMAIN = "cfargotunnel.com"

export interface ManagedTunnelSpec {
  /** Stable identity — becomes the tunnel name suffix. */
  key: string
  /** Hostnames routed to the tunnel, primary first. */
  hostnames: readonly string[]
}

export interface ReconcileResult {
  accountId: string
  tunnelId: string
  tunnelName: string
  /** Connector token. SECRET — keep in memory, hand to cloudflared via env. */
  token: string
  created: boolean
}

export interface ManagedEngineOptions {
  zones: readonly ManagedZoneConfig[]
  resolveToken: TokenResolver
  fetch: FetchLike
  apiBaseUrl?: string
  onLog?: (line: string) => void
}

/** `agentproto-managed-<key>` with the key squeezed to Cloudflare-safe chars. */
export function managedTunnelName(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
  if (!slug) throw new Error("cloudflare-managed: tunnel key is empty")
  return `${MANAGED_TUNNEL_PREFIX}${slug}`
}

export function tunnelCnameTarget(tunnelId: string): string {
  return `${tunnelId}.${TUNNEL_CNAME_DOMAIN}`
}

interface ZoneHandle {
  cfg: ManagedZoneConfig
  api: CloudflareApi
  zoneId: string
}

export class ManagedTunnelEngine {
  private readonly zones: readonly ManagedZoneConfig[]
  private readonly resolveToken: TokenResolver
  private readonly fetchImpl: FetchLike
  private readonly apiBaseUrl: string | undefined
  private readonly onLog: ((line: string) => void) | undefined
  private readonly zoneIds = new Map<string, string>()

  constructor(opts: ManagedEngineOptions) {
    this.zones = opts.zones
    this.resolveToken = opts.resolveToken
    this.fetchImpl = opts.fetch
    this.apiBaseUrl = opts.apiBaseUrl
    this.onLog = opts.onLog
  }

  /**
   * Validate a hostname set without touching the API: every hostname must
   * resolve to a configured zone within its `maxLabels`, and all of them
   * must live in the same account as the primary (a tunnel is per-account).
   */
  validateHostnames(hostnames: readonly string[]): ManagedZoneConfig[] {
    if (hostnames.length === 0) {
      throw new Error("cloudflare-managed: at least one hostname is required")
    }
    const zones = hostnames.map(h => resolveZoneForHostname(this.zones, h))
    const accountId = zones[0]!.accountId
    zones.forEach((z, i) => {
      if (z.accountId !== accountId) {
        throw new Error(
          `cloudflare-managed: "${hostnames[i]}" is in zone "${z.zone}" (account ${z.accountId}) but ` +
            `the tunnel lives in account ${accountId} — a tunnel can only serve zones of its own account`,
        )
      }
    })
    return zones
  }

  /**
   * Bring Cloudflare to the desired state. Idempotent. `service` is the
   * origin every hostname routes to; `null` (tunnel not running here)
   * keeps the origin already in the remote ingress, and skips the ingress
   * write when there is none yet — the next start replays it.
   */
  async reconcile(spec: ManagedTunnelSpec, service: string | null): Promise<ReconcileResult> {
    const hostnames = spec.hostnames.map(normalizeHost)
    const zones = this.validateHostnames(hostnames)
    const primary = await this.zoneHandle(zones[0]!)
    const accountId = primary.cfg.accountId
    const tunnelName = managedTunnelName(spec.key)

    const existing = await primary.api.listTunnelsByName(accountId, tunnelName)
    let tunnelId: string
    let token: string | undefined
    let created = false
    if (existing.length > 0) {
      tunnelId = existing[0]!.id
    } else {
      const t = await primary.api.createTunnel(accountId, tunnelName)
      tunnelId = t.id
      token = t.token
      created = true
      this.onLog?.(`[cloudflare-managed] created tunnel ${tunnelName} (${tunnelId})`)
    }
    token ??= await primary.api.getTunnelToken(accountId, tunnelId)

    const origin =
      service ??
      (await primary.api.getTunnelIngress(accountId, tunnelId)).find(r => r.hostname)?.service
    if (origin) {
      await primary.api.putTunnelIngress(accountId, tunnelId, buildIngress(hostnames, origin))
    }

    for (let i = 0; i < hostnames.length; i++) {
      const zh = await this.zoneHandle(zones[i]!)
      await this.ensureCname(zh, hostnames[i]!, tunnelId)
    }
    return { accountId, tunnelId, tunnelName, token, created }
  }

  /**
   * Second half of a swap: drop `hostname` from the tunnel's ingress and
   * delete its CNAME (only if it's ours and points at this tunnel). The
   * remaining hostnames keep serving throughout.
   */
  async removeHostname(spec: ManagedTunnelSpec, hostnameRaw: string): Promise<void> {
    const hostname = normalizeHost(hostnameRaw)
    const remaining = spec.hostnames.map(normalizeHost).filter(h => h !== hostname)
    if (remaining.length === 0) {
      throw new Error(
        `cloudflare-managed: "${hostname}" is the tunnel's last hostname — delete the tunnel instead`,
      )
    }
    const zones = this.validateHostnames(remaining)
    const primary = await this.zoneHandle(zones[0]!)
    const accountId = primary.cfg.accountId
    const tunnel = await this.findTunnel(primary, spec.key)
    if (tunnel) {
      const ingress = await primary.api.getTunnelIngress(accountId, tunnel)
      const service = ingress.find(r => r.hostname)?.service
      if (service) {
        await primary.api.putTunnelIngress(accountId, tunnel, buildIngress(remaining, service))
      }
      const zh = await this.zoneHandle(resolveZoneForHostname(this.zones, hostname))
      await this.deleteOwnCname(zh, hostname, tunnel)
    }
  }

  /**
   * Tear everything down: CNAMEs → connections → tunnel. Tolerates every
   * piece already being gone. Callers stop cloudflared FIRST.
   */
  async destroy(spec: ManagedTunnelSpec): Promise<void> {
    const hostnames = spec.hostnames.map(normalizeHost)
    const zones = this.validateHostnames(hostnames)
    const primary = await this.zoneHandle(zones[0]!)
    const accountId = primary.cfg.accountId
    const tunnelId = await this.findTunnel(primary, spec.key)
    if (!tunnelId) {
      this.onLog?.(`[cloudflare-managed] tunnel ${managedTunnelName(spec.key)} already gone`)
      return
    }
    for (let i = 0; i < hostnames.length; i++) {
      const zh = await this.zoneHandle(zones[i]!)
      await this.deleteOwnCname(zh, hostnames[i]!, tunnelId)
    }
    try {
      await primary.api.deleteTunnelConnections(accountId, tunnelId)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    try {
      await primary.api.deleteTunnel(accountId, tunnelId)
      this.onLog?.(`[cloudflare-managed] deleted tunnel ${managedTunnelName(spec.key)} (${tunnelId})`)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  // ── internals ───────────────────────────────────────────────────────

  private async findTunnel(zh: ZoneHandle, key: string): Promise<string | null> {
    const found = await zh.api.listTunnelsByName(zh.cfg.accountId, managedTunnelName(key))
    return found[0]?.id ?? null
  }

  private async zoneHandle(cfg: ManagedZoneConfig): Promise<ZoneHandle> {
    const token = await this.resolveToken(cfg.tokenRef)
    const api = new CloudflareApi({
      token,
      fetch: this.fetchImpl,
      ...(this.apiBaseUrl ? { baseUrl: this.apiBaseUrl } : {}),
    })
    let zoneId = cfg.zoneId ?? this.zoneIds.get(cfg.zone)
    if (!zoneId) {
      const found = await api.findZoneId(cfg.zone, cfg.accountId)
      if (!found) {
        throw new Error(
          `cloudflare-managed: zone "${cfg.zone}" not found in account ${cfg.accountId} ` +
            "(or the token for it lacks Zone:Read)",
        )
      }
      zoneId = found
      this.zoneIds.set(cfg.zone, zoneId)
    }
    return { cfg, api, zoneId }
  }

  private async ensureCname(zh: ZoneHandle, hostname: string, tunnelId: string): Promise<void> {
    const target = tunnelCnameTarget(tunnelId)
    const records = await zh.api.listDnsRecords(zh.zoneId, hostname)
    const foreign = records.filter(r => !isOwned(r))
    if (foreign.length > 0) {
      const r = foreign[0]!
      throw new Error(
        `cloudflare-managed: DNS record ${r.type} ${hostname} already exists and was not created ` +
          `by agentproto (no "${MANAGED_DNS_COMMENT}" comment) — refusing to touch it. ` +
          "Pick another hostname or remove the record by hand.",
      )
    }
    const own = records.find(r => r.type === "CNAME")
    if (!own) {
      await zh.api.createDnsRecord(zh.zoneId, {
        type: "CNAME",
        name: hostname,
        content: target,
        proxied: true,
        comment: MANAGED_DNS_COMMENT,
      })
      this.onLog?.(`[cloudflare-managed] created CNAME ${hostname} → ${target}`)
      return
    }
    if (own.content === target && own.proxied === true) return
    if (own.content !== target) {
      // Ours, but routed to another tunnel. Take it over only when that
      // tunnel is dead — never steal a hostname a live managed tunnel serves.
      const otherId = cnameTunnelId(own.content)
      if (otherId) {
        const other = await zh.api.getTunnel(zh.cfg.accountId, otherId)
        if (other) {
          throw new Error(
            `cloudflare-managed: ${hostname} is already routed to live tunnel ${other.name} — ` +
              "delete or swap that tunnel first",
          )
        }
      }
    }
    await zh.api.patchDnsRecord(zh.zoneId, own.id, { content: target, proxied: true })
    this.onLog?.(`[cloudflare-managed] repointed CNAME ${hostname} → ${target}`)
  }

  private async deleteOwnCname(zh: ZoneHandle, hostname: string, tunnelId: string): Promise<void> {
    const target = tunnelCnameTarget(tunnelId)
    const records = await zh.api.listDnsRecords(zh.zoneId, hostname)
    for (const r of records) {
      if (r.type !== "CNAME" || !isOwned(r) || r.content !== target) {
        this.onLog?.(
          `[cloudflare-managed] leaving DNS record ${r.type} ${hostname} alone (not this tunnel's)`,
        )
        continue
      }
      try {
        await zh.api.deleteDnsRecord(zh.zoneId, r.id)
        this.onLog?.(`[cloudflare-managed] deleted CNAME ${hostname}`)
      } catch (err) {
        if (!isNotFound(err)) throw err
      }
    }
  }
}

export function buildIngress(hostnames: readonly string[], service: string): CfIngressRule[] {
  return [...hostnames.map(hostname => ({ hostname, service })), { service: "http_status:404" }]
}

function isOwned(r: CfDnsRecord): boolean {
  return r.comment === MANAGED_DNS_COMMENT
}

function cnameTunnelId(content: string): string | null {
  const suffix = `.${TUNNEL_CNAME_DOMAIN}`
  return content.endsWith(suffix) ? content.slice(0, -suffix.length) : null
}
