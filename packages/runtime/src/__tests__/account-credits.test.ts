/**
 * Coverage for the account-credits reader module and its enrichment wrapper.
 *
 *  - `ProviderAccountCreditsReader`: OpenRouter + Moonshot happy/edge paths
 *    (cap-less → undefined, real 0 kept, non-2xx → undefined, malformed body →
 *    undefined, missing credential → no fetch, oauth-bearer → no fetch), and
 *    endpoint dispatch (unsupported endpoint → undefined, no fetch).
 *  - `enrichRollupWithAccountCredits`: DEFAULT-SAFE — with no matching profile
 *    it is byte-identical and fetches ZERO times; a throwing reader/resolver
 *    never rejects the enrichment; and the fetch it does issue is a GET against
 *    a *balance* URL (non-billable, no side effects), never a POST to an
 *    inference endpoint.
 */
import { describe, expect, it, vi } from "vitest"
import {
  ProviderAccountCreditsReader,
  type CreditReadableProfile,
  type CreditReadCtx,
} from "../account-credits.js"
import { enrichRollupWithAccountCredits } from "../usage-rollup-service.js"
import type { AuthProfile } from "@agentproto/auth"
import type { UsageRollup } from "../usage-rollup.js"

const FIXED_NOW = new Date("2026-07-24T00:00:00.000Z")

/** A `fetch` that returns the given JSON body + status and records every call's
 *  (url, method). Signature-compatible with the global `fetch`. */
function recordingFetch(
  body: unknown,
  status = 200,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = []
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), method: init?.method ?? "GET" })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
  return { fetchImpl: fn as unknown as typeof fetch, calls }
}

/** A `fetch` that must never be called — flips a flag and throws if it is. */
function neverFetch(): { fetchImpl: typeof fetch; called: () => boolean } {
  let hit = false
  const fn = async (): Promise<Response> => {
    hit = true
    throw new Error("fetch must not be called")
  }
  return { fetchImpl: fn as unknown as typeof fetch, called: () => hit }
}

function ctxWith(
  fetchImpl: typeof fetch,
  overrides?: Partial<CreditReadCtx>,
): CreditReadCtx {
  return {
    resolveCredential: async () => "secret-key",
    fetchImpl,
    now: () => FIXED_NOW,
    baseUrls: { openrouter: "https://or.test/api/v1", moonshot: "https://ms.test" },
    ...overrides,
  }
}

const OPENROUTER_PROFILE: CreditReadableProfile = {
  profileRef: "or",
  endpoint: "openrouter",
  method: "api-key",
  credentialRef: "cred/or",
}
const MOONSHOT_PROFILE: CreditReadableProfile = {
  profileRef: "ms",
  endpoint: "moonshot",
  method: "api-key",
  credentialRef: "cred/ms",
}

describe("ProviderAccountCreditsReader — OpenRouter", () => {
  const reader = new ProviderAccountCreditsReader()

  it("cap key → balanceUsd = limit_remaining", async () => {
    const { fetchImpl, calls } = recordingFetch({ data: { limit_remaining: 12.34 } })
    const out = await reader.readAccountCredits(OPENROUTER_PROFILE, ctxWith(fetchImpl))
    expect(out).toEqual({
      balanceUsd: 12.34,
      basis: "provider",
      source: "openrouter:/key",
      asOf: FIXED_NOW.toISOString(),
    })
    expect(calls[0]).toEqual({ url: "https://or.test/api/v1/key", method: "GET" })
  })

  it("cap-less key (limit_remaining: null) → undefined (never fabricated)", async () => {
    const { fetchImpl } = recordingFetch({ data: { limit_remaining: null } })
    expect(
      await reader.readAccountCredits(OPENROUTER_PROFILE, ctxWith(fetchImpl)),
    ).toBeUndefined()
  })

  it("absent limit_remaining → undefined", async () => {
    const { fetchImpl } = recordingFetch({ data: {} })
    expect(
      await reader.readAccountCredits(OPENROUTER_PROFILE, ctxWith(fetchImpl)),
    ).toBeUndefined()
  })

  it("non-2xx (401) → undefined", async () => {
    const { fetchImpl } = recordingFetch({ error: "unauthorized" }, 401)
    expect(
      await reader.readAccountCredits(OPENROUTER_PROFILE, ctxWith(fetchImpl)),
    ).toBeUndefined()
  })

  it("missing credentialRef → undefined and NO fetch", async () => {
    const { fetchImpl, called } = neverFetch()
    const noCred: CreditReadableProfile = { ...OPENROUTER_PROFILE, credentialRef: undefined }
    expect(await reader.readAccountCredits(noCred, ctxWith(fetchImpl))).toBeUndefined()
    expect(called()).toBe(false)
  })

  it("resolveCredential yields undefined → undefined and NO fetch", async () => {
    const { fetchImpl, called } = neverFetch()
    const ctx = ctxWith(fetchImpl, { resolveCredential: async () => undefined })
    expect(await reader.readAccountCredits(OPENROUTER_PROFILE, ctx)).toBeUndefined()
    expect(called()).toBe(false)
  })

  it("oauth-bearer method → undefined and NO fetch (balance takes the api key)", async () => {
    const { fetchImpl, called } = neverFetch()
    const oauth: CreditReadableProfile = { ...OPENROUTER_PROFILE, method: "oauth-bearer" }
    expect(await reader.readAccountCredits(oauth, ctxWith(fetchImpl))).toBeUndefined()
    expect(called()).toBe(false)
  })
})

describe("ProviderAccountCreditsReader — Moonshot", () => {
  const reader = new ProviderAccountCreditsReader()

  it("available_balance > 0 → mapped", async () => {
    const { fetchImpl, calls } = recordingFetch({
      code: 0,
      status: true,
      data: { available_balance: 8.5, voucher_balance: 0, cash_balance: 8.5 },
    })
    const out = await reader.readAccountCredits(MOONSHOT_PROFILE, ctxWith(fetchImpl))
    expect(out).toEqual({
      balanceUsd: 8.5,
      basis: "provider",
      source: "moonshot:/balance",
      asOf: FIXED_NOW.toISOString(),
    })
    expect(calls[0]).toEqual({
      url: "https://ms.test/v1/users/me/balance",
      method: "GET",
    })
  })

  it("available_balance = 0 → balanceUsd 0 (a real empty wallet, kept)", async () => {
    const { fetchImpl } = recordingFetch({
      data: { available_balance: 0, voucher_balance: 0, cash_balance: 0 },
    })
    const out = await reader.readAccountCredits(MOONSHOT_PROFILE, ctxWith(fetchImpl))
    expect(out?.balanceUsd).toBe(0)
    expect(out?.basis).toBe("provider")
  })

  it("non-2xx (401) → undefined", async () => {
    const { fetchImpl } = recordingFetch({ error: "unauthorized" }, 401)
    expect(
      await reader.readAccountCredits(MOONSHOT_PROFILE, ctxWith(fetchImpl)),
    ).toBeUndefined()
  })

  it("malformed body (no numeric available_balance) → undefined", async () => {
    const { fetchImpl } = recordingFetch({ data: { available_balance: "lots" } })
    expect(
      await reader.readAccountCredits(MOONSHOT_PROFILE, ctxWith(fetchImpl)),
    ).toBeUndefined()
  })
})

describe("ProviderAccountCreditsReader — endpoint dispatch", () => {
  const reader = new ProviderAccountCreditsReader()

  for (const endpoint of ["anthropic", "openai", "google", "xai"]) {
    it(`endpoint "${endpoint}" → undefined and NO fetch`, async () => {
      const { fetchImpl, called } = neverFetch()
      const profile: CreditReadableProfile = {
        profileRef: endpoint,
        endpoint,
        method: "api-key",
        credentialRef: "cred/x",
      }
      expect(await reader.readAccountCredits(profile, ctxWith(fetchImpl))).toBeUndefined()
      expect(called()).toBe(false)
    })
  }
})

function emptyBucket() {
  return { spentUsd: 0, tokensIn: 0, tokensOut: 0, unpricedTokens: 0 }
}

/** Minimal rollup carrying just the `byProfile` entries the enrichment reads. */
function rollupWithProfiles(profileRefs: string[]): UsageRollup {
  return {
    window: "5h",
    windowMs: 18_000_000,
    basis: "local-estimate",
    now: "2026-07-24T00:00:00.000Z",
    windowStart: "2026-07-23T19:00:00.000Z",
    total: emptyBucket(),
    byProfile: profileRefs.map(profileRef => ({ profileRef, ...emptyBucket() })),
    byModel: [],
    byHarness: [],
    sessionsConsidered: profileRefs.length,
  }
}

function profile(over: Partial<AuthProfile> & { id: string }): AuthProfile {
  return { endpoint: "openrouter", method: "api-key", ...over }
}

describe("enrichRollupWithAccountCredits — default-safe / non-fatal", () => {
  it("no matching provider profile → byte-identical rollup, ZERO fetches", async () => {
    const { fetchImpl, called } = neverFetch()
    const input = rollupWithProfiles(["anthro-max", "unknown"])
    const out = await enrichRollupWithAccountCredits(input, {
      // Anthropic profile has no balance endpoint → resolver returns it, reader
      // dispatches to undefined without fetching.
      loadProfiles: async () => [profile({ id: "anthro-max", endpoint: "anthropic" })],
      ctx: {
        resolveCredential: async () => "secret",
        fetchImpl,
      },
    })
    expect(out).toEqual(input)
    expect(called()).toBe(false)
  })

  it("attaches credits for a matching openrouter api-key profile", async () => {
    const { fetchImpl, calls } = recordingFetch({ data: { limit_remaining: 5 } })
    const out = await enrichRollupWithAccountCredits(rollupWithProfiles(["or-key"]), {
      loadProfiles: async () => [
        profile({ id: "or-key", endpoint: "openrouter", credentialRef: "cred/or" }),
      ],
      ctx: {
        resolveCredential: async () => "secret",
        fetchImpl,
        now: () => FIXED_NOW,
        baseUrls: { openrouter: "https://or.test/api/v1" },
      },
    })
    expect(out.byProfile[0]?.credits?.balanceUsd).toBe(5)
    // The read is a plain GET on the balance endpoint — no POST, no inference.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("GET")
    expect(calls[0]?.url).toBe("https://or.test/api/v1/key")
    expect(calls[0]?.url).not.toContain("chat")
    expect(calls[0]?.url).not.toContain("completions")
  })

  it("a throwing reader never rejects — original rollup returned", async () => {
    const input = rollupWithProfiles(["or-key"])
    const out = await enrichRollupWithAccountCredits(input, {
      reader: {
        readAccountCredits: async () => {
          throw new Error("boom")
        },
      },
      loadProfiles: async () => [profile({ id: "or-key", credentialRef: "cred/or" })],
      ctx: { resolveCredential: async () => "secret", fetchImpl: recordingFetch({}).fetchImpl },
    })
    expect(out.byProfile[0]?.credits).toBeUndefined()
    expect(out.byProfile[0]?.profileRef).toBe("or-key")
  })

  it("a throwing resolveCredential never rejects — credits omitted", async () => {
    const input = rollupWithProfiles(["or-key"])
    const out = await enrichRollupWithAccountCredits(input, {
      loadProfiles: async () => [profile({ id: "or-key", credentialRef: "cred/or" })],
      ctx: {
        resolveCredential: async () => {
          throw new Error("keychain locked")
        },
        fetchImpl: recordingFetch({ data: { limit_remaining: 5 } }).fetchImpl,
      },
    })
    expect(out.byProfile[0]?.credits).toBeUndefined()
  })

  it("a throwing loadProfiles never rejects — input rollup returned", async () => {
    const input = rollupWithProfiles(["or-key"])
    const out = await enrichRollupWithAccountCredits(input, {
      loadProfiles: async () => {
        throw new Error("profile store down")
      },
    })
    expect(out).toEqual(input)
  })

  it("skips the 'unknown' profileRef entirely (no resolve, no fetch)", async () => {
    const resolveSpy = vi.fn(async () => [] as AuthProfile[])
    const out = await enrichRollupWithAccountCredits(rollupWithProfiles(["unknown"]), {
      loadProfiles: resolveSpy,
      ctx: { resolveCredential: async () => "secret", fetchImpl: neverFetch().fetchImpl },
    })
    expect(out.byProfile[0]?.credits).toBeUndefined()
  })
})
