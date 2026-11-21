import { describe, expect, it } from "vitest"
import { addDuration, addMonthsUtc, bonusPercent, convertMinor, entryRatio, grantKey, periodKey } from "../index.js"
import type { Grant } from "../types.js"

describe("rule 9 and 26: rates and rounding", () => {
  it("rounds down, never to nearest (rule 9)", () => {
    expect(convertMinor(3, 118, 2, 0)).toBe(3) // 3.54 credits
    expect(convertMinor(199, 1000, 2, 0)).toBe(1990)
    expect(convertMinor(1, 1000, 2, 0)).toBe(10)
  })
  it("absorbs binary floating point only: 100 x 1.18 is 118", () => {
    expect(convertMinor(200, entryRatio({ anchor: { currency: "USD", creditsPerUnit: 100 }, fx: { EUR: 1.18 } }, "EUR")!, 2, 2)).toBe(23_600)
  })
  it("derives the entry rate from the anchor and fx, null for a currency outside both", () => {
    const d = { anchor: { currency: "USD", creditsPerUnit: 100 }, fx: { EUR: 1.18 } }
    expect(entryRatio(d, "usd")).toBe(100)
    expect(entryRatio(d, "aip://49/EUR")).toBe(118)
    expect(entryRatio(d, "GBP")).toBeNull()
  })
})

describe("bonus tiers", () => {
  const tiers = [[5000, 30], [2500, 30], [1000, 20], [500, 10], [0, 0]] as const
  it("takes the highest tier whose threshold is at most the amount, on its boundary", () => {
    expect(bonusPercent(tiers, 499)).toBe(0)
    expect(bonusPercent(tiers, 500)).toBe(10)
    expect(bonusPercent(tiers, 999)).toBe(10)
    expect(bonusPercent(tiers, 1000)).toBe(20)
    expect(bonusPercent(tiers, 5000)).toBe(30)
    expect(bonusPercent([[30001, 15], [12000, 10], [6000, 5], [0, 0]], 30000)).toBe(10)
  })
})

describe("durations", () => {
  it("clamps the day at the end of a short month", () => {
    expect(addMonthsUtc(Date.UTC(2026, 0, 31), 1)).toBe(Date.UTC(2026, 1, 28))
    expect(addDuration(Date.UTC(2026, 10, 20), "P12M")).toBe(Date.UTC(2027, 10, 20))
    expect(addDuration(Date.UTC(2026, 10, 20), "P7D")).toBe(Date.UTC(2026, 10, 27))
  })
  it("refuses a malformed duration", () => {
    expect(() => addDuration(0, "7 days")).toThrow(/duration/)
  })
})

describe("grant periods and keys (rule 15)", () => {
  const weeklyParis: Grant["trigger"] = { kind: "cron", cron: "0 12 * * 6", timezone: "Europe/Paris" }
  it("names the ISO week in the zone of the trigger", () => {
    expect(periodKey(weeklyParis, Date.UTC(2026, 10, 21, 11, 0))).toBe("2026-W47")
    // 2026-11-22 23:30 UTC is already Monday 23 in Paris: next ISO week
    expect(periodKey(weeklyParis, Date.UTC(2026, 10, 22, 23, 30))).toBe("2026-W48")
  })
  it("reads monthly and daily from the cron fields and an RRULE", () => {
    expect(periodKey({ kind: "cron", cron: "0 0 1 * *" }, Date.UTC(2026, 10, 20))).toBe("2026-11")
    expect(periodKey({ kind: "cron", cron: "0 0 * * *" }, Date.UTC(2026, 10, 20))).toBe("2026-11-20")
    expect(periodKey({ kind: "calendar", rrule: "FREQ=MONTHLY;BYMONTHDAY=1" }, Date.UTC(2026, 10, 20))).toBe("2026-11")
  })
  it("prefixes the key with the grant id so two grants never collide", () => {
    const base = { trigger: { kind: "manual" }, amount: { fixedMinor: 1 }, partition: "A:b", key: "{account}:once" } as unknown as Grant
    expect(grantKey({ ...base, id: "g1" }, "acc")).toBe("grant:g1:acc:once")
    expect(grantKey({ ...base, id: "g2" }, "acc")).toBe("grant:g2:acc:once")
  })
})
