/**
 * `tunnels.agentik.net` implementation of the Tunnel Provider contract.
 *
 * ## Auth
 *
 * A single bearer API key, `sk-` prefixed, sent as
 * `Authorization: Bearer <apiKey>` on every call.
 *
 * ## Remote contract (v1)
 *
 *   GET    {baseUrl}/v1/tunnels
 *           200 { tunnels: [TunnelRecord, …] }
 *
 *   PUT    {baseUrl}/v1/tunnels/{key}
 *           body { service: "http://127.0.0.1:<port>" | null, hostnames: string[] }
 *           200   { key, tunnelId, hostnames, publicUrl?, token }
 *
 *   DELETE {baseUrl}/v1/tunnels/{key}
 *           2xx | 404
 *
 * `create` is idempotent and replayed on every start; `delete` tolerates a
 * 404 so cleanup is idempotent. `status` is derived from the list endpoint
 * because the contract exposes no per-key GET.
 */

import {
  TunnelClient,
  TunnelProviderError,
  tunnelServiceUrl,
  type CreateTunnelInput,
  type FetchLike,
  type TunnelCapabilities,
  type TunnelHealth,
  type TunnelInfo,
  type TunnelProvider,
  type TunnelStatus,
} from "@agentproto/tunnel"

export const AGENTIK_TUNNEL_SLUG = "agentik"
export const AGENTIK_TUNNEL_DEFAULT_BASE_URL = "https://tunnels.agentik.net"

export const AGENTIK_TUNNEL_CAPABILITIES: TunnelCapabilities = {
  stableUrl: true,
  autostart: true,
  customDomain: true,
  requiresAuth: true,
  hasApi: true,
}

/** Setup fields a daemon can show when configuring this provider. */
export const AGENTIK_TUNNEL_SETUP_FIELDS = [
  {
    name: "apiKey",
    description: "Agentik tunnel API key (sk-…), sent as a bearer token.",
    required: true,
    sensitive: true,
  },
  {
    name: "baseUrl",
    description: `Tunnel API base URL (default ${AGENTIK_TUNNEL_DEFAULT_BASE_URL}).`,
    required: false,
    sensitive: false,
  },
] as const

export interface AgentikTunnelProviderOptions {
  /** `sk-` prefixed bearer key. */
  apiKey: string
  /** Defaults to {@link AGENTIK_TUNNEL_DEFAULT_BASE_URL}. */
  baseUrl?: string
  /** Injected fetch (tests, custom transports). */
  fetch?: FetchLike
  /** Per-request timeout. Defaults to the shared client's 30s. */
  timeoutMs?: number
  /** Timeout for the `health` probe. Defaults to 10s. */
  healthTimeoutMs?: number
  /** Extra headers sent on every request. */
  headers?: Record<string, string>
}

/** Extra transport seams carried over from stored credentials. */
export type AgentikTunnelTransportOptions = Pick<
  AgentikTunnelProviderOptions,
  "fetch" | "timeoutMs" | "healthTimeoutMs" | "headers"
>

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

function requireKey(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `agentik tunnel: invalid key "${key}" (expected ${KEY_PATTERN.source})`,
    )
  }
  return key
}

function requireApiKey(apiKey: string): string {
  if (!apiKey.startsWith("sk-")) {
    throw new Error('agentik tunnel: apiKey must start with "sk-"')
  }
  return apiKey
}

function normalizeStatus(value: unknown): TunnelStatus {
  if (typeof value !== "string") return "unknown"
  switch (value.toLowerCase()) {
    case "active":
    case "running":
    case "ready":
    case "healthy":
      return "active"
    case "starting":
    case "pending":
    case "provisioning":
      return "starting"
    case "stopped":
    case "inactive":
    case "idle":
      return "stopped"
    case "error":
    case "failed":
    case "degraded":
      return "error"
    default:
      return "unknown"
  }
}

function toInfo(fallbackKey: string, record: Record<string, unknown>): TunnelInfo {
  const hostnames = stringArray(record["hostnames"])
  const key = str(record["key"]) ?? fallbackKey
  const tunnelId = str(record["tunnelId"]) ?? str(record["id"])
  const publicUrl =
    str(record["publicUrl"]) ??
    str(record["url"]) ??
    (hostnames[0] ? `https://${hostnames[0]}` : undefined)
  const service =
    typeof record["service"] === "string"
      ? record["service"]
      : typeof record["origin"] === "string"
        ? record["origin"]
        : null
  const connectorToken = str(record["connectorToken"]) ?? str(record["token"])
  const createdAt = str(record["createdAt"]) ?? str(record["created_at"])
  const updatedAt = str(record["updatedAt"]) ?? str(record["updated_at"])

  return {
    key,
    status: normalizeStatus(record["status"]),
    hostnames,
    service,
    ...(tunnelId ? { tunnelId } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(connectorToken ? { connectorToken } : {}),
  }
}

function extractRows(body: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body["tunnels"])
      ? body["tunnels"]
      : isRecord(body) && Array.isArray(body["items"])
        ? body["items"]
        : []
  return rows.filter(isRecord)
}

export class AgentikTunnelProvider extends TunnelClient implements TunnelProvider {
  readonly slug = AGENTIK_TUNNEL_SLUG
  readonly name = "Agentik Tunnels"
  readonly capabilities = AGENTIK_TUNNEL_CAPABILITIES

  private readonly healthTimeoutMs: number

  constructor(options: AgentikTunnelProviderOptions) {
    const apiKey = requireApiKey(options.apiKey)
    super({
      baseUrl: options.baseUrl ?? AGENTIK_TUNNEL_DEFAULT_BASE_URL,
      auth: { mode: "apiKey", apiKey },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    })
    this.healthTimeoutMs = options.healthTimeoutMs ?? 10_000
  }

  async create(input: CreateTunnelInput): Promise<TunnelInfo> {
    const key = requireKey(input.key)
    const service = input.service ?? (input.target ? tunnelServiceUrl(input.target) : null)
    const hostnames = input.hostnames ?? []
    const record = await this.request<unknown>(`/v1/tunnels/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { service, hostnames },
    })

    if (!isRecord(record)) {
      // A provider that accepts the PUT with an empty body is treated as
      // created; the caller can follow up with `status()` for full detail.
      return {
        key,
        status: "active",
        hostnames,
        ...(hostnames[0] ? { publicUrl: `https://${hostnames[0]}` } : {}),
      }
    }
    return toInfo(key, record)
  }

  async list(): Promise<TunnelInfo[]> {
    const body = await this.request<unknown>("/v1/tunnels")
    const infos: TunnelInfo[] = []
    for (const row of extractRows(body)) {
      const key = str(row["key"]) ?? str(row["id"])
      if (!key) continue
      infos.push(toInfo(key, row))
    }
    return infos
  }

  async status(key: string): Promise<TunnelInfo | null> {
    const wanted = requireKey(key)
    const tunnels = await this.list()
    return tunnels.find(tunnel => tunnel.key === wanted) ?? null
  }

  async delete(key: string): Promise<void> {
    const wanted = requireKey(key)
    try {
      await this.request<void>(`/v1/tunnels/${encodeURIComponent(wanted)}`, {
        method: "DELETE",
      })
    } catch (err) {
      // Deleting an unknown key is not an error.
      if (err instanceof TunnelProviderError && err.status === 404) return
      throw err
    }
  }

  async health(): Promise<TunnelHealth> {
    const started = Date.now()
    try {
      await this.request<unknown>("/v1/tunnels", { timeoutMs: this.healthTimeoutMs })
      return {
        state: "active",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
      }
    } catch (err) {
      return {
        state: "error",
        reason: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
      }
    }
  }
}

/**
 * Build a provider from a `~/.agentproto/tunnel-creds/agentik.json` record
 * (`{ apiKey, baseUrl? }`). Transport seams are injectable for tests.
 */
export function agentikTunnelProviderFromCredentials(
  credentials: Record<string, string | undefined> | null | undefined,
  transport: AgentikTunnelTransportOptions = {},
): AgentikTunnelProvider {
  const apiKey = credentials?.["apiKey"]
  if (!apiKey) {
    throw new Error("agentik tunnel: credentials are missing apiKey")
  }
  const baseUrl = credentials?.["baseUrl"]
  return new AgentikTunnelProvider({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...transport,
  })
}
