import { describe, expect, it } from "vitest"
import type { QuotaProfile, QuotaReadFailure } from "../../types.js"
import {
  createAnthropicOAuthQuotaReader,
  quotaFromAnthropicUnifiedUtilization,
} from "../anthropic-oauth.js"

const NOW = () => new Date("2026-11-13T12:00:00.000Z")

/** Headers copied from a real 200 reply to a one-token Messages call made with
 *  a subscription OAuth token (2026-11-13). Only the 7d window was present:
 *  no 5h header was sent at that moment. */
const REAL_HEADERS: Record<string, string> = {
  "anthropic-ratelimit-unified-7d-reset": "1794628800",
  "anthropic-ratelimit-unified-7d-status": "allowed_warning",
  "anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
  "anthropic-ratelimit-unified-7d-utilization": "0.94",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-reset": "1794628800",
  "anthropic-ratelimit-unified-status": "allowed_warning",
  "anthropic-ratelimit-unified-upgrade-paths": "overage",
}

const PROFILE: QuotaProfile = {
  profileRef: "sub-a",
  endpoint: "anthropic",
  method: "oauth-bearer",
  credentialRef: "agentproto.auth.anthropic.sub",
}

const SECRET = "sk-ant-oat01-SECRET-VALUE-NEVER-PRINTED"

function reply(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response("{}", { status, headers })) as unknown as typeof fetch
}

async function run(fetchImpl: typeof fetch, resolve: (ref: string) => Promise<string | undefined> = async () => SECRET) {
  const failures: QuotaReadFailure[] = []
  const status = await createAnthropicOAuthQuotaReader().read(PROFILE, {
    fetchImpl,
    resolveCredential: resolve,
    now: NOW,
    reportFailure: (f) => failures.push(f),
  })
  return { status, failures }
}

describe("quotaFromAnthropicUnifiedUtilization", () => {
  it("turns the real 7d utilization into remainingPct and resetsAt, with no 5h window invented", () => {
    const status = quotaFromAnthropicUnifiedUtilization({
      profileRef: "sub-a",
      headers: REAL_HEADERS,
      now: NOW,
    })
    expect(status).toEqual({
      profileRef: "sub-a",
      asOf: "2026-11-13T12:00:00.000Z",
      basis: "probe",
      source: "anthropic:oauth-unified-headers",
      windows: [{ id: "7d", remainingPct: 6, resetsAt: "2026-11-14T04:00:00.000Z" }],
    })
  })

  it("emits both windows, and any per-model id, when the provider sends them", () => {
    const status = quotaFromAnthropicUnifiedUtilization({
      profileRef: "sub-a",
      headers: new Headers({
        ...REAL_HEADERS,
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": "1794600000",
        "anthropic-ratelimit-unified-7d_sonnet-utilization": "0.1",
      }),
      now: NOW,
    })
    expect(status?.windows.map((w) => [w.id, w.remainingPct, w.resetsAt !== undefined])).toEqual([
      ["5h", 75, true],
      ["7d", 6, true],
      ["7d_sonnet", 90, false],
    ])
  })

  it("omits a window with garbage utilization instead of zero-filling it", () => {
    expect(
      quotaFromAnthropicUnifiedUtilization({
        profileRef: "sub-a",
        headers: { "anthropic-ratelimit-unified-5h-utilization": "lots" },
      }),
    ).toBeUndefined()
  })
})

describe("createAnthropicOAuthQuotaReader", () => {
  it("serves anthropic / oauth-bearer only", () => {
    const reader = createAnthropicOAuthQuotaReader()
    expect(reader.supports(PROFILE)).toBe(true)
    expect(reader.supports({ ...PROFILE, method: "api-key" })).toBe(false)
    expect(reader.supports({ ...PROFILE, endpoint: "moonshot" })).toBe(false)
  })

  it("reads a status from a real-shaped reply and sends the token only as a bearer", async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const { status, failures } = await run((async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response("{}", { status: 200, headers: REAL_HEADERS })
    }) as unknown as typeof fetch)
    expect(failures).toEqual([])
    expect(status?.windows).toEqual([{ id: "7d", remainingPct: 6, resetsAt: "2026-11-14T04:00:00.000Z" }])
    expect(seen?.url).toBe("https://api.anthropic.com/v1/messages")
    expect((seen?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
  })

  it("uses the headers of a 429 when they carry utilization", async () => {
    const { status } = await run(reply(429, REAL_HEADERS))
    expect(status?.windows[0]?.id).toBe("7d")
  })

  it("reports credential_missing by key name, never the value", async () => {
    const { status, failures } = await run(reply(200), async () => undefined)
    expect(status).toBeUndefined()
    expect(failures[0]?.code).toBe("credential_missing")
    expect(failures[0]?.message).toContain("agentproto.auth.anthropic.sub")
  })

  it("reports credential_rejected on 401 without echoing the token", async () => {
    const { status, failures } = await run(reply(401))
    expect(status).toBeUndefined()
    expect(failures[0]?.code).toBe("credential_rejected")
    expect(JSON.stringify(failures)).not.toContain(SECRET)
  })

  it("reports rate_limited on a 429 with no usage headers", async () => {
    expect((await run(reply(429))).failures[0]?.code).toBe("rate_limited")
  })

  it("reports provider_unreachable on a network error", async () => {
    const boom = (async () => {
      throw new TypeError(`connect failed for ${SECRET}`)
    }) as unknown as typeof fetch
    const { status, failures } = await run(boom)
    expect(status).toBeUndefined()
    expect(failures[0]?.code).toBe("provider_unreachable")
    expect(JSON.stringify(failures)).not.toContain(SECRET)
  })

  it("reports no_usable_figures on a 200 without utilization headers", async () => {
    expect((await run(reply(200))).failures[0]?.code).toBe("no_usable_figures")
  })
})
