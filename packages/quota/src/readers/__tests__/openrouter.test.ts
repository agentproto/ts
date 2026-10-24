/**
 * Coverage for the OpenRouter key quota reader: capped key → window + credits,
 * real 0 kept, cap-less key → undefined, and every failure mode (non-2xx,
 * thrown fetch, invalid JSON, no credential) collapsing to undefined without
 * fetching when there is no resolvable secret.
 */
import { describe, expect, it } from "vitest"
import { createOpenRouterQuotaReader } from "../../index.js"
import type { QuotaProfile, QuotaReadContext } from "../../index.js"

const FIXED = new Date("2026-10-19T00:00:00.000Z")
const BASE = "https://or.test/api/v1"

const PROFILE: QuotaProfile = {
  profileRef: "or",
  endpoint: "openrouter",
  method: "api-key",
  credentialRef: "cred/or",
}

interface Call {
  url: string
  method: string
  authorization: string | undefined
}

function recordingFetch(
  body: unknown,
  status = 200,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? undefined,
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
  return { fetchImpl: fn as unknown as typeof fetch, calls }
}

function neverFetch(): { fetchImpl: typeof fetch; called: () => boolean } {
  let hit = false
  const fn = async (): Promise<Response> => {
    hit = true
    throw new Error("fetch must not be called")
  }
  return { fetchImpl: fn as unknown as typeof fetch, called: () => hit }
}

function ctxWith(fetchImpl: typeof fetch, overrides?: Partial<QuotaReadContext>): QuotaReadContext {
  return {
    resolveCredential: async () => "secret-key",
    fetchImpl,
    now: () => FIXED,
    ...overrides,
  }
}

const reader = createOpenRouterQuotaReader({ baseUrl: BASE })

describe("createOpenRouterQuotaReader", () => {
  it("supports only openrouter api-key profiles", () => {
    expect(reader.id).toBe("openrouter-key")
    expect(reader.supports(PROFILE)).toBe(true)
    expect(reader.supports({ ...PROFILE, endpoint: "anthropic" })).toBe(false)
    expect(reader.supports({ ...PROFILE, method: "oauth-bearer" })).toBe(false)
  })

  it("capped key with usage → window + credits", async () => {
    const { fetchImpl, calls } = recordingFetch({
      data: { limit: 10, limit_remaining: 4 },
    })
    const status = await reader.read(PROFILE, ctxWith(fetchImpl))
    expect(status?.basis).toBe("provider")
    expect(status?.source).toBe("openrouter:/key")
    expect(status?.asOf).toBe(FIXED.toISOString())
    expect(status?.windows).toEqual([
      { id: "key_limit", remainingPct: 40, remaining: 4, limit: 10, unit: "USD" },
    ])
    expect(status?.credits).toEqual({ balanceUsd: 4, currency: "USD" })
    expect(calls).toEqual([
      { url: `${BASE}/key`, method: "GET", authorization: "Bearer secret-key" },
    ])
  })

  it("keeps a real 0 remaining", async () => {
    const { fetchImpl } = recordingFetch({ data: { limit: 10, limit_remaining: 0 } })
    const status = await reader.read(PROFILE, ctxWith(fetchImpl))
    expect(status?.windows[0]?.remainingPct).toBe(0)
    expect(status?.credits).toEqual({ balanceUsd: 0, currency: "USD" })
  })

  it("cap-less key (limit_remaining null) → undefined", async () => {
    const { fetchImpl } = recordingFetch({ data: { limit: null, limit_remaining: null } })
    expect(await reader.read(PROFILE, ctxWith(fetchImpl))).toBeUndefined()
  })

  it("non-2xx → undefined", async () => {
    const { fetchImpl } = recordingFetch({ error: "unauthorized" }, 401)
    expect(await reader.read(PROFILE, ctxWith(fetchImpl))).toBeUndefined()
  })

  it("a throwing fetch → undefined", async () => {
    const throwing = async (): Promise<Response> => {
      throw new Error("network down")
    }
    expect(
      await reader.read(PROFILE, ctxWith(throwing as unknown as typeof fetch)),
    ).toBeUndefined()
  })

  it("invalid JSON → undefined", async () => {
    const notJson = async (): Promise<Response> =>
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })
    expect(
      await reader.read(PROFILE, ctxWith(notJson as unknown as typeof fetch)),
    ).toBeUndefined()
  })

  it("no credentialRef → undefined and no fetch", async () => {
    const { fetchImpl, called } = neverFetch()
    const status = await reader.read({ ...PROFILE, credentialRef: undefined }, ctxWith(fetchImpl))
    expect(status).toBeUndefined()
    expect(called()).toBe(false)
  })

  it("no resolver → undefined and no fetch", async () => {
    const { fetchImpl, called } = neverFetch()
    const status = await reader.read(PROFILE, { fetchImpl, now: () => FIXED })
    expect(status).toBeUndefined()
    expect(called()).toBe(false)
  })
})
