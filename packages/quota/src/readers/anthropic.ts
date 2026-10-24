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
