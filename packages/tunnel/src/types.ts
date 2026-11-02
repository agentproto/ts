/**
 * Core types for the Tunnel Provider primitive.
 *
 * A provider owns remote tunnel state plus the connector that publishes a
 * local target at a stable public URL. Nothing here knows about sessions,
 * apps, or routing - that keeps the contract implementable in a standalone
 * package with no dependency on the runtime.
 */

/** How a provider authenticates to its remote API. */
export type TunnelAuthMode = "apiKey" | "oidc" | "token"

/** Long-lived server-issued key, sent as a bearer token. */
export interface TunnelApiKeyAuth {
  mode: "apiKey"
  apiKey: string
}

/** Caller-supplied short-lived bearer token. */
export interface TunnelTokenAuth {
  mode: "token"
  token: string
  /** ISO-8601 expiry, when the issuer states one. */
  expiresAt?: string
}

/** RFC 8628 device login; the provider owns refresh + retry. */
export interface TunnelOidcAuth {
  mode: "oidc"
  issuer: string
  clientId: string
  /** Space-separated scopes. */
  scopes?: string
  /** Return a currently-valid access token, refreshing it if needed. */
  accessToken(options?: { forceRefresh?: boolean }): Promise<string>
  logout?(): Promise<void>
}

export type TunnelAuth = TunnelApiKeyAuth | TunnelTokenAuth | TunnelOidcAuth

/** Minimal fetch signature so callers can inject a mock without a DOM dep. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The local service a tunnel forwards to. */
export interface TunnelTarget {
  host: string
  port: number
  /** Defaults to `http`. */
  protocol?: "http" | "https"
}

/** Input to {@link TunnelProvider.create}. Idempotent on `key`. */
export interface CreateTunnelInput {
  /** Stable tunnel identity. Survives restarts; namespaces remote state. */
  key: string
  /**
   * Origin to forward to (`http://127.0.0.1:3000`). `null` means "keep the
   * current origin" for a provider that already has one.
   */
  service?: string | null
  /** Requested public hostnames, primary first. Empty = "assign me one". */
  hostnames?: string[]
  /** Convenience alternative to `service`; providers may derive the origin. */
  target?: TunnelTarget
  /** Free-form provider metadata, stored remotely when supported. */
  metadata?: Record<string, string>
}

/** Coarse lifecycle state a provider reports for one tunnel. */
export type TunnelStatus = "active" | "starting" | "stopped" | "error" | "unknown"

/** Current state of one tunnel. */
export interface TunnelInfo {
  key: string
  /** Provider-side identity, when distinct from `key`. */
  tunnelId?: string
  status: TunnelStatus
  publicUrl?: string
  /** Hostnames actually routed, primary first. */
  hostnames: string[]
  service?: string | null
  createdAt?: string
  updatedAt?: string
  /**
   * Secret the caller needs to start the provider's connector. Never log,
   * echo, or persist this outside the connector's environment.
   */
  connectorToken?: string
  metadata?: Record<string, string>
}

export type TunnelHealthState = "active" | "degraded" | "error" | "unknown"

export interface TunnelHealthHost {
  hostname: string
  ok: boolean
  reason?: string
}

/** Live health of a tunnel or of the provider's API. */
export interface TunnelHealth {
  state: TunnelHealthState
  reason?: string
  /** ISO-8601 timestamp of the probe. */
  checkedAt: string
  latencyMs?: number
  /** Per-hostname probe results (all hostnames during a swap overlap). */
  hostnames?: TunnelHealthHost[]
}

/** Pure metadata surfaced by provider discovery. Never carries secrets. */
export interface TunnelCapabilities {
  /** Public URL is stable across restarts (fixed hostname). */
  stableUrl: boolean
  /** Supports autostart on daemon boot. */
  autostart: boolean
  /** Supports custom domains (not just provider-assigned hostnames). */
  customDomain: boolean
  /** Requires credentials (API key, OIDC login, …). */
  requiresAuth: boolean
  /** Can list/inspect live tunnels via an external API. */
  hasApi: boolean
}

/**
 * The Tunnel Provider contract.
 *
 * Idempotency and error rules:
 * - `create` is idempotent on `key`.
 * - `delete` is idempotent; deleting an unknown key is not an error.
 * - `status` returns `null` for an unknown key; transport/auth failures throw.
 * - `health` reports a state and never throws on transport failure.
 */
export interface TunnelProvider {
  /** Stable machine-local identifier: `^[a-z0-9][a-z0-9._-]*$`. */
  readonly slug: string
  readonly name: string
  readonly capabilities: TunnelCapabilities

  create(input: CreateTunnelInput): Promise<TunnelInfo>
  list(): Promise<TunnelInfo[]>
  delete(key: string): Promise<void>
  status(key: string): Promise<TunnelInfo | null>
  health(): Promise<TunnelHealth>
}

/** Configuration for the shared {@link TunnelClient} plumbing. */
export interface TunnelConfig {
  /** Remote API base URL. HTTPS unless loopback. */
  baseUrl: string
  auth?: TunnelAuth
  /** Per-request timeout. Defaults to {@link DEFAULT_TUNNEL_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Extra headers sent on every request. */
  headers?: Record<string, string>
  /** Injected fetch (tests, custom transports). */
  fetch?: FetchLike
}

export const DEFAULT_TUNNEL_TIMEOUT_MS = 30_000

/**
 * Normalised provider failure. `code` is machine-readable; the message never
 * contains credential material.
 */
export class TunnelProviderError extends Error {
  readonly status: number | undefined
  readonly code: string
  readonly checkoutUrl: string | undefined

  constructor(
    message: string,
    options: {
      status?: number
      code?: string
      checkoutUrl?: string
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = "TunnelProviderError"
    this.status = options.status
    this.code = options.code ?? (options.status ? `http_${options.status}` : "tunnel_error")
    this.checkoutUrl = options.checkoutUrl
  }
}

/** Render a {@link TunnelTarget} as an origin string a provider can consume. */
export function tunnelServiceUrl(target: TunnelTarget): string {
  const protocol = target.protocol ?? "http"
  const host =
    target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host
  return `${protocol}://${host}:${target.port}`
}
