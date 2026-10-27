import { buildQuotaStatus, remainingPctFromCounts } from "../build.js"
import type { QuotaStatus } from "../types.js"

export interface AnthropicHeadersInput {
  profileRef: string
  headers: Headers | Record<string, string | undefined>
  now?: () => Date
}

interface Dimension {
  id: string
  header: string
  unit: string
}

const DIMENSIONS: readonly Dimension[] = [
  { id: "requests-1m", header: "requests", unit: "requests" },
  { id: "tokens-1m", header: "tokens", unit: "tokens" },
  { id: "input-tokens-1m", header: "input-tokens", unit: "tokens" },
  { id: "output-tokens-1m", header: "output-tokens", unit: "tokens" },
]

/** Read a header case-insensitively from a `Headers` or a plain record. */
function headerGet(
  headers: Headers | Record<string, string | undefined>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

/** Parse a numeric rate-limit header; empty/garbage → undefined. */
function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

/** Normalize an RFC 3339 reset header to an ISO string; unparseable → undefined. */
function parseReset(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * PURE: build a QuotaStatus from Anthropic's DOCUMENTED rate-limit headers
 * `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`.
 * The undocumented `anthropic-ratelimit-unified-*` family is never read.
 * A dimension with a missing/non-numeric limit or remaining is skipped.
 */
export function quotaFromAnthropicHeaders(input: AnthropicHeadersInput): QuotaStatus | undefined {
  const windows: Record<string, unknown>[] = []
  for (const dimension of DIMENSIONS) {
    const prefix = `anthropic-ratelimit-${dimension.header}`
    const limit = parseCount(headerGet(input.headers, `${prefix}-limit`))
    const remaining = parseCount(headerGet(input.headers, `${prefix}-remaining`))
    if (limit === undefined || remaining === undefined) continue
    const remainingPct = remainingPctFromCounts(remaining, limit)
    if (remainingPct === undefined) continue
    const resetsAt = parseReset(headerGet(input.headers, `${prefix}-reset`))
    windows.push({
      id: dimension.id,
      remainingPct,
      limit,
      remaining,
      unit: dimension.unit,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    })
  }
  return buildQuotaStatus({
    profileRef: input.profileRef,
    basis: "provider",
    source: "anthropic:ratelimit-headers",
    now: input.now,
    windows,
  })
}

/** One provider-reported remaining budget from the undocumented unified family. */
export interface AnthropicUnifiedWindow {
  window: "5h" | "7d"
  remaining: number
  resetsAt: string
  basis: "provider"
}

/** Both unified windows keyed by their label. */
export type AnthropicUnifiedWindows = {
  "5h"?: AnthropicUnifiedWindow
  "7d"?: AnthropicUnifiedWindow
}

/** Parse an integer remaining-count header; empty/garbage → undefined. */
function parseRemainingCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

/** Normalize a unified reset header (unix-epoch seconds OR an ISO instant)
 *  to an ISO string; unparseable → undefined. */
function parseUnifiedReset(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const secs = Number(trimmed)
    if (!Number.isFinite(secs)) return undefined
    const date = new Date(secs * 1000)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  const ms = Date.parse(trimmed)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

/**
 * PURE: extract the unified 5h/7d remaining budgets from Anthropic's
 * `anthropic-ratelimit-unified-<w>-{remaining,reset}` headers. A window is
 * emitted only when both its integer remaining and reset parse; otherwise it
 * is omitted, never fabricated.
 */
export function parseAnthropicUnifiedRateLimitHeaders(
  headers: Headers | Record<string, string | undefined>,
): AnthropicUnifiedWindows {
  const result: AnthropicUnifiedWindows = {}
  for (const window of ["5h", "7d"] as const) {
    const remaining = parseRemainingCount(
      headerGet(headers, `anthropic-ratelimit-unified-${window}-remaining`),
    )
    if (remaining === undefined) continue
    const resetsAt = parseUnifiedReset(
      headerGet(headers, `anthropic-ratelimit-unified-${window}-reset`),
    )
    if (resetsAt === undefined) continue
    result[window] = { window, remaining, resetsAt, basis: "provider" }
  }
  return result
}
