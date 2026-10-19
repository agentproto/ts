/**
 * Unit coverage for `readQuotaStatus` — the transport-free core of the
 * `quota_status` MCP tool (AIP-67). Exercises profile resolution + registry
 * dispatch with injected deps; no MCP transport, no real keychain/network.
 */

import { describe, it, expect } from "vitest"
import { QuotaReaderRegistry, defineQuotaReader, type QuotaStatus } from "@agentproto/model-intel"
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

function fakeStatus(profileRef: string): QuotaStatus {
  return {
    profileRef,
    asOf: new Date().toISOString(),
    basis: "provider",
    windows: [{ id: "5h", remainingPct: 42 }],
  }
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
    const registry = new QuotaReaderRegistry().register(
      defineQuotaReader({
        id: "fake",
        supports: () => true,
        read: async (p) => fakeStatus(p.profileRef),
      }),
    )
    const result = await readQuotaStatus(
      {},
      {
        getProfile: async (ref) => profile({ id: ref }),
        registry,
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
      defineQuotaReader({
        id: "fake",
        supports: (p) => p.endpoint === "moonshot",
        read: async (p) => fakeStatus(p.profileRef),
      }),
    )
    const result = await readQuotaStatus(
      { profileRef: "p-1" },
      { getProfile: async (ref) => profile({ id: ref }), registry },
    )
    expect(result).toEqual({ ok: true, status: fakeStatus("p-1") })
  })
})
