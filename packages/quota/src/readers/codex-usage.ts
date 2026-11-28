import { defineQuotaReader } from "../registry.js"
import type { QuotaProfile, QuotaReadContext, QuotaReadFailure, QuotaReader, QuotaStatus } from "../types.js"
import { quotaFromCodexRateLimits, type CodexRateLimitWindow } from "./codex.js"

const DEFAULT_URL = "https://chatgpt.com/backend-api/wham/usage"
const DEFAULT_TIMEOUT_MS = 8000

/** The login a Codex profile reads with. SECRET: handed to fetch, never returned. */
export interface CodexUsageLogin {
  accessToken: string
  /** Workspace the login is bound to (`tokens.account_id`). */
  accountId?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function sideOf(v: unknown): CodexRateLimitWindow | undefined {
  if (!isRecord(v) || typeof v.used_percent !== "number") return undefined
  const out: CodexRateLimitWindow = { used_percent: v.used_percent }
  if (typeof v.limit_window_seconds === "number") out.limit_window_seconds = v.limit_window_seconds
  if (typeof v.reset_after_seconds === "number") out.reset_after_seconds = v.reset_after_seconds
  if (typeof v.reset_at === "number") out.reset_at = v.reset_at
  return out
}

/**
 * PURE: a `/wham/usage` body → QuotaStatus. The shape is not documented; what
 * was observed in the codex binary is `primary_window` / `secondary_window`
 * with `used_percent`, `limit_window_seconds`, `reset_after_seconds`,
 * `reset_at`, under a `rate_limit` object. The windows are looked up there,
 * then at the top level, and anything else yields `undefined` (never a guess).
 */
export function quotaFromCodexUsagePayload(input: {
  profileRef: string
  body: unknown
  now?: () => Date
}): QuotaStatus | undefined {
  try {
    if (!isRecord(input.body)) return undefined
    const holder = isRecord(input.body.rate_limit)
      ? input.body.rate_limit
      : isRecord(input.body.rate_limits)
        ? input.body.rate_limits
        : input.body
    const primary = sideOf(holder.primary_window)
    const secondary = sideOf(holder.secondary_window)
    if (!primary && !secondary) return undefined
    const status = quotaFromCodexRateLimits({
      profileRef: input.profileRef,
      rateLimits: { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) },
      basis: "probe",
      source: "codex:wham-usage",
      ...(input.now ? { now: input.now } : {}),
    })
    return status && status.windows.length > 0 ? status : undefined
  } catch {
    return undefined
  }
}

export interface CodexQuotaReaderOptions {
  /** Resolve the profile's Codex login (the quota package never touches the
   *  disk). Undefined ⇒ no usable login. */
  readLogin: (profile: QuotaProfile) => Promise<CodexUsageLogin | undefined>
  /** Override the endpoint (tests). */
  url?: string
  timeoutMs?: number
}

function fail(ctx: QuotaReadContext, failure: QuotaReadFailure): undefined {
  try {
    ctx.reportFailure?.(failure)
  } catch {
    // a diagnostic sink must never break the read
  }
  return undefined
}

/**
 * Codex subscription (ChatGPT login) usage reader: one GET of the ChatGPT
 * backend usage endpoint with the profile's bearer and workspace header. The
 * endpoint is undocumented, so the basis is `probe` and the parse is defensive.
 * It spends nothing. Never throws; every failure goes through
 * `ctx.reportFailure`, and neither the token nor the login file path is echoed.
 */
export function createCodexQuotaReader(opts: CodexQuotaReaderOptions): QuotaReader {
  const url = opts.url ?? DEFAULT_URL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return defineQuotaReader({
    id: "codex-wham-usage",
    supports: (p: QuotaProfile): boolean =>
      p.endpoint === "openai" && p.method === "oauth-bearer" && p.source === "codex",
    read: async (profile, ctx) => {
      try {
        let login: CodexUsageLogin | undefined
        try {
          login = await opts.readLogin(profile)
        } catch {
          login = undefined
        }
        if (!login || login.accessToken === "") {
          return fail(ctx, {
            code: "credential_missing",
            message: "No Codex login found for this profile (log in with codex in its home, then retry).",
          })
        }
        const workspace = profile.workspaceId ?? login.accountId
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const onAbort = () => controller.abort()
        ctx.signal?.addEventListener("abort", onAbort)
        let res: Response
        try {
          res = await (ctx.fetchImpl ?? fetch)(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${login.accessToken}`,
              ...(workspace ? { "ChatGPT-Account-Id": workspace } : {}),
              Accept: "application/json",
            },
            signal: controller.signal,
          })
        } catch (err) {
          const name = err instanceof Error ? err.name : "error"
          return fail(ctx, { code: "provider_unreachable", message: `Could not reach the ChatGPT backend (${name}).` })
        } finally {
          clearTimeout(timer)
          ctx.signal?.removeEventListener("abort", onAbort)
        }
        if (res.status === 401 || res.status === 403) {
          return fail(ctx, {
            code: "credential_rejected",
            message: `ChatGPT rejected the Codex login (HTTP ${res.status}): expired or revoked. Log in again.`,
          })
        }
        if (res.status === 429) {
          return fail(ctx, { code: "rate_limited", message: "ChatGPT answered HTTP 429. Try again later." })
        }
        if (!res.ok) {
          return fail(ctx, { code: "provider_unreachable", message: `ChatGPT answered HTTP ${res.status}.` })
        }
        let body: unknown
        try {
          body = await res.json()
        } catch {
          body = undefined
        }
        const status = quotaFromCodexUsagePayload({
          profileRef: profile.profileRef,
          body,
          ...(ctx.now ? { now: ctx.now } : {}),
        })
        if (status) return status
        return fail(ctx, {
          code: "no_usable_figures",
          message: "The ChatGPT usage endpoint answered but with no recognisable rate-limit windows.",
        })
      } catch {
        return undefined
      }
    },
  })
}
