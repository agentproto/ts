import { buildQuotaStatus } from "../build.js"
import { defineQuotaReader } from "../registry.js"
import type {
  QuotaProfile,
  QuotaReadContext,
  QuotaReadFailure,
  QuotaReader,
  QuotaStatus,
} from "../types.js"

const DEFAULT_BASE_URL = "https://api.anthropic.com"
const DEFAULT_MODEL = "claude-haiku-4-5"
const DEFAULT_TIMEOUT_MS = 8000
const OAUTH_BETA = "oauth-2025-04-20"
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

const UNIFIED_PREFIX = "anthropic-ratelimit-unified-"
const UTILIZATION_SUFFIX = "-utilization"

function headerEntries(
  headers: Headers | Record<string, string | undefined>,
): [string, string][] {
  const out: [string, string][] = []
  if (headers instanceof Headers) {
    headers.forEach((value, key) => out.push([key.toLowerCase(), value]))
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) out.push([key.toLowerCase(), value])
    }
  }
  return out
}

function parseFraction(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  const n = Number(raw.trim())
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined
}

function parseEpochSeconds(raw: string | undefined): string | undefined {
  if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw.trim())) return undefined
  const date = new Date(Number(raw.trim()) * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * PURE: build a QuotaStatus from the `anthropic-ratelimit-unified-<id>-utilization`
 * (fraction 0-1 of the window used) and `-<id>-reset` (unix epoch seconds)
 * response headers Anthropic attaches to subscription (OAuth) traffic. Every
 * `<id>` found is emitted as a window with that id as given (`5h`, `7d`, and
 * any per-model id the provider sends); a window without a parseable
 * utilization is omitted, never zero-filled. `resetsAt` is only set when the
 * matching reset header parses.
 */
export function quotaFromAnthropicUnifiedUtilization(input: {
  profileRef: string
  headers: Headers | Record<string, string | undefined>
  now?: () => Date
}): QuotaStatus | undefined {
  const entries = headerEntries(input.headers)
  const byName = new Map(entries)
  const windows: Record<string, unknown>[] = []
  for (const [name] of entries) {
    if (!name.startsWith(UNIFIED_PREFIX) || !name.endsWith(UTILIZATION_SUFFIX)) continue
    const id = name.slice(UNIFIED_PREFIX.length, name.length - UTILIZATION_SUFFIX.length)
    if (!id) continue
    const used = parseFraction(byName.get(name))
    if (used === undefined) continue
    const resetsAt = parseEpochSeconds(byName.get(`${UNIFIED_PREFIX}${id}-reset`))
    windows.push({
      id,
      remainingPct: Math.round((1 - used) * 10000) / 100,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    })
  }
  return buildQuotaStatus({
    profileRef: input.profileRef,
    basis: "probe",
    source: "anthropic:oauth-unified-headers",
    now: input.now,
    windows,
  })
}

export interface AnthropicOAuthQuotaReaderOptions {
  baseUrl?: string
  /** Cheapest model to spend the one-token probe on. */
  model?: string
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
 * Anthropic subscription (OAuth bearer) quota reader. The 5h / 7d windows are
 * not served by a documented endpoint, so this sends ONE `max_tokens: 1`
 * Messages request with the profile's OAuth token and reads the
 * `anthropic-ratelimit-unified-*` headers of the reply. It therefore spends a
 * token or so of the subscription on each read, and its basis is `probe`
 * (undocumented surface). Never throws; every failure is reported through
 * `ctx.reportFailure` with a code, and the token is never echoed (the
 * credential is cited by its ref name only).
 */
export function createAnthropicOAuthQuotaReader(
  opts?: AnthropicOAuthQuotaReaderOptions,
): QuotaReader {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL
  const model = opts?.model ?? DEFAULT_MODEL
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return defineQuotaReader({
    id: "anthropic-oauth-unified",
    supports: (profile: QuotaProfile): boolean =>
      profile.endpoint === "anthropic" && profile.method === "oauth-bearer",
    read: async (
      profile: QuotaProfile,
      ctx: QuotaReadContext,
    ): Promise<QuotaStatus | undefined> => {
      try {
        const ref = profile.credentialRef
        if (!ref || !ctx.resolveCredential) {
          return fail(ctx, {
            code: "credential_missing",
            message: "The profile has no credentialRef to read an OAuth token from.",
          })
        }
        const secret = await ctx.resolveCredential(ref).catch(() => undefined)
        if (!secret) {
          return fail(ctx, {
            code: "credential_missing",
            message: `No OAuth token stored under keychain key "${ref}" (locked or absent).`,
          })
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const onAbort = () => controller.abort()
        ctx.signal?.addEventListener("abort", onAbort)
        let res: Response
        try {
          res = await (ctx.fetchImpl ?? fetch)(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "anthropic-beta": OAUTH_BETA,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              max_tokens: 1,
              system: [{ type: "text", text: CLAUDE_CODE_SYSTEM }],
              messages: [{ role: "user", content: "hi" }],
            }),
            signal: controller.signal,
          })
        } catch (err) {
          const name = err instanceof Error ? err.name : "error"
          return fail(ctx, {
            code: "provider_unreachable",
            message: `Could not reach Anthropic (${name}).`,
          })
        } finally {
          clearTimeout(timer)
          ctx.signal?.removeEventListener("abort", onAbort)
        }

        // Headers are authoritative even on a 429: a rate-limited reply still
        // carries the utilization of each window.
        const status = quotaFromAnthropicUnifiedUtilization({
          profileRef: profile.profileRef,
          headers: res.headers,
          now: ctx.now,
        })
        if (status) return status

        if (res.status === 401 || res.status === 403) {
          return fail(ctx, {
            code: "credential_rejected",
            message: `Anthropic rejected the OAuth token stored under "${ref}" (HTTP ${res.status}): expired or revoked. Log in again.`,
          })
        }
        if (res.status === 429) {
          return fail(ctx, {
            code: "rate_limited",
            message: "Anthropic answered HTTP 429 with no usage headers. Try again later.",
          })
        }
        if (!res.ok) {
          return fail(ctx, {
            code: "provider_unreachable",
            message: `Anthropic answered HTTP ${res.status}.`,
          })
        }
        return fail(ctx, {
          code: "no_usable_figures",
          message: "Anthropic answered but sent no anthropic-ratelimit-unified-*-utilization header.",
        })
      } catch {
        return undefined
      }
    },
  })
}
