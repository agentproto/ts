/**
 * Coverage for the pure Codex `rate_limits` parser: used percentages mapped and
 * clamped (100 → 0, 0 → 100, 130 → 0), a missing secondary, a non-numeric
 * used_percent dropped, a bad reset_at keeping the window without resetsAt,
 * by-credits handling, and nothing usable collapsing to undefined.
 */
import { describe, expect, it } from "vitest"
import { quotaFromCodexRateLimits } from "../../index.js"
import type { CodexRateLimits } from "../../readers/codex.js"

const FIXED = () => new Date("2026-10-19T00:00:00.000Z")
const RESET = 1_792_190_400

describe("quotaFromCodexRateLimits", () => {
  it("used 100 → remainingPct 0 kept, with resetsAt from reset_at", () => {
    const status = quotaFromCodexRateLimits({
      profileRef: "codex",
      now: FIXED,
      rateLimits: { primary: { used_percent: 100, window_minutes: 300, reset_at: RESET } },
    })
    expect(status?.basis).toBe("provider")
    expect(status?.source).toBe("codex:rate_limits")
    expect(status?.asOf).toBe("2026-10-19T00:00:00.000Z")
    expect(status?.windows).toEqual([
      {
        id: "primary",
        remainingPct: 0,
        resetsAt: new Date(RESET * 1000).toISOString(),
      },
    ])
  })

  it("used 0 → remainingPct 100", () => {
    const status = quotaFromCodexRateLimits({
      profileRef: "codex",
      rateLimits: { primary: { used_percent: 0 } },
    })
    expect(status?.windows).toEqual([{ id: "primary", remainingPct: 100 }])
  })

  it("used 130 → clamped to 0 and kept", () => {
    const status = quotaFromCodexRateLimits({
      profileRef: "codex",
      rateLimits: { primary: { used_percent: 130 } },
    })
    expect(status?.windows).toEqual([{ id: "primary", remainingPct: 0 }])
  })

  it("missing secondary emits only the primary window", () => {
    const status = quotaFromCodexRateLimits({
      profileRef: "codex",
      rateLimits: { primary: { used_percent: 25 } },
    })
    expect(status?.windows.map((w) => w.id)).toEqual(["primary"])
  })

  it("both sides present emit two windows", () => {
    const status = quotaFromCodexRateLimits({
      profileRef: "codex",
      rateLimits: { primary: { used_percent: 20 }, secondary: { used_percent: 80 } },
    })
    expect(status?.windows).toEqual([
      { id: "primary", remainingPct: 80 },
      { id: "secondary", remainingPct: 20 },
    ])
  })

  it("drops a side whose used_percent is not a finite number", () => {
    const status = quotaFromCodexRateLimits({
      profileRef: "codex",
      rateLimits: {
        primary: { used_percent: "nope" },
        secondary: { used_percent: 40 },
      } as unknown as CodexRateLimits,
    })
    expect(status?.windows).toEqual([{ id: "secondary", remainingPct: 60 }])
  })

  it("a bad reset_at keeps the window without resetsAt", () => {
    const status = quotaFromCodexRateLimits({
      profileRef: "codex",
      rateLimits: { primary: { used_percent: 10, reset_at: Number.NaN } },
    })
    expect(status?.windows).toEqual([{ id: "primary", remainingPct: 90 }])
  })

  it("nothing usable → undefined", () => {
    expect(
      quotaFromCodexRateLimits({ profileRef: "codex", rateLimits: {} }),
    ).toBeUndefined()
  })

  it("credits unlimited → unlimited credits", () => {
    const status = quotaFromCodexRateLimits({
      profileRef: "codex",
      rateLimits: {},
      credits: { unlimited: true },
    })
    expect(status?.windows).toEqual([])
    expect(status?.credits).toEqual({ currency: "USD", unlimited: true })
  })

  it("credits balance 0 kept, no string coercion", () => {
    const status = quotaFromCodexRateLimits({
      profileRef: "codex",
      rateLimits: {},
      credits: { balance: 0 },
    })
    expect(status?.credits).toEqual({ currency: "USD", balanceUsd: 0 })

    const coerced = quotaFromCodexRateLimits({
      profileRef: "codex",
      rateLimits: {},
      credits: { balance: "5" } as unknown as { balance?: number },
    })
    expect(coerced).toBeUndefined()
  })
})
