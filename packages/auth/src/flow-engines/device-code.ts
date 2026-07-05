/**
 * device-code flow engine — plain RFC 8628 device-authorization ceremony.
 *
 * Protocol:
 *   POST {device_authorization_endpoint} { client_id, scope?, device_label? }
 *     → device_code + user_code + verification_uri(_complete) + expires_in
 *   User approves at verification_uri in browser.
 *   Poll POST {token_endpoint} with grant_type=urn:ietf:params:oauth:grant-type:device_code
 *     until approved / denied / expired.
 *   On success: store the access_token as the durable credential (kind:"daemon")
 *     — unlike service-auth, the access token IS the thing that's persisted;
 *     refresh_token/scope/subject/revocation_id ride in `metadata`.
 *
 * Subsequent runs: a fresh stored credential (or one with no expiry) short-
 * circuits the ceremony. An expired credential with a stored refresh_token is
 * exchanged via `grant_type=refresh_token`; on failure (or when no
 * refresh_token was stored) a new ceremony starts.
 */

import { z } from "zod"
import type {
  FlowEngine,
  FlowRunOptions,
  FlowResult,
  AuthProviderHandle,
  DiscoveredEndpoints,
} from "../types.js"
import { KeychainStore } from "../store/keychain-store.js"
import { resolveStoreRefs, readStoreRefWithFallback } from "../store/resolve-ref.js"
import type { CredentialStore, StoreRef, StoredCredential } from "../store/types.js"
import { fetchWithDeadline, assertSecureUrl } from "../http.js"
import {
  openBrowser,
  postFormOAuth,
  pollDeviceGrant,
  tokenResponseSchema,
  type TokenSuccess,
} from "./device-grant.js"

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const REFRESH_GRANT_TYPE = "refresh_token"
const DEFAULT_POLL_INTERVAL_S = 5

// ── response schema ───────────────────────────────────────────────────────────
//
// JSON crosses a trust boundary here (the AS controls the bytes), so the
// response is validated with Zod rather than asserted. `.loose()` keeps
// unknown fields the spec may add.

const deviceAuthorizationResponseSchema = z
  .object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    verification_uri_complete: z.string().optional(),
    expires_in: z.number(),
    interval: z.number().optional(),
  })
  .loose()

// ── helpers ──────────────────────────────────────────────────────────────────

async function postDeviceAuthorization(
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
) {
  const res = await fetchWithDeadline(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`POST ${url} → ${res.status}: ${text}`)
  }
  return deviceAuthorizationResponseSchema.parse(await res.json())
}

/** Read a string metadata field without an `as` cast — `metadata` is
 *  `Record<string, unknown>`, so every read is a runtime type check. */
function metaString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = metadata?.[key]
  return typeof v === "string" ? v : undefined
}

function isExpired(cred: StoredCredential): boolean {
  if (!cred.expiresAt) return false
  const t = Date.parse(cred.expiresAt)
  if (Number.isNaN(t)) return true
  return t <= Date.now()
}

function resultFromStored(cred: StoredCredential): FlowResult {
  const refreshToken = metaString(cred.metadata, "refreshToken")
  const scope = metaString(cred.metadata, "scope")
  const subject = metaString(cred.metadata, "subject")
  const revocationId = metaString(cred.metadata, "revocationId")
  return {
    accessToken: cred.value,
    tokenKind: "daemon",
    ...(refreshToken ? { refreshToken } : {}),
    ...(scope ? { scope } : {}),
    ...(subject ? { subject } : {}),
    ...(revocationId ? { revocationId } : {}),
  }
}

/** Refresh via `grant_type=refresh_token`. Returns null on any error
 *  (expired / invalid_grant / server doesn't support the grant) so the
 *  caller falls back to a full ceremony. */
async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  signal?: AbortSignal,
): Promise<TokenSuccess | null> {
  try {
    const data = await postFormOAuth(
      tokenEndpoint,
      {
        grant_type: REFRESH_GRANT_TYPE,
        refresh_token: refreshToken,
        client_id: clientId,
      },
      tokenResponseSchema,
      signal,
    )
    if ("error" in data) return null
    return data
  } catch {
    return null
  }
}

async function persistAndResult(
  store: CredentialStore,
  ref: StoreRef,
  o: {
    accessToken: string
    expiresIn?: number
    refreshToken?: string
    scope?: string
    subject?: string
    deviceLabel?: string
    revocationId?: string
  },
): Promise<FlowResult> {
  const expiresAt = o.expiresIn
    ? new Date(Date.now() + o.expiresIn * 1_000).toISOString()
    : undefined

  const metadata: Record<string, unknown> = {
    obtainedAt: new Date().toISOString(),
    ...(o.refreshToken ? { refreshToken: o.refreshToken } : {}),
    ...(o.scope ? { scope: o.scope } : {}),
    ...(o.subject ? { subject: o.subject } : {}),
    ...(o.deviceLabel ? { deviceLabel: o.deviceLabel } : {}),
    ...(o.revocationId ? { revocationId: o.revocationId } : {}),
  }

  await store.write(ref, {
    value: o.accessToken,
    kind: "daemon",
    ...(expiresAt ? { expiresAt } : {}),
    metadata,
  })

  return {
    accessToken: o.accessToken,
    tokenKind: "daemon",
    ...(o.refreshToken ? { refreshToken: o.refreshToken } : {}),
    ...(o.scope ? { scope: o.scope } : {}),
    ...(o.subject ? { subject: o.subject } : {}),
    ...(o.revocationId ? { revocationId: o.revocationId } : {}),
  }
}

// ── engine ───────────────────────────────────────────────────────────────────

export const deviceCodeFlowEngine: FlowEngine = {
  id: "device-code",

  async run(
    provider: AuthProviderHandle,
    discovered: DiscoveredEndpoints | null,
    opts: FlowRunOptions,
  ): Promise<FlowResult> {
    const { auth } = provider
    if (auth.flow !== "device-code") {
      throw new Error(`deviceCodeFlowEngine: invoked with flow="${auth.flow}"`)
    }
    // `auth.flow === "device-code"` is guaranteed by the guard above, so the
    // discriminated union has already narrowed `auth` to DeviceCodeAuthConfig.
    const config = auth
    const clientId = config.clientId ?? "agentproto-cli"
    const server = opts.server.replace(/\/$/, "")

    // Endpoint resolution — prefer live discovery, fall back to conventions.
    const deviceAuthorizationEndpoint =
      discovered?.deviceAuthorizationEndpoint ?? `${server}/oauth/device`
    const tokenEndpoint = discovered?.tokenEndpoint ?? `${server}/oauth/token`

    // AIP-50 §Security: auth requests MUST use HTTPS (loopback exempt for dev).
    assertSecureUrl(deviceAuthorizationEndpoint)
    assertSecureUrl(tokenEndpoint)

    const store = opts.store ?? new KeychainStore()
    const { ref, legacyRef } = resolveStoreRefs(
      config.tokenStore,
      server,
      provider.audience,
    )

    // Cached path — the stored credential IS the access token (pat-class
    // persistence). A fresh (or expiry-less) credential short-circuits the
    // ceremony entirely; an expired one with a refresh_token is renewed via
    // grant_type=refresh_token before falling back to a ceremony.
    if (!opts.force) {
      const stored = await readStoreRefWithFallback(store, ref, legacyRef)
      if (stored) {
        if (!isExpired(stored)) {
          return resultFromStored(stored)
        }
        const refreshToken = metaString(stored.metadata, "refreshToken")
        if (refreshToken) {
          const refreshed = await refreshAccessToken(
            tokenEndpoint,
            refreshToken,
            clientId,
            opts.signal,
          )
          if (refreshed) {
            return persistAndResult(store, ref, {
              accessToken: refreshed.access_token,
              expiresIn: refreshed.expires_in,
              refreshToken: refreshed.refresh_token ?? refreshToken,
              scope: refreshed.scope ?? metaString(stored.metadata, "scope"),
              subject: refreshed.subject ?? metaString(stored.metadata, "subject"),
              deviceLabel:
                config.deviceLabel ?? metaString(stored.metadata, "deviceLabel"),
              revocationId:
                refreshed.revocation_id ?? metaString(stored.metadata, "revocationId"),
            })
          }
          // refresh failed (expired / invalid_grant) — fall through to a ceremony
        }
      }
    }

    // 1 — POST the device-authorization endpoint to start the ceremony
    const params: Record<string, string> = { client_id: clientId }
    if (config.scope) params.scope = config.scope
    if (config.deviceLabel) params.device_label = config.deviceLabel

    const authz = await postDeviceAuthorization(
      deviceAuthorizationEndpoint,
      params,
      opts.signal,
    )

    const intervalS = authz.interval ?? DEFAULT_POLL_INTERVAL_S
    const windowMin = Math.round(authz.expires_in / 60)

    // 2 — Print code + open browser
    process.stderr.write(`\n`)
    process.stderr.write(`  Approve ${provider.id} access in your browser\n\n`)
    process.stderr.write(`  Code:  ${authz.user_code}\n`)
    process.stderr.write(`  URL:   ${authz.verification_uri}\n\n`)
    if (opts.openBrowser !== false) {
      await openBrowser(authz.verification_uri_complete ?? authz.verification_uri)
    }
    process.stderr.write(`  Waiting for approval (${windowMin} min)…\n\n`)

    // 3 — Poll until approved / denied / expired
    const tokenResult = await pollDeviceGrant({
      tokenEndpoint,
      grantType: DEVICE_CODE_GRANT_TYPE,
      params: { device_code: authz.device_code, client_id: clientId },
      intervalS,
      expiresIn: authz.expires_in,
      signal: opts.signal,
    })

    // 4 — Persist the access token as the durable credential (pat-class).
    return persistAndResult(store, ref, {
      accessToken: tokenResult.access_token,
      expiresIn: tokenResult.expires_in,
      refreshToken: tokenResult.refresh_token,
      scope: tokenResult.scope,
      subject: tokenResult.subject,
      deviceLabel: config.deviceLabel,
      revocationId: tokenResult.revocation_id,
    })
  },
}
