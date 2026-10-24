import { buildQuotaStatus } from "../build.js"
import type { QuotaCredits, QuotaStatus, QuotaWindow } from "../types.js"

/** One side of a Codex `rate_limits` payload. */
export interface CodexRateLimitWindow {
  used_percent: number
  window_minutes?: number
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
}

/** remainingPct clamped to 0..100; a used percentage >100 maps to 0, kept. */
function remainingPct(used: number): number {
  return Math.max(0, Math.min(100, 100 - used))
}

function windowFromSide(id: string, side: CodexRateLimitWindow | undefined): QuotaWindow | undefined {
  if (!side || typeof side.used_percent !== "number" || !Number.isFinite(side.used_percent)) {
    return undefined
  }
  const window: QuotaWindow = { id, remainingPct: remainingPct(side.used_percent) }
  if (typeof side.reset_at === "number" && Number.isFinite(side.reset_at)) {
    const date = new Date(side.reset_at * 1000)
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
    const primary = windowFromSide("primary", input.rateLimits?.primary)
    if (primary) windows.push(primary)
    const secondary = windowFromSide("secondary", input.rateLimits?.secondary)
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
      basis: "provider",
      source: "codex:rate_limits",
      now: input.now,
      windows,
      ...(credits !== undefined ? { credits } : {}),
    })
  } catch {
    return undefined
  }
}
