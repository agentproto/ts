/**
 * Unit coverage for `readQuotaStatus` — the transport-free core of the
 * `quota_status` MCP tool (AIP-67). Exercises profile resolution + registry
 * dispatch with injected deps; no MCP transport, no real keychain/network.
 */

import { describe, it, expect } from "vitest"
import {
  QuotaReaderRegistry,
  defineQuotaReader,
  type QuotaStatus,
  type QuotaProfile,
  type QuotaReadContext,
} from "@agentproto/quota"
import type { AuthProfile } from "@agentproto/auth"
import { createQuotaReaderRegistry, readQuotaStatus } from "../quota-status-tool.js"

function profile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    id: "p-1",
    endpoint: "moonshot",
    method: "api-key",
    ...overrides,
  } as AuthProfile
}

/** Fixed `asOf` so reader output and the test's expectation never straddle a
 *  real clock tick. The fake reader below reads it from `ctx.now` — the same
 *  path `readQuotaStatus` forwards `deps.now` through to the registry — so
 *  this also exercises that forwarding, not just working around the clock. */
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z")

function fakeStatus(profileRef: string, asOf: Date = FIXED_NOW): QuotaStatus {
  return {
    profileRef,
    asOf: asOf.toISOString(),
    basis: "provider",
    windows: [{ id: "5h", remainingPct: 42 }],
  }
}

function fakeReaderUsingCtxNow(supports: (p: QuotaProfile) => boolean = () => true) {
  return defineQuotaReader({
    id: "fake",
    supports,
    read: async (p, ctx: QuotaReadContext) => fakeStatus(p.profileRef, ctx.now?.() ?? new Date()),
  })
}

describe("readQuotaStatus", () => {
  it("requires profileRef when the caller has no current session profile", async () => {
    const result = await readQuotaStatus({})
    expect(result).toEqual({
      ok: false,
      error: "profile_ref_required",
      message: expect.stringContaining("No profileRef given"),
    })
  })

  it("falls back to the calling session's own access profile when profileRef is omitted", async () => {
    const registry = new QuotaReaderRegistry().register(fakeReaderUsingCtxNow())
    const result = await readQuotaStatus(
      {},
      {
        getProfile: async (ref) => profile({ id: ref }),
        registry,
        now: () => FIXED_NOW,
        currentProfileRef: () => "session-profile",
      },
    )
    expect(result).toEqual({ ok: true, status: fakeStatus("session-profile") })
  })

  it("reports profile_not_found for an unknown profileRef, never throwing", async () => {
    const result = await readQuotaStatus(
      { profileRef: "ghost" },
      { getProfile: async () => undefined },
    )
    expect(result).toEqual({
      ok: false,
      error: "profile_not_found",
      message: expect.stringContaining('"ghost"'),
    })
  })

  it("reports no_reader when the registry has nothing for the profile's endpoint", async () => {
    const result = await readQuotaStatus(
      { profileRef: "p-1" },
      {
        getProfile: async () => profile({ endpoint: "some-unregistered-endpoint" }),
        registry: new QuotaReaderRegistry(),
      },
    )
    expect(result).toEqual({
      ok: false,
      error: "no_reader",
      message: expect.stringContaining("some-unregistered-endpoint"),
    })
  })

  it("reports reader_returned_nothing when the matched reader yields no status (AIP-67: unknown, not zero)", async () => {
    const registry = new QuotaReaderRegistry().register(
      defineQuotaReader({
        id: "fake",
        supports: () => true,
        read: async () => undefined,
      }),
    )
    const result = await readQuotaStatus(
      { profileRef: "p-1" },
      { getProfile: async () => profile(), registry },
    )
    expect(result).toEqual({
      ok: false,
      error: "reader_returned_nothing",
      message: expect.stringContaining("moonshot"),
    })
  })

  it("dispatches through the matching reader and returns its QuotaStatus", async () => {
    const registry = new QuotaReaderRegistry().register(
      fakeReaderUsingCtxNow((p) => p.endpoint === "moonshot"),
    )
    const result = await readQuotaStatus(
      { profileRef: "p-1" },
      { getProfile: async (ref) => profile({ id: ref }), registry, now: () => FIXED_NOW },
    )
    expect(result).toEqual({ ok: true, status: fakeStatus("p-1") })
  })

  describe("anthropic oauth-bearer subscription profile", () => {
    const sub = () =>
      profile({
        id: "sub-a",
        endpoint: "anthropic",
        method: "oauth-bearer",
        credentialRef: "agentproto.auth.anthropic.sub",
      } as Partial<AuthProfile>)

    it("is served by the default registry (no longer no_reader)", async () => {
      const result = await readQuotaStatus(
        { profileRef: "sub-a" },
        {
          getProfile: async () => sub(),
          resolveCredential: async () => "token-value",
          now: () => FIXED_NOW,
          // headers copied from a real reply (anonymised), see the quota package tests
          fetchImpl: (async () =>
            new Response("{}", {
              status: 200,
              headers: {
                "anthropic-ratelimit-unified-7d-utilization": "0.94",
                "anthropic-ratelimit-unified-7d-reset": "1794628800",
              },
            })) as unknown as typeof fetch,
        },
      )
      expect(result).toEqual({
        ok: true,
        status: {
          profileRef: "sub-a",
          asOf: FIXED_NOW.toISOString(),
          basis: "probe",
          source: "anthropic:oauth-unified-headers",
          windows: [{ id: "7d", remainingPct: 6, resetsAt: "2026-11-14T04:00:00.000Z" }],
        },
      })
      expect(createQuotaReaderRegistry().find({ profileRef: "x", endpoint: "anthropic", method: "oauth-bearer" })).toBeDefined()
    })

    it.each([
      [401, "credential_rejected"],
      [429, "rate_limited"],
    ] as const)("maps HTTP %i to %s", async (httpStatus, code) => {
      const result = await readQuotaStatus(
        { profileRef: "sub-a" },
        {
          getProfile: async () => sub(),
          resolveCredential: async () => "token-value",
          fetchImpl: (async () => new Response("{}", { status: httpStatus })) as unknown as typeof fetch,
        },
      )
      expect(result).toMatchObject({ ok: false, error: code })
    })

    it("maps an absent token to credential_missing, naming the key", async () => {
      const result = await readQuotaStatus(
        { profileRef: "sub-a" },
        { getProfile: async () => sub(), resolveCredential: async () => undefined },
      )
      expect(result).toMatchObject({
        ok: false,
        error: "credential_missing",
        message: expect.stringContaining("agentproto.auth.anthropic.sub"),
      })
    })

    it("maps a network failure to provider_unreachable", async () => {
      const result = await readQuotaStatus(
        { profileRef: "sub-a" },
        {
          getProfile: async () => sub(),
          resolveCredential: async () => "token-value",
          fetchImpl: (async () => {
            throw new TypeError("down")
          }) as unknown as typeof fetch,
        },
      )
      expect(result).toMatchObject({ ok: false, error: "provider_unreachable" })
    })
  })
})
