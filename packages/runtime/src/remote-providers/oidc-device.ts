/**
 * OIDC Device Authorization Grant (RFC 8628) for headless daemons.
 *
 * The daemon has no browser of its own: it asks the identity provider for
 * a short user code, the human approves it on any device at
 * `verification_uri`, and the daemon polls the token endpoint until it gets
 * an access token (+ refresh token when `offline_access` is granted).
 * Tokens are persisted owner-only and refreshed transparently.
 *
 * Provider-agnostic: anything that serves `/.well-known/openid-configuration`
 * with a `device_authorization_endpoint` (Zitadel, Keycloak, Auth0, Okta…).
 * Public ("native") clients only — no client secret is ever sent or stored.
 *
 * Every HTTP call goes through an injected fetch; tokens never appear in an
 * error message or a log line.
 */

import type { FetchLike } from "./cloudflare-api.js"

export interface OidcClientConfig {
  /** Issuer base URL, e.g. https://auth.example.com */
  issuer: string
  /** Public (native) client id — not a secret. */
  clientId: string
  /** Space-separated scopes. Default "openid profile email offline_access". */
  scopes?: string
}

export interface OidcSession {
  accessToken: string
  refreshToken?: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
  /** `sub` claim when the token is a JWT (informational). */
  subject?: string
}

/** Where the session lives. Implementations must be owner-only (0600). */
export interface OidcSessionStore {
  read(): Promise<OidcSession | null>
  write(session: OidcSession): Promise<void>
  clear(): Promise<void>
}

export interface DeviceLoginPrompt {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  /** ISO time the code stops working. */
  expiresAt: string
}

export type DeviceLoginState =
  | { status: "logged_out" }
  | ({ status: "pending" } & DeviceLoginPrompt)
  | { status: "logged_in"; subject?: string; expiresAt: string }
  | { status: "failed"; reason: string }

interface Discovery {
  device_authorization_endpoint: string
  token_endpoint: string
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

export class OidcError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "OidcError"
    this.code = code
  }
}

export interface OidcDeviceClientOptions {
  config: OidcClientConfig
  store: OidcSessionStore
  fetch?: FetchLike
  /** Clock + sleep seams for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_SCOPES = "openid profile email offline_access"
/** Refresh this long before the access token actually expires. */
const REFRESH_SKEW_MS = 60_000

export class OidcDeviceClient {
  private readonly cfg: OidcClientConfig
  private readonly store: OidcSessionStore
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private discovery: Discovery | null = null
  private pending: (DeviceLoginPrompt & { done: Promise<void> }) | null = null
  private lastFailure: string | null = null

  constructor(opts: OidcDeviceClientOptions) {
    this.cfg = opts.config
    this.store = opts.store
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms).unref?.()))
  }

  /**
   * Start a device login and keep polling in the background. Returns the
   * prompt to show the human. Calling it again while a login is pending
   * returns the same prompt instead of minting a new code.
   */
  async beginLogin(): Promise<DeviceLoginPrompt> {
    if (this.pending) return promptOf(this.pending)
    const d = await this.discover()
    const res = await this.post(d.device_authorization_endpoint, {
      client_id: this.cfg.clientId,
      scope: this.cfg.scopes ?? DEFAULT_SCOPES,
    })
    const body = (await res.json()) as {
      device_code?: string
      user_code?: string
      verification_uri?: string
      verification_uri_complete?: string
      expires_in?: number
      interval?: number
      error?: string
      error_description?: string
    }
    if (!res.ok || !body.device_code || !body.user_code || !body.verification_uri) {
      throw new OidcError(
        body.error ?? "device_authorization_failed",
        `device authorization failed (${res.status}): ${body.error_description ?? body.error ?? "no device code"}`,
      )
    }
    const expiresAtMs = this.now() + (body.expires_in ?? 600) * 1000
    const prompt: DeviceLoginPrompt = {
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      ...(body.verification_uri_complete
        ? { verificationUriComplete: body.verification_uri_complete }
        : {}),
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
    this.lastFailure = null
    const done = this.poll(d, body.device_code, (body.interval ?? 5) * 1000, expiresAtMs)
      .catch((err: unknown) => {
        this.lastFailure = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        this.pending = null
      })
    this.pending = { ...prompt, done }
    return prompt
  }

  /** Resolves when the in-flight login (if any) settles. Tests / CLI. */
  async waitForLogin(): Promise<void> {
    await this.pending?.done
  }

  async state(): Promise<DeviceLoginState> {
    if (this.pending) return { status: "pending", ...promptOf(this.pending) }
    const s = await this.store.read()
    if (s && (s.refreshToken || s.expiresAt > this.now())) {
      return {
        status: "logged_in",
        ...(s.subject ? { subject: s.subject } : {}),
        expiresAt: new Date(s.expiresAt).toISOString(),
      }
    }
    if (this.lastFailure) return { status: "failed", reason: this.lastFailure }
    return { status: "logged_out" }
  }

  async logout(): Promise<void> {
    await this.store.clear()
  }

  /**
   * A valid access token, refreshing it when needed. Throws
   * `OidcError("login_required")` when there is no usable session.
   */
  async accessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const s = await this.store.read()
    if (!s) throw new OidcError("login_required", "not logged in — run tunnel_login first")
    if (!opts.forceRefresh && s.expiresAt - REFRESH_SKEW_MS > this.now()) return s.accessToken
    if (!s.refreshToken) {
      throw new OidcError("login_required", "session expired and has no refresh token — run tunnel_login again")
    }
    const d = await this.discover()
    const res = await this.post(d.token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: s.refreshToken,
      client_id: this.cfg.clientId,
    })
    const body = (await res.json()) as TokenResponse
    if (!res.ok || !body.access_token) {
      if (body.error === "invalid_grant") {
        await this.store.clear()
        throw new OidcError("login_required", "session revoked or expired — run tunnel_login again")
      }
      throw new OidcError(body.error ?? "refresh_failed", `token refresh failed (${res.status})`)
    }
    const next = this.toSession(body, s.refreshToken)
    await this.store.write(next)
    return next.accessToken
  }

  // ── internals ───────────────────────────────────────────────────────

  private async poll(d: Discovery, deviceCode: string, intervalMs: number, expiresAtMs: number): Promise<void> {
    let interval = intervalMs
    for (;;) {
      await this.sleep(interval)
      if (this.now() >= expiresAtMs) throw new OidcError("expired_token", "login code expired — start again")
      const res = await this.post(d.token_endpoint, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: this.cfg.clientId,
      })
      const body = (await res.json()) as TokenResponse
      if (res.ok && body.access_token) {
        await this.store.write(this.toSession(body))
        return
      }
      switch (body.error) {
        case "authorization_pending":
          continue
        case "slow_down":
          interval += 5_000
          continue
        case "access_denied":
          throw new OidcError("access_denied", "login was denied")
        case "expired_token":
          throw new OidcError("expired_token", "login code expired — start again")
        default:
          throw new OidcError(body.error ?? "token_failed", `login failed (${res.status}): ${body.error ?? "unknown error"}`)
      }
    }
  }

  private toSession(body: TokenResponse, previousRefresh?: string): OidcSession {
    const refresh = body.refresh_token ?? previousRefresh
    const subject = jwtSubject(body.access_token!)
    return {
      accessToken: body.access_token!,
      ...(refresh ? { refreshToken: refresh } : {}),
      expiresAt: this.now() + (body.expires_in ?? 3600) * 1000,
      ...(subject ? { subject } : {}),
    }
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery
    const url = `${this.cfg.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
    const res = await this.fetchImpl(url, { method: "GET" })
    const body = (await res.json().catch(() => ({}))) as Partial<Discovery>
    if (!res.ok || !body.token_endpoint) {
      throw new OidcError("discovery_failed", `OIDC discovery failed for ${this.cfg.issuer} (${res.status})`)
    }
    if (!body.device_authorization_endpoint) {
      throw new OidcError(
        "device_flow_unsupported",
        `${this.cfg.issuer} does not advertise a device_authorization_endpoint — enable the Device Code grant`,
      )
    }
    this.discovery = {
      device_authorization_endpoint: body.device_authorization_endpoint,
      token_endpoint: body.token_endpoint,
    }
    return this.discovery
  }

  private post(url: string, form: Record<string, string>) {
    return this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    })
  }
}

function promptOf(p: DeviceLoginPrompt): DeviceLoginPrompt {
  return {
    userCode: p.userCode,
    verificationUri: p.verificationUri,
    ...(p.verificationUriComplete ? { verificationUriComplete: p.verificationUriComplete } : {}),
    expiresAt: p.expiresAt,
  }
}

/** `sub` of a JWT access token, without verifying it (display only). */
function jwtSubject(token: string): string | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { sub?: unknown }
    return typeof claims.sub === "string" ? claims.sub : undefined
  } catch {
    return undefined
  }
}
