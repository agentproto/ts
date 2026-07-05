/**
 * Shared RFC 8628 device-grant polling primitive (internal, not exported from
 * the package root).
 *
 * Both the auth.md claim ceremony (`service-auth.ts`) and the device-code flow
 * poll an OAuth token endpoint with a grant-specific URN until the AS reports
 * success or a terminal error. This module holds that shared poll loop plus
 * the small HTTP/browser helpers both flows need — lifted verbatim from
 * `service-auth.ts` so new flow engines have somewhere to reuse them from.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { fetchWithDeadline } from "../http.js"

const execAsync = promisify(execFile)

// ── response schemas ──────────────────────────────────────────────────────────
//
// JSON crosses a trust boundary here (the AS controls the bytes), so every
// response is validated with Zod rather than asserted. `.loose()` keeps unknown
// fields the spec may add. The inferred types feed the rest of the engine.

/** Successful token/refresh/exchange response — the AS minted a credential. */
export const tokenSuccessSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string().optional(),
    refresh_token: z.string().optional(),
    identity_assertion: z.string().optional(),
    assertion_expires_in: z.number().optional(),
    assertion_expires: z.string().optional(),
    // device-code flow fields (ignored by service-auth today; see WP-2).
    expires_in: z.number().optional(),
    scope: z.string().optional(),
    subject: z.string().optional(),
    revocation_id: z.string().optional(),
  })
  .loose()

/** OAuth error response (`authorization_pending`, `slow_down`, `access_denied`…). */
export const tokenErrorSchema = z
  .object({
    error: z.string(),
    error_description: z.string().optional(),
  })
  .loose()

/** A token endpoint reply is either a minted credential or an OAuth error.
 *  Success is tried first so a body carrying an access_token never matches the
 *  error arm. */
export const tokenResponseSchema = z.union([tokenSuccessSchema, tokenErrorSchema])

export type TokenSuccess = z.infer<typeof tokenSuccessSchema>

// ── helpers ──────────────────────────────────────────────────────────────────

export async function openBrowser(url: string): Promise<void> {
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

// NOTE: deliberately does NOT check res.ok — the OAuth device/claim flow returns
// HTTP 400 with a JSON `{ error }` body for authorization_pending / slow_down,
// which the poll loop reads as data. Throwing on non-2xx would break polling.
export async function postFormOAuth<T>(
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

export interface DeviceGrantPollOptions {
  /** Token endpoint URL to poll. */
  tokenEndpoint: string
  /** Grant-type URN sent on every poll (e.g. the claim or device_code grant). */
  grantType: string
  /** Token-carrying form params — e.g. `claim_token`/`device_code` plus
   *  `client_id`. `grant_type` is added automatically; do not include it here. */
  params: Record<string, string>
  /** Poll interval in seconds; grows by 5s on each `slow_down`. */
  intervalS: number
  /** Approval window in seconds, measured from when polling starts. */
  expiresIn: number
  signal?: AbortSignal
}

/** RFC 8628 poll loop shared by every grant that polls a token endpoint for
 *  user approval (auth.md claim ceremony, device-code). */
export async function pollDeviceGrant(
  o: DeviceGrantPollOptions,
): Promise<TokenSuccess> {
  const deadline = Date.now() + o.expiresIn * 1_000
  let pollMs = o.intervalS * 1_000

  while (Date.now() < deadline) {
    if (o.signal?.aborted) throw new Error("auth cancelled")
    await new Promise<void>((r) => setTimeout(r, pollMs))

    const data = await postFormOAuth(
      o.tokenEndpoint,
      { grant_type: o.grantType, ...o.params },
      tokenResponseSchema,
      o.signal,
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
