/**
 * Shared HTTP plumbing for tunnel providers.
 *
 * A provider extends (or composes) {@link TunnelClient} to get URL handling,
 * bearer auth for every {@link TunnelAuthMode}, a timeout, one
 * refresh-and-retry for OIDC on `401`, and normalised
 * {@link TunnelProviderError}s. It deliberately knows nothing about a
 * provider's endpoints.
 */

import {
  DEFAULT_TUNNEL_TIMEOUT_MS,
  TunnelProviderError,
  type FetchLike,
  type TunnelAuth,
  type TunnelConfig,
} from "./types.js"

export interface TunnelRequestOptions {
  method?: string
  headers?: Record<string, string>
  /** JSON body; serialised automatically. */
  body?: unknown
  /** Send `Authorization` from `TunnelConfig.auth` (default `true`). */
  auth?: boolean
  /** Per-request timeout override, ms. */
  timeoutMs?: number
  /** Caller abort signal. */
  signal?: AbortSignal
  /** Internal: skip the one-shot OIDC `401` retry. */
  retryAuth?: boolean
  /** Internal: force a refresh of the OIDC access token. */
  forceAuthRefresh?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Normalise a provider base URL. Requires HTTPS except for loopback hosts,
 * because every request carries a bearer token.
 */
export function normalizeTunnelBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new TunnelProviderError("tunnel provider: baseUrl is required", {
      code: "invalid_config",
    })
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch (cause) {
    throw new TunnelProviderError(`tunnel provider: invalid baseUrl "${trimmed}"`, {
      code: "invalid_config",
      cause,
    })
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  if (url.protocol !== "https:" && !loopback) {
    throw new TunnelProviderError(
      `tunnel provider: baseUrl must use https (bearer tokens travel on it): ${url.origin}`,
      { code: "invalid_config" },
    )
  }
  return withScheme.replace(/\/+$/, "")
}

export class TunnelClient {
  readonly baseUrl: string
  protected readonly config: TunnelConfig
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly defaultHeaders: Record<string, string>

  constructor(config: TunnelConfig) {
    const baseUrl = normalizeTunnelBaseUrl(config.baseUrl)
    this.config = { ...config, baseUrl }
    this.baseUrl = baseUrl
    this.fetchImpl = config.fetch ?? (globalThis.fetch as unknown as FetchLike)
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS
    this.defaultHeaders = { accept: "application/json", ...(config.headers ?? {}) }
  }

  /** Absolute URL for a provider-relative path. */
  protected url(path: string): string {
    const suffix = path.startsWith("/") ? path : `/${path}`
    return `${this.baseUrl}${suffix}`
  }

  /** Resolve the `Authorization` header value, if this client has auth. */
  protected async authorization(forceRefresh = false): Promise<string | null> {
    const auth: TunnelAuth | undefined = this.config.auth
    if (!auth) return null
    if (auth.mode === "apiKey") return `Bearer ${auth.apiKey}`
    if (auth.mode === "token") return `Bearer ${auth.token}`
    const token = await auth.accessToken(forceRefresh ? { forceRefresh: true } : undefined)
    return `Bearer ${token}`
  }

  /**
   * Perform a request and parse a JSON response. An empty body resolves to
   * `undefined`; a non-JSON body resolves to its text.
   */
  protected async request<T>(path: string, options: TunnelRequestOptions = {}): Promise<T> {
    const res = await this.requestRaw(path, options)
    const text = await res.text()
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  /**
   * Perform a request and return the raw `Response`, throwing a
   * {@link TunnelProviderError} for a non-2xx status.
   */
  protected async requestRaw(
    path: string,
    options: TunnelRequestOptions = {},
  ): Promise<Response> {
    const url = this.url(path)
    const method = options.method ?? "GET"
    const headers: Record<string, string> = { ...this.defaultHeaders, ...(options.headers ?? {}) }

    if (options.auth !== false) {
      const authorization = await this.authorization(options.forceAuthRefresh === true)
      if (authorization) headers["authorization"] = authorization
    }
    if (options.body !== undefined) headers["content-type"] = "application/json"

    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        })
      } catch (cause) {
        const reason = timedOut
          ? `timed out after ${timeoutMs}ms`
          : controller.signal.aborted
            ? "aborted"
            : cause instanceof Error
              ? cause.message
              : String(cause)
        throw new TunnelProviderError(`${method} ${url} failed: ${reason}`, {
          code: timedOut ? "timeout" : "network_error",
          cause,
        })
      }

      // One refresh-and-retry for interactive OIDC credentials.
      if (
        res.status === 401 &&
        this.config.auth?.mode === "oidc" &&
        options.retryAuth !== false
      ) {
        return this.requestRaw(path, {
          ...options,
          retryAuth: false,
          forceAuthRefresh: true,
        })
      }

      if (!res.ok) throw await this.fail(res, `${method} ${path}`)
      return res
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
    }
  }

  /** Normalise a failed response into a {@link TunnelProviderError}. */
  protected async fail(res: Response, what: string): Promise<TunnelProviderError> {
    const text = await res.text().catch(() => "")
    let body: Record<string, unknown> = {}
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (isRecord(parsed)) body = parsed
      } catch {
        // Keep the raw text for the message below.
      }
    }
    const code =
      typeof body["error"] === "string" ? body["error"] : `http_${res.status}`
    const detail =
      typeof body["message"] === "string"
        ? body["message"]
        : typeof body["error_description"] === "string"
          ? body["error_description"]
          : text.slice(0, 200)
    const checkoutUrl =
      typeof body["checkoutUrl"] === "string" ? body["checkoutUrl"] : undefined
    return new TunnelProviderError(
      `${what} failed (${res.status})${detail ? `: ${detail}` : ""}`,
      {
        status: res.status,
        code,
        ...(checkoutUrl ? { checkoutUrl } : {}),
      },
    )
  }
}
