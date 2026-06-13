/**
 * service-auth flow engine — auth.md claim ceremony.
 *
 * Protocol:
 *   POST /agent/identity { type:"service_auth" }
 *     → registration_id + claim_token + user_code + verification_uri
 *   User approves at verification_uri in browser.
 *   Poll POST {token_endpoint} with grant_type=urn:workos:agent-auth:grant-type:claim
 *     until approved / denied / expired.
 *   On success: store the rotating refresh token (ort_*) in the primary slot and
 *     the identity_assertion in the `<keychain>-assertion` slot.
 *
 * Subsequent runs skip the ceremony: a cached ort_* is exchanged via the
 * refresh_token grant, and failing that a stored assertion is exchanged via the
 * jwt-bearer grant — only when both are unavailable does a new ceremony start.
 *
 * See: https://github.com/workos/auth.md  /  AIP-50
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import type {
  FlowEngine,
  FlowRunOptions,
  FlowResult,
  AuthProviderHandle,
  DiscoveredEndpoints,
} from "../types.js"
import {
  resolveAccount,
  readKeychainToken,
  writeKeychainToken,
} from "../token-store.js"
import { fetchWithDeadline } from "../http.js"

const execAsync = promisify(execFile)

const CLAIM_GRANT_TYPE = "urn:workos:agent-auth:grant-type:claim"
const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer"
const DEFAULT_POLL_INTERVAL_S = 5

// ── response schemas ──────────────────────────────────────────────────────────
//
// JSON crosses a trust boundary here (the AS controls the bytes), so every
// response is validated with Zod rather than asserted. `.loose()` keeps unknown
// fields the spec may add. The inferred types feed the rest of the engine.

const identityResponseSchema = z
  .object({
    registration_id: z.string(),
    claim_token: z.string(),
    claim: z
      .object({
        user_code: z.string(),
        verification_uri: z.string(),
        expires_in: z.number(),
        interval: z.number().optional(),
      })
      .loose(),
  })
  .loose()

/** Successful token/refresh/exchange response — the AS minted a credential. */
const tokenSuccessSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string().optional(),
    refresh_token: z.string().optional(),
    identity_assertion: z.string().optional(),
    assertion_expires_in: z.number().optional(),
    assertion_expires: z.string().optional(),
  })
  .loose()

/** OAuth error response (`authorization_pending`, `slow_down`, `access_denied`…). */
const tokenErrorSchema = z
  .object({
    error: z.string(),
    error_description: z.string().optional(),
  })
  .loose()

/** A token endpoint reply is either a minted credential or an OAuth error.
 *  Success is tried first so a body carrying an access_token never matches the
 *  error arm. */
const tokenResponseSchema = z.union([tokenSuccessSchema, tokenErrorSchema])

type TokenSuccess = z.infer<typeof tokenSuccessSchema>

// ── helpers ──────────────────────────────────────────────────────────────────

async function openBrowser(url: string): Promise<void> {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", url]]
        : ["xdg-open", [url]]
  try {
    await execAsync(cmd, args)
  } catch {
    // best-effort — URL already printed to stderr
  }
}

async function postJson<T>(
  url: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetchWithDeadline(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`POST ${url} → ${res.status}: ${text}`)
  }
  return schema.parse(await res.json())
}

// NOTE: deliberately does NOT check res.ok — the OAuth device/claim flow returns
// HTTP 400 with a JSON `{ error }` body for authorization_pending / slow_down,
// which the poll loop reads as data. Throwing on non-2xx would break polling.
async function postForm<T>(
  url: string,
  params: Record<string, string>,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetchWithDeadline(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal,
  })
  return schema.parse(await res.json())
}

async function pollForToken(
  tokenEndpoint: string,
  claimToken: string,
  clientId: string,
  intervalS: number,
  expiresIn: number,
  signal?: AbortSignal,
): Promise<TokenSuccess> {
  const deadline = Date.now() + expiresIn * 1_000
  let pollMs = intervalS * 1_000

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("auth cancelled")
    await new Promise<void>((r) => setTimeout(r, pollMs))

    const data = await postForm(
      tokenEndpoint,
      {
        grant_type: CLAIM_GRANT_TYPE,
        claim_token: claimToken,
        client_id: clientId,
      },
      tokenResponseSchema,
      signal,
    )

    if (!("error" in data)) return data

    const pollErr = data.error
    if (pollErr === "authorization_pending") continue
    if (pollErr === "slow_down") {
      pollMs += 5_000
      continue
    }
    if (pollErr === "expired_token") {
      throw new Error("auth timeout — claim expired before user approved")
    }
    if (pollErr === "access_denied") {
      throw new Error("access denied — user rejected the authorisation request")
    }

    const desc = data.error_description
    throw new Error(`token endpoint error: ${pollErr}${desc ? ` — ${desc}` : ""}`)
  }

  throw new Error("auth timeout — approval window closed")
}

// ── Refresh token exchange ────────────────────────────────────────────────────
//
// When a `ort_*` refresh token is cached in the primary Keychain slot, exchange
// it for a fresh `oat_*` access token without requiring another browser-approve
// ceremony. The server uses rotating refresh tokens so the response includes a
// new `ort_*` which replaces the old one in Keychain.

async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  signal?: AbortSignal,
): Promise<TokenSuccess | null> {
  try {
    const data = await postForm(
      tokenEndpoint,
      {
        grant_type: "refresh_token",
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

// ── Identity-assertion exchange (jwt-bearer) ──────────────────────────────────
//
// When the primary slot has no usable refresh token but a prior ceremony stored
// an identity_assertion in the `-assertion` slot, exchange it via RFC 7523
// jwt-bearer for a fresh access token — sparing the user a full browser ceremony
// while the assertion is still valid. Returns null on any error (expired /
// revoked / server doesn't support the grant) so the caller falls through.
async function exchangeAssertion(
  tokenEndpoint: string,
  assertion: string,
  clientId: string,
  signal?: AbortSignal,
): Promise<TokenSuccess | null> {
  try {
    const data = await postForm(
      tokenEndpoint,
      {
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion,
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

// ── engine ───────────────────────────────────────────────────────────────────

export const serviceAuthFlowEngine: FlowEngine = {
  id: "service-auth",

  async run(
    provider: AuthProviderHandle,
    discovered: DiscoveredEndpoints | null,
    opts: FlowRunOptions,
  ): Promise<FlowResult> {
    const { auth } = provider
    if (auth.flow !== "service-auth") {
      throw new Error(`serviceAuthFlowEngine: invoked with flow="${auth.flow}"`)
    }
    // `auth.flow === "service-auth"` is guaranteed by the guard above, so the
    // discriminated union has already narrowed `auth` to ServiceAuthConfig.
    const config = auth
    const clientId = config.clientId ?? "agentproto-cli"
    const server = opts.server.replace(/\/$/, "")

    // Endpoint resolution — prefer live discovery, fall back to conventions
    const identityEndpoint =
      discovered?.identityEndpoint ?? `${server}/agent/identity`
    const tokenEndpoint =
      discovered?.tokenEndpoint ?? `${server}/oauth/token`

    const primarySlot = config.tokenStore.keychain
    const assertionSlot = `${primarySlot}-assertion`
    const account = resolveAccount(config.tokenStore.account, server)

    // Cached credential path — skip the ceremony if we already hold a credential.
    // Precedence (each step falls through on failure):
    //   1. ort_* in the primary slot → refresh_token grant → fresh oat_* (+ rotate)
    //   2. legacy oat_*/gld_* in the primary slot → return as-is
    //   3. identity_assertion in the -assertion slot → jwt-bearer grant → oat_*
    //   4. nothing usable → full browser ceremony (below)
    if (!opts.force) {
      const cached = await readKeychainToken(primarySlot, account)
      if (cached) {
        if (cached.startsWith("ort_")) {
          const refreshed = await refreshAccessToken(
            tokenEndpoint,
            cached,
            clientId,
            opts.signal,
          )
          if (refreshed) {
            if (refreshed.refresh_token) {
              await writeKeychainToken(primarySlot, account, refreshed.refresh_token)
            }
            return { accessToken: refreshed.access_token, tokenKind: "oat" }
          }
          // Refresh failed (expired/revoked) — fall through; the ceremony (or an
          // assertion exchange) overwrites the stale ort_* at the end.
        } else {
          // Legacy oat_* or gld_* in slot — return as-is.
          return { accessToken: cached, tokenKind: "oat" }
        }
      }

      // No usable access token from the primary slot — try a stored
      // identity_assertion via jwt-bearer before forcing a browser ceremony.
      const storedAssertion = await readKeychainToken(assertionSlot, account)
      if (storedAssertion) {
        const exchanged = await exchangeAssertion(
          tokenEndpoint,
          storedAssertion,
          clientId,
          opts.signal,
        )
        if (exchanged) {
          if (exchanged.refresh_token) {
            await writeKeychainToken(primarySlot, account, exchanged.refresh_token)
          }
          return { accessToken: exchanged.access_token, tokenKind: "oat" }
        }
      }
    }

    // 1 — POST /agent/identity to start the claim ceremony
    const identity = await postJson(
      identityEndpoint,
      {
        type: "service_auth",
        client_id: clientId,
        ...(config.loginHint ? { login_hint: config.loginHint } : {}),
      },
      identityResponseSchema,
      opts.signal,
    )

    const { claim_token, claim } = identity
    const intervalS = claim.interval ?? DEFAULT_POLL_INTERVAL_S
    const windowMin = Math.round(claim.expires_in / 60)

    // 2 — Print code + open browser
    process.stderr.write(`\n`)
    process.stderr.write(`  Approve ${provider.id} access in your browser\n\n`)
    process.stderr.write(`  Code:  ${claim.user_code}\n`)
    process.stderr.write(`  URL:   ${claim.verification_uri}\n\n`)
    await openBrowser(claim.verification_uri)
    process.stderr.write(`  Waiting for approval (${windowMin} min)…\n\n`)

    // 3 — Poll until approved / denied / expired
    const tokenResult = await pollForToken(
      tokenEndpoint,
      claim_token,
      clientId,
      intervalS,
      claim.expires_in,
      opts.signal,
    )

    // 4 — Store ort_* in the primary slot (survives 30 days; auto-exchanged on
    //     next bureau login). Fall back to oat_* if the server didn't issue a
    //     refresh token (e.g. a PAT-style server that doesn't support rotation).
    //     Store identity_assertion in a secondary slot for future jwt-bearer use.
    const accessToken = tokenResult.access_token
    const refreshToken = tokenResult.refresh_token
    const assertion = tokenResult.identity_assertion

    await writeKeychainToken(
      config.tokenStore.keychain,
      account,
      refreshToken ?? accessToken,
    )
    if (assertion) {
      await writeKeychainToken(
        `${config.tokenStore.keychain}-assertion`,
        account,
        assertion,
      )
    }

    // Resolve assertion expiry as ISO 8601
    let assertionExpires: string | undefined
    if (tokenResult.assertion_expires) {
      assertionExpires = tokenResult.assertion_expires
    } else if (tokenResult.assertion_expires_in) {
      assertionExpires = new Date(
        Date.now() + tokenResult.assertion_expires_in * 1_000,
      ).toISOString()
    }

    return {
      accessToken,
      identityAssertion: assertion,
      assertionExpires,
      tokenKind: "oat",
    }
  },
}
