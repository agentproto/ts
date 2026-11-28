/**
 * Codex usage reader: GET <chatgpt backend>/wham/usage with the profile's
 * bearer and workspace header. The response shape is NOT documented, so the
 * parser is defensive and every negative path is covered: 200, 401/403, 429,
 * unexpected body, unreachable, missing login. No real token is ever used.
 */
import { describe, expect, it } from "vitest"
import type { QuotaProfile, QuotaReadFailure } from "../../types.js"
import { createCodexQuotaReader, quotaFromCodexUsagePayload } from "../codex-usage.js"
import { quotaFromCodexRateLimits } from "../codex.js"

const NOW = () => new Date("2026-11-28T12:00:00.000Z")
const SECRET = "FAKE-ACCESS-TOKEN-NEVER-PRINTED"

const PROFILE: QuotaProfile = {
  profileRef: "codex-solo",
  endpoint: "openai",
  method: "oauth-bearer",
  source: "codex",
  codexHome: "/tmp/fake-home",
  workspaceId: "acct-solo",
}

const BODY = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: 600, reset_at: 1_795_000_000 },
    secondary_window: { used_percent: 62.5, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: 1_795_500_000 },
  },
}

function json(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

async function run(opts: {
  fetchImpl: typeof fetch
  login?: { accessToken: string; accountId?: string } | undefined
  profile?: QuotaProfile
}) {
  const failures: QuotaReadFailure[] = []
  const status = await createCodexQuotaReader({
    readLogin: async () => ("login" in opts ? opts.login : { accessToken: SECRET, accountId: "acct-solo" }),
  }).read(opts.profile ?? PROFILE, { fetchImpl: opts.fetchImpl, now: NOW, reportFailure: f => failures.push(f) })
  return { status, failures }
}

describe("quotaFromCodexRateLimits (extended)", () => {
  it("labels windows by their length: 18000 s = 5h, 604800 s = 7d", () => {
    const s = quotaFromCodexRateLimits({
      profileRef: "p",
      now: NOW,
      basis: "probe",
      source: "codex:wham-usage",
      rateLimits: {
        primary: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1_795_000_000 },
        secondary: { used_percent: 62.5, limit_window_seconds: 604800, reset_after_seconds: 3600 },
      },
    })
    expect(s?.basis).toBe("probe")
    expect(s?.source).toBe("codex:wham-usage")
    expect(s?.windows.map(w => [w.id, w.remainingPct])).toEqual([["5h", 70], ["7d", 37.5]])
    expect(s?.windows[1]?.resetsAt).toBe("2026-11-28T13:00:00.000Z")
  })
})

describe("quotaFromCodexUsagePayload", () => {
  it("reads rate_limit.primary_window / secondary_window", () => {
    const s = quotaFromCodexUsagePayload({ profileRef: "p", body: BODY, now: NOW })
    expect(s?.windows.map(w => w.id)).toEqual(["5h", "7d"])
    expect(s?.windows[0]?.resetsAt).toBe(new Date(1_795_000_000 * 1000).toISOString())
  })
  it("also accepts the windows at the top level", () => {
    const s = quotaFromCodexUsagePayload({ profileRef: "p", body: BODY.rate_limit, now: NOW })
    expect(s?.windows).toHaveLength(2)
  })
  it("returns undefined for an unexpected body", () => {
    expect(quotaFromCodexUsagePayload({ profileRef: "p", body: { hello: "world" }, now: NOW })).toBeUndefined()
    expect(quotaFromCodexUsagePayload({ profileRef: "p", body: null, now: NOW })).toBeUndefined()
    expect(quotaFromCodexUsagePayload({ profileRef: "p", body: "x", now: NOW })).toBeUndefined()
  })
})

describe("createCodexQuotaReader", () => {
  it("supports only openai + oauth-bearer + source codex", () => {
    const r = createCodexQuotaReader({ readLogin: async () => undefined })
    expect(r.supports(PROFILE)).toBe(true)
    expect(r.supports({ ...PROFILE, source: undefined })).toBe(false)
    expect(r.supports({ ...PROFILE, source: "claude-code-oauth" })).toBe(false)
    expect(r.supports({ ...PROFILE, endpoint: "anthropic" })).toBe(false)
    expect(r.supports({ ...PROFILE, method: "api-key" })).toBe(false)
  })

  it("200: sends the bearer and the workspace header, returns a probe status", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> }
      return new Response(JSON.stringify(BODY), { status: 200 })
    }) as unknown as typeof fetch
    const { status, failures } = await run({ fetchImpl })
    expect(seen?.url).toBe("https://chatgpt.com/backend-api/wham/usage")
    expect(seen?.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(seen?.headers["ChatGPT-Account-Id"]).toBe("acct-solo")
    expect(status?.basis).toBe("probe")
    expect(status?.windows.map(w => w.id)).toEqual(["5h", "7d"])
    expect(failures).toEqual([])
  })

  it("uses the profile's pinned workspace over the login's, and the login's when unpinned", async () => {
    const ids: string[] = []
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      ids.push((init.headers as Record<string, string>)["ChatGPT-Account-Id"] ?? "")
      return new Response(JSON.stringify(BODY), { status: 200 })
    }) as unknown as typeof fetch
    await run({ fetchImpl, login: { accessToken: SECRET, accountId: "acct-other" } })
    await run({ fetchImpl, login: { accessToken: SECRET, accountId: "acct-other" }, profile: { ...PROFILE, workspaceId: undefined } })
    expect(ids).toEqual(["acct-solo", "acct-other"])
  })

  it("401/403: credential_rejected, never the token", async () => {
    const { status, failures } = await run({ fetchImpl: json(401, {}) })
    expect(status).toBeUndefined()
    expect(failures[0]?.code).toBe("credential_rejected")
    expect(JSON.stringify(failures)).not.toContain(SECRET)
  })

  it("429: rate_limited", async () => {
    const { failures } = await run({ fetchImpl: json(429, {}) })
    expect(failures[0]?.code).toBe("rate_limited")
  })

  it("500: provider_unreachable", async () => {
    const { failures } = await run({ fetchImpl: json(500, {}) })
    expect(failures[0]?.code).toBe("provider_unreachable")
  })

  it("unexpected body: no_usable_figures", async () => {
    const { status, failures } = await run({ fetchImpl: json(200, { hello: "world" }) })
    expect(status).toBeUndefined()
    expect(failures[0]?.code).toBe("no_usable_figures")
  })

  it("non-JSON body: no_usable_figures", async () => {
    const fetchImpl = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch
    const { failures } = await run({ fetchImpl })
    expect(failures[0]?.code).toBe("no_usable_figures")
  })

  it("network error: provider_unreachable, never throws", async () => {
    const fetchImpl = (async () => {
      throw new Error(`boom ${SECRET}`)
    }) as unknown as typeof fetch
    const { status, failures } = await run({ fetchImpl })
    expect(status).toBeUndefined()
    expect(failures[0]?.code).toBe("provider_unreachable")
    expect(JSON.stringify(failures)).not.toContain(SECRET)
  })

  it("missing login file: credential_missing, and fetch is never called", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response("{}")
    }) as unknown as typeof fetch
    const { status, failures } = await run({ fetchImpl, login: undefined })
    expect(status).toBeUndefined()
    expect(failures[0]?.code).toBe("credential_missing")
    expect(called).toBe(false)
  })

  it("a throwing readLogin resolves undefined with credential_missing", async () => {
    const failures: QuotaReadFailure[] = []
    const r = createCodexQuotaReader({
      readLogin: async () => {
        throw new Error("disk")
      },
    })
    expect(await r.read(PROFILE, { reportFailure: f => failures.push(f) })).toBeUndefined()
    expect(failures[0]?.code).toBe("credential_missing")
  })
})
