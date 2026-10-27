/**
 * Coverage for the pure Anthropic documented rate-limit header parser:
 * one window per dimension present, mixed-case / Headers input, skipped
 * dimensions, ignored undocumented unified-* headers, unparseable reset, and
 * the nothing-usable → undefined path.
 */
import { describe, expect, it } from "vitest"
import {
  parseAnthropicUnifiedRateLimitHeaders,
  quotaFromAnthropicHeaders,
  quotaStatusSchema,
} from "../../index.js"

const FIXED = () => new Date("2026-10-19T00:00:00.000Z")

describe("quotaFromAnthropicHeaders", () => {
  it("emits one window per documented dimension", () => {
    const status = quotaFromAnthropicHeaders({
      profileRef: "p1",
      now: FIXED,
      headers: {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "40",
        "anthropic-ratelimit-requests-reset": "2026-10-19T01:00:00.000Z",
        "anthropic-ratelimit-tokens-limit": "1000",
        "anthropic-ratelimit-tokens-remaining": "250",
        "anthropic-ratelimit-tokens-reset": "2026-10-19T02:00:00Z",
        "anthropic-ratelimit-input-tokens-limit": "500",
        "anthropic-ratelimit-input-tokens-remaining": "100",
        "anthropic-ratelimit-input-tokens-reset": "2026-10-19T03:00:00.000Z",
        "anthropic-ratelimit-output-tokens-limit": "200",
        "anthropic-ratelimit-output-tokens-remaining": "50",
        "anthropic-ratelimit-output-tokens-reset": "2026-10-19T04:00:00.000Z",
      },
    })
    expect(status?.basis).toBe("provider")
    expect(status?.source).toBe("anthropic:ratelimit-headers")
    expect(status?.asOf).toBe("2026-10-19T00:00:00.000Z")
    expect(status?.windows).toEqual([
      {
        id: "requests-1m",
        remainingPct: 40,
        limit: 100,
        remaining: 40,
        unit: "requests",
        resetsAt: "2026-10-19T01:00:00.000Z",
      },
      {
        id: "tokens-1m",
        remainingPct: 25,
        limit: 1000,
        remaining: 250,
        unit: "tokens",
        resetsAt: "2026-10-19T02:00:00.000Z",
      },
      {
        id: "input-tokens-1m",
        remainingPct: 20,
        limit: 500,
        remaining: 100,
        unit: "tokens",
        resetsAt: "2026-10-19T03:00:00.000Z",
      },
      {
        id: "output-tokens-1m",
        remainingPct: 25,
        limit: 200,
        remaining: 50,
        unit: "tokens",
        resetsAt: "2026-10-19T04:00:00.000Z",
      },
    ])
    expect(quotaStatusSchema.safeParse(status).success).toBe(true)
  })

  it("keeps only requests when only requests is present", () => {
    const status = quotaFromAnthropicHeaders({
      profileRef: "p1",
      now: FIXED,
      headers: {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "40",
      },
    })
    expect(status?.windows.map((w) => w.id)).toEqual(["requests-1m"])
    expect(status?.windows[0]?.resetsAt).toBeUndefined()
  })

  it("skips a dimension with a missing remaining", () => {
    const status = quotaFromAnthropicHeaders({
      profileRef: "p1",
      now: FIXED,
      headers: {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-tokens-limit": "1000",
        "anthropic-ratelimit-tokens-remaining": "250",
      },
    })
    expect(status?.windows.map((w) => w.id)).toEqual(["tokens-1m"])
  })

  it("skips a dimension with a non-numeric limit", () => {
    const status = quotaFromAnthropicHeaders({
      profileRef: "p1",
      now: FIXED,
      headers: {
        "anthropic-ratelimit-requests-limit": "lots",
        "anthropic-ratelimit-requests-remaining": "40",
        "anthropic-ratelimit-tokens-limit": "1000",
        "anthropic-ratelimit-tokens-remaining": "250",
      },
    })
    expect(status?.windows.map((w) => w.id)).toEqual(["tokens-1m"])
  })

  it("reads mixed-case header names case-insensitively", () => {
    const status = quotaFromAnthropicHeaders({
      profileRef: "p1",
      now: FIXED,
      headers: {
        "Anthropic-RateLimit-Requests-Limit": "100",
        "anthropic-RATELIMIT-requests-Remaining": "40",
      },
    })
    expect(status?.windows).toHaveLength(1)
    expect(status?.windows[0]?.id).toBe("requests-1m")
  })

  it("accepts a Headers object", () => {
    const status = quotaFromAnthropicHeaders({
      profileRef: "p1",
      now: FIXED,
      headers: new Headers({
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "40",
      }),
    })
    expect(status?.windows[0]?.id).toBe("requests-1m")
  })

  it("ignores undocumented unified-* headers", () => {
    const status = quotaFromAnthropicHeaders({
      profileRef: "p1",
      now: FIXED,
      headers: {
        "anthropic-ratelimit-unified-5h-limit": "100",
        "anthropic-ratelimit-unified-5h-remaining": "40",
        "anthropic-ratelimit-unified-5h-reset": "2026-10-19T01:00:00.000Z",
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "40",
      },
    })
    expect(status?.windows.map((w) => w.id)).toEqual(["requests-1m"])
  })

  it("keeps a window without resetsAt when the reset date is invalid", () => {
    const status = quotaFromAnthropicHeaders({
      profileRef: "p1",
      now: FIXED,
      headers: {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "40",
        "anthropic-ratelimit-requests-reset": "not-a-date",
      },
    })
    expect(status?.windows).toHaveLength(1)
    expect(status?.windows[0]?.resetsAt).toBeUndefined()
  })

  it("returns undefined when nothing is usable", () => {
    expect(
      quotaFromAnthropicHeaders({ profileRef: "p1", now: FIXED, headers: {} }),
    ).toBeUndefined()
    expect(
      quotaFromAnthropicHeaders({
        profileRef: "p1",
        now: FIXED,
        headers: { "anthropic-ratelimit-requests-remaining": "40" },
      }),
    ).toBeUndefined()
  })
})

describe("parseAnthropicUnifiedRateLimitHeaders", () => {
  it("parses the 5h and 7d windows from unix-second resets", () => {
    expect(
      parseAnthropicUnifiedRateLimitHeaders({
        "anthropic-ratelimit-unified-5h-remaining": "42",
        "anthropic-ratelimit-unified-5h-reset": "1753336800",
        "anthropic-ratelimit-unified-7d-remaining": "900",
        "anthropic-ratelimit-unified-7d-reset": "1753336800",
      }),
    ).toEqual({
      "5h": {
        window: "5h",
        remaining: 42,
        resetsAt: "2025-07-24T06:00:00.000Z",
        basis: "provider",
      },
      "7d": {
        window: "7d",
        remaining: 900,
        resetsAt: "2025-07-24T06:00:00.000Z",
        basis: "provider",
      },
    })
  })

  it("accepts ISO resets and Headers input case-insensitively", () => {
    const headers = new Headers({
      "Anthropic-RateLimit-Unified-5h-Remaining": "7",
      "Anthropic-RateLimit-Unified-5h-Reset": "2026-07-24T05:00:00Z",
    })
    expect(parseAnthropicUnifiedRateLimitHeaders(headers)["5h"]).toEqual({
      window: "5h",
      remaining: 7,
      resetsAt: "2026-07-24T05:00:00.000Z",
      basis: "provider",
    })
  })

  it("omits windows with a garbage remaining or unparseable reset", () => {
    expect(
      parseAnthropicUnifiedRateLimitHeaders({
        "anthropic-ratelimit-unified-5h-remaining": "soon",
        "anthropic-ratelimit-unified-5h-reset": "1753336800",
        "anthropic-ratelimit-unified-7d-remaining": "10",
        "anthropic-ratelimit-unified-7d-reset": "eventually",
      }),
    ).toEqual({})
  })
})
