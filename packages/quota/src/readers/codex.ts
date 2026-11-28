import { buildQuotaStatus } from "../build.js"
import type { QuotaBasis, QuotaCredits, QuotaStatus, QuotaWindow } from "../types.js"

/** One side of a Codex `rate_limits` payload. */
export interface CodexRateLimitWindow {
  used_percent: number
  window_minutes?: number
  /** Window length in seconds (the usage endpoint's form). 18000 labels the
   *  window `5h`, 604800 labels it `7d`; any other length keeps the side's id. */
  limit_window_seconds?: number
  /** Seconds until reset, used when `reset_at` is absent. */
  reset_after_seconds?: number
  /** Epoch seconds. */
  reset_at?: number
}

export interface CodexRateLimits {
  primary?: CodexRateLimitWindow
  secondary?: CodexRateLimitWindow
}

export interface CodexCredits {
  has_credits?: boolean
  unlimited?: boolean
  balance?: number
}

export interface CodexRateLimitsInput {
  profileRef: string
  rateLimits: CodexRateLimits
  credits?: CodexCredits
  now?: () => Date
  /** Defaults to `provider` (a captured `rate_limits` payload). */
  basis?: QuotaBasis
  /** Defaults to `codex:rate_limits`. */
  source?: string
}

/** remainingPct clamped to 0..100; a used percentage >100 maps to 0, kept. */
function remainingPct(used: number): number {
  return Math.max(0, Math.min(100, 100 - used))
}

const WINDOW_LABELS: ReadonlyMap<number, string> = new Map([
  [18000, "5h"],
  [604800, "7d"],
])

function windowFromSide(
  id: string,
  side: CodexRateLimitWindow | undefined,
  now: () => Date,
): QuotaWindow | undefined {
  if (!side || typeof side.used_percent !== "number" || !Number.isFinite(side.used_percent)) {
    return undefined
  }
  const label =
    typeof side.limit_window_seconds === "number" ? WINDOW_LABELS.get(side.limit_window_seconds) : undefined
  const window: QuotaWindow = { id: label ?? id, remainingPct: remainingPct(side.used_percent) }
  let resetMs: number | undefined
  if (typeof side.reset_at === "number" && Number.isFinite(side.reset_at)) {
    resetMs = side.reset_at * 1000
  } else if (typeof side.reset_after_seconds === "number" && Number.isFinite(side.reset_after_seconds)) {
    resetMs = now().getTime() + side.reset_after_seconds * 1000
  }
  if (resetMs !== undefined) {
    const date = new Date(resetMs)
    if (!Number.isNaN(date.getTime())) window.resetsAt = date.toISOString()
  }
  return window
}

/**
 * Pure parser for a Codex `rate_limits` payload: each present side becomes one
 * window and optional credits become a credits block. Never throws; a missing
 * or non-numeric field is dropped, a valid value (0 included) is kept.
 */
export function quotaFromCodexRateLimits(
  input: CodexRateLimitsInput,
): QuotaStatus | undefined {
  try {
    const windows: QuotaWindow[] = []
    const now = input.now ?? (() => new Date())
    const primary = windowFromSide("primary", input.rateLimits?.primary, now)
    if (primary) windows.push(primary)
    const secondary = windowFromSide("secondary", input.rateLimits?.secondary, now)
    if (secondary) windows.push(secondary)

    let credits: QuotaCredits | undefined
    const raw = input.credits
    if (raw) {
      const hasBalance = typeof raw.balance === "number" && Number.isFinite(raw.balance)
      if (raw.unlimited === true || hasBalance) {
        credits = { currency: "USD" }
        if (raw.unlimited === true) credits.unlimited = true
        if (hasBalance) credits.balanceUsd = raw.balance
      }
    }

    return buildQuotaStatus({
      profileRef: input.profileRef,
      basis: input.basis ?? "provider",
      source: input.source ?? "codex:rate_limits",
      now: input.now,
      windows,
      ...(credits !== undefined ? { credits } : {}),
    })
  } catch {
    return undefined
  }
}
