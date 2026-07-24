/**
 * Focused coverage for `collectSessionSnapshots` — the impure disk-read +
 * descriptor-join shared by the `usage_rollup` MCP tool and `GET /usage/rollup`.
 *
 * The pure windowing/pricing math is owned by usage-rollup.test.ts; here we
 * only assert the collection contract: which sessions are included, how the
 * onlyIds/profileRef filters bite, and that the attribution keys are resolved
 * off the descriptor.
 */
import { describe, expect, it } from "vitest"
import type { SessionsRegistry } from "../sessions.js"
import type { UsageRollup, UsageSnapshotRecord } from "../usage-rollup.js"
import { collectSessionSnapshots, enrichWithRemainingQuota } from "../usage-rollup-service.js"
import type {
  QuotaReadableProfile,
  RemainingQuota,
  RemainingQuotaReader,
} from "../remaining-quota.js"

/** One cumulative snapshot — the fields the collector forwards verbatim. */
function snap(costUsd: number): UsageSnapshotRecord {
  return { ts: "2026-07-24T00:00:00.000Z", costUsd, tokensIn: 10, tokensOut: 5, source: "computed" }
}

type DescStub = {
  id: string
  kind: string
  accessProfile?: { profileRef: string }
  harness?: string
  adapterSlug?: string
}

/** Minimal registry exposing only `list()` + `readUsageSnapshots()`, the two
 *  methods `collectSessionSnapshots` touches. Cast through unknown so we don't
 *  have to satisfy the whole (large) SessionsRegistry surface. */
function fakeRegistry(
  descriptors: DescStub[],
  snapshots: Record<string, UsageSnapshotRecord[]>,
): SessionsRegistry {
  return {
    list: () => descriptors,
    readUsageSnapshots: async (id: string) => snapshots[id] ?? [],
  } as unknown as SessionsRegistry
}

describe("collectSessionSnapshots", () => {
  it("includes only agent-cli sessions that have ≥1 snapshot", async () => {
    const registry = fakeRegistry(
      [
        { id: "a", kind: "agent-cli", adapterSlug: "claude-code" },
        { id: "b", kind: "agent-cli", adapterSlug: "hermes" }, // no snapshots
        { id: "t", kind: "terminal" }, // wrong kind
        { id: "c", kind: "command" }, // wrong kind
      ],
      { a: [snap(1)], b: [], c: [snap(9)] },
    )
    const out = await collectSessionSnapshots(registry)
    expect(out.map(s => s.sessionId)).toEqual(["a"])
  })

  it("onlyIds filters to the subtree", async () => {
    const registry = fakeRegistry(
      [
        { id: "a", kind: "agent-cli", adapterSlug: "claude-code" },
        { id: "b", kind: "agent-cli", adapterSlug: "claude-code" },
        { id: "c", kind: "agent-cli", adapterSlug: "claude-code" },
      ],
      { a: [snap(1)], b: [snap(2)], c: [snap(3)] },
    )
    const out = await collectSessionSnapshots(registry, { onlyIds: new Set(["a", "c"]) })
    expect(out.map(s => s.sessionId).sort()).toEqual(["a", "c"])
  })

  it("profileRef keeps only sessions whose resolved profileRef matches", async () => {
    const registry = fakeRegistry(
      [
        { id: "a", kind: "agent-cli", accessProfile: { profileRef: "max" }, adapterSlug: "claude-code" },
        { id: "b", kind: "agent-cli", accessProfile: { profileRef: "team" }, adapterSlug: "claude-code" },
        { id: "c", kind: "agent-cli", adapterSlug: "claude-code" }, // no profile
      ],
      { a: [snap(1)], b: [snap(2)], c: [snap(3)] },
    )
    const out = await collectSessionSnapshots(registry, { profileRef: "max" })
    expect(out.map(s => s.sessionId)).toEqual(["a"])
  })

  it("resolves profileRef + harness off the descriptor (harness falls back to adapterSlug)", async () => {
    const registry = fakeRegistry(
      [
        // harness present → wins over adapterSlug
        { id: "a", kind: "agent-cli", accessProfile: { profileRef: "max" }, harness: "claude-code", adapterSlug: "cc-legacy" },
        // no harness → falls back to adapterSlug
        { id: "b", kind: "agent-cli", adapterSlug: "hermes" },
      ],
      { a: [snap(1)], b: [snap(2)] },
    )
    const out = await collectSessionSnapshots(registry)
    const a = out.find(s => s.sessionId === "a")
    const b = out.find(s => s.sessionId === "b")
    expect(a).toMatchObject({ profileRef: "max", harness: "claude-code" })
    expect(b).toMatchObject({ profileRef: undefined, harness: "hermes" })
  })

  it("tolerates a per-session read failure — treats it as no snapshots", async () => {
    const registry = {
      list: () => [
        { id: "a", kind: "agent-cli", adapterSlug: "claude-code" },
        { id: "boom", kind: "agent-cli", adapterSlug: "claude-code" },
      ],
      readUsageSnapshots: async (id: string) => {
        if (id === "boom") throw new Error("corrupt transcript")
        return [snap(1)]
      },
    } as unknown as SessionsRegistry
    const out = await collectSessionSnapshots(registry)
    expect(out.map(s => s.sessionId)).toEqual(["a"])
  })
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

const quota: RemainingQuota = {
  window: "5h",
  remaining: 123,
  resetsAt: "2026-07-24T05:00:00.000Z",
  basis: "provider",
}

const resolveAnthropic = (profileRef: string): QuotaReadableProfile => ({
  profileRef,
  endpoint: "anthropic",
  method: "oauth-bearer",
  source: "claude-code-oauth",
})

describe("enrichWithRemainingQuota", () => {
  it("attaches remaining for a resolvable profile", async () => {
    const reader: RemainingQuotaReader = {
      readRemainingQuota: async () => quota,
    }
    const out = await enrichWithRemainingQuota(rollupWithProfiles(["max"]), {
      reader,
      resolveProfile: resolveAnthropic,
      window: "5h",
    })
    expect(out.byProfile[0]?.remaining).toEqual(quota)
  })

  it("skips the 'unknown' profileRef entirely", async () => {
    const seen: string[] = []
    const reader: RemainingQuotaReader = {
      readRemainingQuota: async profile => {
        seen.push(profile.profileRef)
        return quota
      },
    }
    const out = await enrichWithRemainingQuota(rollupWithProfiles(["unknown", "max"]), {
      reader,
      resolveProfile: resolveAnthropic,
      window: "5h",
    })
    expect(seen).toEqual(["max"])
    const unknown = out.byProfile.find(p => p.profileRef === "unknown")
    const max = out.byProfile.find(p => p.profileRef === "max")
    expect(unknown?.remaining).toBeUndefined()
    expect(max?.remaining).toEqual(quota)
  })

  it("leaves the rollup intact when the reader rejects", async () => {
    const reader: RemainingQuotaReader = {
      readRemainingQuota: async () => {
        throw new Error("boom")
      },
    }
    const input = rollupWithProfiles(["max"])
    const out = await enrichWithRemainingQuota(input, {
      reader,
      resolveProfile: resolveAnthropic,
      window: "5h",
    })
    expect(out.byProfile[0]?.remaining).toBeUndefined()
    expect(out.byProfile[0]?.profileRef).toBe("max")
  })

  it("skips a profile that cannot be resolved", async () => {
    const reader: RemainingQuotaReader = {
      readRemainingQuota: async () => quota,
    }
    const out = await enrichWithRemainingQuota(rollupWithProfiles(["max"]), {
      reader,
      resolveProfile: () => undefined,
      window: "5h",
    })
    expect(out.byProfile[0]?.remaining).toBeUndefined()
  })
})
