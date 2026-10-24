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
import { readQuotaStatus } from "../quota-status-tool.js"

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
})
