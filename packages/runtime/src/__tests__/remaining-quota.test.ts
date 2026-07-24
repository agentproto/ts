/**
 * Coverage for the remaining-quota reader module — split into its two layers:
 *
 *  - PURE `parseAnthropicRateLimitHeaders`: both windows, one missing, unix vs
 *    ISO reset, garbage remaining omitted, empty headers → {}.
 *  - IMPURE `AnthropicRemainingQuotaReader` with an injected fake fetch +
 *    temp store: happy path, non-anthropic → undefined, fetch throws/times out
 *    → store fallback, and it NEVER throws.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  AnthropicRemainingQuotaReader,
  parseAnthropicRateLimitHeaders,
  type QuotaReadableProfile,
} from "../remaining-quota.js"
import { readProfileQuota, recordProfileQuota } from "../remaining-quota-store.js"

const OAUTH_PROFILE: QuotaReadableProfile = {
  profileRef: "max",
  endpoint: "anthropic",
  method: "oauth-bearer",
  source: "claude-code-oauth",
}

/** Build a fake `fetch` that returns a response carrying the given headers.
 *  Signature-compatible with the global `fetch` so it drops into the
 *  reader's `fetchImpl`. */
function fetchWithHeaders(headers: Record<string, string>): typeof fetch {
  const fn = async (): Promise<Response> =>
    new Response(null, { status: 200, headers })
  return fn as unknown as typeof fetch
}

function throwingFetch(): typeof fetch {
  const fn = async (): Promise<Response> => {
    throw new Error("network down")
  }
  return fn as unknown as typeof fetch
}

describe("parseAnthropicRateLimitHeaders", () => {
  it("parses both windows (unix-seconds reset → ISO)", () => {
    // 1_753_336_800 = 2025-07-24T06:00:00Z
    const out = parseAnthropicRateLimitHeaders({
      "anthropic-ratelimit-unified-5h-remaining": "42",
      "anthropic-ratelimit-unified-5h-reset": "1753336800",
      "anthropic-ratelimit-unified-7d-remaining": "900",
      "anthropic-ratelimit-unified-7d-reset": "1753336800",
    })
    expect(out["5h"]).toEqual({
      window: "5h",
      remaining: 42,
      resetsAt: "2025-07-24T06:00:00.000Z",
      basis: "provider",
    })
    expect(out["7d"]?.remaining).toBe(900)
  })

  it("accepts an ISO reset header verbatim", () => {
    const out = parseAnthropicRateLimitHeaders({
      "anthropic-ratelimit-unified-5h-remaining": "7",
      "anthropic-ratelimit-unified-5h-reset": "2026-07-24T05:00:00Z",
    })
    expect(out["5h"]?.resetsAt).toBe("2026-07-24T05:00:00.000Z")
  })

  it("reads from a Headers object case-insensitively", () => {
    const headers = new Headers({
      "Anthropic-RateLimit-Unified-5h-Remaining": "3",
      "Anthropic-RateLimit-Unified-5h-Reset": "1753336800",
    })
    expect(parseAnthropicRateLimitHeaders(headers)["5h"]?.remaining).toBe(3)
  })

  it("omits a window whose remaining is missing", () => {
    const out = parseAnthropicRateLimitHeaders({
      "anthropic-ratelimit-unified-7d-remaining": "5",
      "anthropic-ratelimit-unified-7d-reset": "1753336800",
    })
    expect(out["5h"]).toBeUndefined()
    expect(out["7d"]?.remaining).toBe(5)
  })

  it("omits a window whose remaining is garbage (never fabricated)", () => {
    const out = parseAnthropicRateLimitHeaders({
      "anthropic-ratelimit-unified-5h-remaining": "not-a-number",
      "anthropic-ratelimit-unified-5h-reset": "1753336800",
    })
    expect(out["5h"]).toBeUndefined()
  })

  it("omits a window whose reset is unparseable", () => {
    const out = parseAnthropicRateLimitHeaders({
      "anthropic-ratelimit-unified-5h-remaining": "10",
      "anthropic-ratelimit-unified-5h-reset": "soon-ish",
    })
    expect(out["5h"]).toBeUndefined()
  })

  it("empty headers → {}", () => {
    expect(parseAnthropicRateLimitHeaders({})).toEqual({})
    expect(parseAnthropicRateLimitHeaders(new Headers())).toEqual({})
  })
})

describe("AnthropicRemainingQuotaReader", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quota-reader-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("happy path: live fetch returns the requested window and persists it", async () => {
    const reader = new AnthropicRemainingQuotaReader({
      liveProbe: true,
      fetchImpl: fetchWithHeaders({
        "anthropic-ratelimit-unified-5h-remaining": "50",
        "anthropic-ratelimit-unified-5h-reset": "1753336800",
        "anthropic-ratelimit-unified-7d-remaining": "800",
        "anthropic-ratelimit-unified-7d-reset": "1753336800",
      }),
      resolveToken: async () => "fake-bearer",
      store: { dir },
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    })
    const out = await reader.readRemainingQuota(OAUTH_PROFILE, "5h")
    expect(out?.remaining).toBe(50)
    // persisted both windows for the fallback path
    const stored = await readProfileQuota("max", { dir })
    expect(stored?.windows["7d"]?.remaining).toBe(800)
    expect(stored?.fetchedAt).toBe("2026-07-24T00:00:00.000Z")
  })

  it("non-anthropic endpoint → undefined (no fetch)", async () => {
    let fetched = false
    const spyFetch = async (): Promise<Response> => {
      fetched = true
      return new Response(null, { status: 200 })
    }
    const reader = new AnthropicRemainingQuotaReader({
      liveProbe: true,
      fetchImpl: spyFetch as unknown as typeof fetch,
      resolveToken: async () => "fake-bearer",
      store: { dir },
    })
    const gemini: QuotaReadableProfile = {
      profileRef: "g",
      endpoint: "gemini",
      method: "oauth-bearer",
      source: "claude-code-oauth",
    }
    expect(await reader.readRemainingQuota(gemini, "5h")).toBeUndefined()
    expect(fetched).toBe(false)
  })

  it("fetch throws → falls back to the stored last-seen value", async () => {
    await recordProfileQuota(
      {
        profileRef: "max",
        windows: {
          "5h": { window: "5h", remaining: 11, resetsAt: "2026-07-24T05:00:00.000Z", basis: "provider" },
        },
        fetchedAt: "2026-07-23T00:00:00.000Z",
      },
      { dir },
    )
    const reader = new AnthropicRemainingQuotaReader({
      liveProbe: true,
      fetchImpl: throwingFetch(),
      resolveToken: async () => "fake-bearer",
      store: { dir },
    })
    const out = await reader.readRemainingQuota(OAUTH_PROFILE, "5h")
    expect(out?.remaining).toBe(11)
  })

  it("fetch throws with no stored value → undefined (never throws)", async () => {
    const reader = new AnthropicRemainingQuotaReader({
      liveProbe: true,
      fetchImpl: throwingFetch(),
      resolveToken: async () => "fake-bearer",
      store: { dir },
    })
    await expect(reader.readRemainingQuota(OAUTH_PROFILE, "7d")).resolves.toBeUndefined()
  })

  it("token resolution failure → no live fetch, store fallback (never throws)", async () => {
    const reader = new AnthropicRemainingQuotaReader({
      liveProbe: true,
      fetchImpl: fetchWithHeaders({
        "anthropic-ratelimit-unified-5h-remaining": "99",
        "anthropic-ratelimit-unified-5h-reset": "1753336800",
      }),
      resolveToken: async () => {
        throw new Error("not logged in")
      },
      store: { dir },
    })
    // No token ⇒ no live probe ⇒ nothing stored ⇒ undefined, and no throw.
    await expect(reader.readRemainingQuota(OAUTH_PROFILE, "5h")).resolves.toBeUndefined()
  })

  it("default (probe off): NO network call — reports only the stored last-seen", async () => {
    // Seed a last-seen value; the default reader must return it WITHOUT fetching.
    await recordProfileQuota(
      {
        profileRef: "max",
        windows: {
          "5h": { window: "5h", remaining: 7, resetsAt: "2026-07-24T05:00:00.000Z", basis: "provider" },
        },
        fetchedAt: "2026-07-23T00:00:00.000Z",
      },
      { dir },
    )
    let fetched = false
    const spyFetch = async (): Promise<Response> => {
      fetched = true
      return new Response(null, { status: 200 })
    }
    // No `liveProbe` ⇒ side-effect-free: store-only, never touches the network.
    const reader = new AnthropicRemainingQuotaReader({
      fetchImpl: spyFetch as unknown as typeof fetch,
      resolveToken: async () => "fake-bearer",
      store: { dir },
    })
    const out = await reader.readRemainingQuota(OAUTH_PROFILE, "5h")
    expect(out?.remaining).toBe(7)
    expect(fetched).toBe(false)
  })

  it("default (probe off) with no stored value → undefined, no network call", async () => {
    let fetched = false
    const spyFetch = async (): Promise<Response> => {
      fetched = true
      return new Response(null, { status: 200 })
    }
    const reader = new AnthropicRemainingQuotaReader({
      fetchImpl: spyFetch as unknown as typeof fetch,
      resolveToken: async () => "fake-bearer",
      store: { dir },
    })
    expect(await reader.readRemainingQuota(OAUTH_PROFILE, "5h")).toBeUndefined()
    expect(fetched).toBe(false)
  })
})
