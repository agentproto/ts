/**
 * service-auth flow engine — auth.md claim ceremony.
 *
 * Protocol:
 *   POST /agent/identity { type:"service_auth" }
 *     → registration_id + claim_token + user_code + verification_uri
 *   User approves at verification_uri in browser.
 *   Poll POST {token_endpoint} with grant_type=urn:workos:agent-auth:grant-type:claim
 *     until approved / denied / expired.
 *   On success: store the identity_assertion JWT (AIP-50 §Token storage —
 *     the assertion is the durable credential; the access_token MUST NOT be
 *     persisted, and the claim_token stays in memory only).
 *
 * Subsequent runs skip the ceremony: the stored assertion is exchanged via the
 * jwt-bearer grant for a fresh access_token ("this IS the refresh path" — no
 * refresh_token). Only when the assertion is expired/rejected does a new
 * ceremony start.
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
import { KeychainStore } from "../store/keychain-store.js"
import { resolveStoreRef } from "../store/resolve-ref.js"
import { fetchWithDeadline, assertSecureUrl } from "../http.js"

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

// ── Identity-assertion exchange (jwt-bearer, RFC 7523) ────────────────────────
//
// The stored credential IS the identity_assertion JWT. Exchange it at the token
// endpoint for a fresh, short-lived access token — the AIP-50 refresh path, with
// no refresh_token involved. Returns null on any error (expired / invalid_grant
// / server doesn't support the grant) so the caller falls back to a ceremony.
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

    // AIP-50 §Security: auth requests MUST use HTTPS (loopback exempt for dev).
    assertSecureUrl(identityEndpoint)
    assertSecureUrl(tokenEndpoint)

    const store = opts.store ?? new KeychainStore()
    const ref = resolveStoreRef(config.tokenStore, server)

    // Cached path — the stored credential IS the identity_assertion JWT (AIP-50:
    // never the access token, never a refresh token). Exchange it via jwt-bearer
    // for a fresh access token; on failure (expired / invalid_grant) fall through
    // to a full browser ceremony.
    if (!opts.force) {
      const stored = await store.read(ref)
      if (stored) {
        const exchanged = await exchangeAssertion(
          tokenEndpoint,
          stored.value,
          clientId,
          opts.signal,
        )
        if (exchanged) {
          // If the server rotated the assertion, persist the new one; otherwise
          // the existing assertion stays valid for the next exchange.
          if (exchanged.identity_assertion) {
            await store.write(ref, {
              value: exchanged.identity_assertion,
              kind: "assertion",
            })
          }
          return {
            accessToken: exchanged.access_token,
            ...(exchanged.identity_assertion
              ? { identityAssertion: exchanged.identity_assertion }
              : {}),
            tokenKind: "oat",
          }
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

    // 4 — Store the identity_assertion as the durable credential (AIP-50: the
    //     access_token is ephemeral and MUST NOT be persisted; the claim_token
    //     was held in memory only). The assertion is re-exchanged via jwt-bearer
    //     on the next run.
    const accessToken = tokenResult.access_token
    const assertion = tokenResult.identity_assertion

    // Resolve assertion expiry as ISO 8601
    let assertionExpires: string | undefined
    if (tokenResult.assertion_expires) {
      assertionExpires = tokenResult.assertion_expires
    } else if (tokenResult.assertion_expires_in) {
      assertionExpires = new Date(
        Date.now() + tokenResult.assertion_expires_in * 1_000,
      ).toISOString()
    }

    if (assertion) {
      await store.write(ref, {
        value: assertion,
        kind: "assertion",
        ...(assertionExpires ? { expiresAt: assertionExpires } : {}),
      })
    }

    return {
      accessToken,
      identityAssertion: assertion,
      assertionExpires,
      tokenKind: "oat",
    }
  },
}
