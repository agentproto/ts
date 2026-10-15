/**
 * Minimal Cloudflare v4 API client for the `cloudflare-managed` tunnel
 * provider — only the endpoints the managed engine needs (tunnels, tunnel
 * token, remote ingress config, zones, DNS records).
 *
 * Every request goes through an INJECTED `fetch`: production passes the
 * global one, tests pass a simulated Cloudflare API. Nothing here ever logs
 * or echoes the API token — it only rides in the `Authorization` header —
 * and the tunnel token returned by `getTunnelToken` is a secret the caller
 * must keep in memory only.
 */

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    redirect?: "follow" | "manual" | "error"
    signal?: AbortSignal
  },
) => Promise<{
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
}>

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"

export interface CfTunnel {
  id: string
  name: string
  deleted_at?: string | null
}

export interface CfDnsRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
  comment?: string | null
}

export interface CfIngressRule {
  hostname?: string
  service: string
}

/** A Cloudflare API failure. `status` is the HTTP status; `codes` the CF error codes. */
export class CloudflareApiError extends Error {
  readonly status: number
  readonly codes: number[]
  constructor(message: string, status: number, codes: number[]) {
    super(message)
    this.name = "CloudflareApiError"
    this.status = status
    this.codes = codes
  }
}

/** True for "the thing is already gone" — delete paths tolerate it. */
export function isNotFound(err: unknown): boolean {
  return err instanceof CloudflareApiError && err.status === 404
}

interface Envelope<T> {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
  result?: T
}

export interface CloudflareApiOptions {
  /** API token (Bearer). Never logged, never part of an error message. */
  token: string
  fetch: FetchLike
  baseUrl?: string
}

export class CloudflareApi {
  private readonly token: string
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string

  constructor(opts: CloudflareApiOptions) {
    this.token = opts.token
    this.fetchImpl = opts.fetch
    this.baseUrl = opts.baseUrl ?? CLOUDFLARE_API_BASE
  }

  // ── tunnels ─────────────────────────────────────────────────────────

  /** Live (not deleted) tunnels with exactly this name. */
  async listTunnelsByName(accountId: string, name: string): Promise<CfTunnel[]> {
    const qs = new URLSearchParams({ name, is_deleted: "false" })
    const res = await this.call<CfTunnel[]>(
      "GET",
      `/accounts/${enc(accountId)}/cfd_tunnel?${qs.toString()}`,
    )
    return (res ?? []).filter(t => t.name === name && !t.deleted_at)
  }

  /** A tunnel by id, or null when it doesn't exist / was deleted. */
  async getTunnel(accountId: string, tunnelId: string): Promise<CfTunnel | null> {
    try {
      const t = await this.call<CfTunnel>(
        "GET",
        `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}`,
      )
      return t && !t.deleted_at ? t : null
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  /** Create a remotely-configured tunnel (`config_src: "cloudflare"`). */
  async createTunnel(
    accountId: string,
    name: string,
  ): Promise<CfTunnel & { token?: string }> {
    const res = await this.call<CfTunnel & { token?: string }>(
      "POST",
      `/accounts/${enc(accountId)}/cfd_tunnel`,
      { name, config_src: "cloudflare" },
    )
    if (!res?.id) throw new CloudflareApiError("create tunnel: no id in response", 500, [])
    return res
  }

  /** The connector token for `cloudflared tunnel run`. SECRET. */
  async getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    const res = await this.call<string>(
      "GET",
      `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/token`,
    )
    if (typeof res !== "string" || res.length === 0) {
      throw new CloudflareApiError("get tunnel token: empty response", 500, [])
    }
    return res
  }

  async getTunnelIngress(accountId: string, tunnelId: string): Promise<CfIngressRule[]> {
    try {
      const res = await this.call<{ config?: { ingress?: CfIngressRule[] } }>(
        "GET",
        `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/configurations`,
      )
      return res?.config?.ingress ?? []
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
  }

  async putTunnelIngress(
    accountId: string,
    tunnelId: string,
    ingress: CfIngressRule[],
  ): Promise<void> {
    await this.call(
      "PUT",
      `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/configurations`,
      { config: { ingress } },
    )
  }

  /** Drop stale connector connections (required before a tunnel delete). */
  async deleteTunnelConnections(accountId: string, tunnelId: string): Promise<void> {
    await this.call(
      "DELETE",
      `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/connections`,
    )
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    await this.call("DELETE", `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}`)
  }

  // ── zones / DNS ─────────────────────────────────────────────────────

  async findZoneId(zoneName: string, accountId: string): Promise<string | null> {
    const qs = new URLSearchParams({ name: zoneName, "account.id": accountId })
    const res = await this.call<Array<{ id: string; name: string }>>(
      "GET",
      `/zones?${qs.toString()}`,
    )
    const hit = (res ?? []).find(z => z.name === zoneName)
    return hit?.id ?? null
  }

  /** Every record (any type) with exactly this name. */
  async listDnsRecords(zoneId: string, name: string): Promise<CfDnsRecord[]> {
    const qs = new URLSearchParams({ name })
    const res = await this.call<CfDnsRecord[]>(
      "GET",
      `/zones/${enc(zoneId)}/dns_records?${qs.toString()}`,
    )
    return (res ?? []).filter(r => r.name === name)
  }

  async createDnsRecord(
    zoneId: string,
    record: Omit<CfDnsRecord, "id">,
  ): Promise<CfDnsRecord> {
    const res = await this.call<CfDnsRecord>(
      "POST",
      `/zones/${enc(zoneId)}/dns_records`,
      record,
    )
    if (!res?.id) throw new CloudflareApiError("create DNS record: no id in response", 500, [])
    return res
  }

  async patchDnsRecord(
    zoneId: string,
    recordId: string,
    patch: Partial<Omit<CfDnsRecord, "id">>,
  ): Promise<void> {
    await this.call("PATCH", `/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`, patch)
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.call("DELETE", `/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`)
  }

  // ── transport ───────────────────────────────────────────────────────

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let envelope: Envelope<T> | undefined
    try {
      envelope = (await res.json()) as Envelope<T>
    } catch {
      envelope = undefined
    }
    if (!res.ok || envelope?.success === false) {
      const errs = envelope?.errors ?? []
      const detail =
        errs.map(e => `${e.code ?? "?"}: ${e.message ?? "unknown"}`).join("; ") ||
        `HTTP ${res.status}`
      // Path only — never the headers (token) or the request body.
      throw new CloudflareApiError(
        `cloudflare ${method} ${path.split("?")[0]} failed (${res.status}): ${detail}`,
        res.status,
        errs.map(e => e.code ?? 0),
      )
    }
    return envelope?.result
  }
}

const enc = (s: string): string => encodeURIComponent(s)
