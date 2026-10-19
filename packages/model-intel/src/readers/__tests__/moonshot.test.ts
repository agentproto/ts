/**
 * Coverage for the Moonshot balance reader: a positive balance, a real 0 kept,
 * a negative balance kept as is, and every failure mode (non-2xx, thrown fetch,
 * invalid JSON, missing field, no credential) collapsing to undefined without
 * fetching when there is no resolvable secret.
 */
import { describe, expect, it } from "vitest"
import { createMoonshotQuotaReader } from "../../index.js"
import type { QuotaProfile, QuotaReadContext } from "../../index.js"

const FIXED = new Date("2026-10-19T00:00:00.000Z")
const BASE = "https://moonshot.test"

const PROFILE: QuotaProfile = {
  profileRef: "moonshot",
  endpoint: "moonshot",
  method: "api-key",
  credentialRef: "cred/moonshot",
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

const reader = createMoonshotQuotaReader({ baseUrl: BASE })

describe("createMoonshotQuotaReader", () => {
  it("supports only moonshot api-key profiles", () => {
    expect(reader.id).toBe("moonshot-balance")
    expect(reader.supports(PROFILE)).toBe(true)
    expect(reader.supports({ ...PROFILE, endpoint: "openrouter" })).toBe(false)
    expect(reader.supports({ ...PROFILE, method: "oauth-bearer" })).toBe(false)
  })

  it("a positive balance → credits, no window", async () => {
    const { fetchImpl, calls } = recordingFetch({ data: { available_balance: 12.5 } })
    const status = await reader.read(PROFILE, ctxWith(fetchImpl))
    expect(status?.basis).toBe("provider")
    expect(status?.source).toBe("moonshot:/users/me/balance")
    expect(status?.asOf).toBe(FIXED.toISOString())
    expect(status?.windows).toEqual([])
    expect(status?.credits).toEqual({ balanceUsd: 12.5, currency: "USD" })
    expect(calls).toEqual([
      { url: `${BASE}/v1/users/me/balance`, method: "GET", authorization: "Bearer secret-key" },
    ])
  })

  it("keeps a real 0 balance", async () => {
    const { fetchImpl } = recordingFetch({ data: { available_balance: 0 } })
    const status = await reader.read(PROFILE, ctxWith(fetchImpl))
    expect(status?.credits).toEqual({ balanceUsd: 0, currency: "USD" })
  })

  it("keeps a negative balance as is", async () => {
    const { fetchImpl } = recordingFetch({ data: { available_balance: -3.25 } })
    const status = await reader.read(PROFILE, ctxWith(fetchImpl))
    expect(status?.credits).toEqual({ balanceUsd: -3.25, currency: "USD" })
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

  it("missing balance field → undefined", async () => {
    const { fetchImpl } = recordingFetch({ data: {} })
    expect(await reader.read(PROFILE, ctxWith(fetchImpl))).toBeUndefined()
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
