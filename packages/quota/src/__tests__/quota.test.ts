import { describe, expect, it } from "vitest"
import {
  QuotaReaderRegistry,
  buildQuotaStatus,
  defineQuotaReader,
  quotaStatusSchema,
  remainingPctFromCounts,
  remainingPctFromUsed,
} from "../index.js"
import type { QuotaProfile } from "../index.js"

const FIXED = () => new Date("2026-10-19T00:00:00.000Z")
const profile: QuotaProfile = { profileRef: "p1", endpoint: "openrouter", method: "api-key" }

describe("remainingPct helpers", () => {
  it("converts used percent and rejects out-of-range", () => {
    expect(remainingPctFromUsed(30)).toBe(70)
    expect(remainingPctFromUsed(0)).toBe(100)
    expect(remainingPctFromUsed(100)).toBe(0)
    expect(remainingPctFromUsed(101)).toBeUndefined()
    expect(remainingPctFromUsed(-1)).toBeUndefined()
    expect(remainingPctFromUsed(null)).toBeUndefined()
    expect(remainingPctFromUsed(Number.NaN)).toBeUndefined()
  })
  it("converts counts and rejects nonsense", () => {
    expect(remainingPctFromCounts(25, 100)).toBe(25)
    expect(remainingPctFromCounts(0, 100)).toBe(0)
    expect(remainingPctFromCounts(5, 0)).toBeUndefined()
    expect(remainingPctFromCounts(101, 100)).toBeUndefined()
    expect(remainingPctFromCounts(null, 100)).toBeUndefined()
    expect(remainingPctFromCounts(1, undefined)).toBeUndefined()
  })
})

describe("buildQuotaStatus", () => {
  it("keeps valid windows and drops invalid ones without repairing them", () => {
    const status = buildQuotaStatus({
      profileRef: "p1",
      basis: "provider",
      now: FIXED,
      windows: [
        { id: "5h", remainingPct: 40, resetsAt: "2026-10-19T05:00:00.000Z" },
        { id: "bad", remainingPct: 140 },
        { id: "nopct" },
      ],
    })
    expect(status?.windows).toEqual([
      { id: "5h", remainingPct: 40, resetsAt: "2026-10-19T05:00:00.000Z" },
    ])
    expect(status?.asOf).toBe("2026-10-19T00:00:00.000Z")
    expect(quotaStatusSchema.safeParse(status).success).toBe(true)
  })
  it("returns undefined when nothing is known", () => {
    expect(buildQuotaStatus({ profileRef: "p1", basis: "provider", windows: [{ id: "x" }] })).toBeUndefined()
  })
  it("reports credits alone when no window can be stated", () => {
    const status = buildQuotaStatus({
      profileRef: "p1",
      basis: "provider",
      source: "moonshot:/balance",
      now: FIXED,
      credits: { balanceUsd: 0, currency: "USD" },
    })
    expect(status?.windows).toEqual([])
    expect(status?.credits).toEqual({ balanceUsd: 0, currency: "USD" })
  })
  it("accepts a zero remaining window as real data", () => {
    expect(
      buildQuotaStatus({ profileRef: "p1", basis: "observed", windows: [{ id: "day", remainingPct: 0 }] })?.windows,
    ).toHaveLength(1)
  })
})

describe("QuotaReaderRegistry", () => {
  const reader = defineQuotaReader({
    id: "fake",
    supports: (p) => p.endpoint === "openrouter",
    read: async (p) =>
      buildQuotaStatus({ profileRef: p.profileRef, basis: "provider", now: FIXED, windows: [{ id: "key_limit", remainingPct: 10 }] }),
  })
  it("dispatches to the first supporting reader", async () => {
    const reg = new QuotaReaderRegistry().register(reader)
    expect((await reg.read(profile))?.windows[0]?.id).toBe("key_limit")
    expect(await reg.read({ ...profile, endpoint: "other" })).toBeUndefined()
  })
  it("rejects duplicate ids", () => {
    const reg = new QuotaReaderRegistry().register(reader)
    expect(() => reg.register(reader)).toThrow(/already registered/)
  })
  it("never throws when a reader throws", async () => {
    const reg = new QuotaReaderRegistry().register(
      defineQuotaReader({
        id: "boom",
        supports: () => true,
        read: async () => {
          throw new Error("x")
        },
      }),
    )
    expect(await reg.read(profile)).toBeUndefined()
  })
  it("treats a throwing supports() as unsupported", () => {
    const reg = new QuotaReaderRegistry().register(
      defineQuotaReader({
        id: "bad-supports",
        supports: () => {
          throw new Error("x")
        },
        read: async () => undefined,
      }),
    )
    expect(reg.find(profile)).toBeUndefined()
  })
})
