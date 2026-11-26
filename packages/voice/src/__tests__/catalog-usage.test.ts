import { describe, expect, it } from "vitest"
import { catalogModelId, normalizeModelId, usageToCatalogEvents } from "../catalog-usage.js"
import { makeUsageMeter } from "../usage.js"
import type { VoiceUsage } from "../types.js"

const usage = (entries: VoiceUsage["entries"]): VoiceUsage => ({ engine: "cascade", wallSeconds: 1, entries })
const providers = {
  acme: { stripModelPrefix: "acme_", fallbackModel: { tts: "acme_fast_2_5", stt: "acme_scribe_1" } },
  other: { prefix: "ns" },
}

describe("normalizeModelId", () => {
  it("strips the vendor prefix, dots the version, dashes the rest", () => {
    expect(normalizeModelId("acme_fast_2_5", "acme_")).toBe("fast-2.5")
    expect(normalizeModelId("acme_fast_2_5")).toBe("acme-fast-2.5")
    expect(normalizeModelId("plain-1")).toBe("plain-1")
  })
})

describe("credentialSource", () => {
  it("is stamped by the meter on every entry and copied onto the billable events", () => {
    const meter = makeUsageMeter("cascade")
    meter.addTtsCharacters("acme", 10, "m_1")
    meter.addSttSeconds("acme", 2, "m_2")
    expect(meter.snapshot().entries.every(e => e.credentialSource === undefined)).toBe(true)
    meter.setCredentialSource("tag-a")
    const { events } = usageToCatalogEvents(meter.snapshot(), { providers: { acme: {} } })
    expect(events.map(e => e.credentialSource)).toEqual(["tag-a", "tag-a"])
  })

  it("ignores a label set after the session is sealed, and keeps an empty-string label", () => {
    const meter = makeUsageMeter("cascade")
    meter.addTtsCharacters("acme", 10, "m_1")
    meter.setCredentialSource("")
    expect(meter.snapshot().entries[0]).toHaveProperty("credentialSource", "")
    meter.seal()
    meter.setCredentialSource("later")
    expect(meter.snapshot().entries[0]!.credentialSource).toBe("")
  })

  it("leaves the field out when the host never said", () => {
    const { events } = usageToCatalogEvents(
      usage([{ stage: "tts", provider: "acme", model: "m_1", characters: 3 }]),
      { providers },
    )
    expect(events[0]).not.toHaveProperty("credentialSource")
  })
})

describe("usageToCatalogEvents", () => {
  it("maps tts and stt entries and rounds seconds", () => {
    const { events, unbilled } = usageToCatalogEvents(
      usage([
        { stage: "tts", provider: "acme", model: "acme_slow_3", characters: 40 },
        { stage: "stt", provider: "other", model: "m_1", audioSeconds: 2.349 },
      ]),
      { providers },
    )
    expect(events).toEqual([
      { kind: "tts", provider: "acme", modelId: "acme/slow.3", characters: 40 },
      { kind: "stt", provider: "other", modelId: "ns/m.1", seconds: 2.3 },
    ])
    expect(unbilled).toEqual([])
  })

  it("uses the configured fallback only when the entry has no model", () => {
    const e = usage([{ stage: "tts", provider: "acme", characters: 5 }])
    const { events } = usageToCatalogEvents(e, { providers })
    expect(events[0]?.modelId).toBe(`acme/${normalizeModelId(providers.acme.fallbackModel.tts, "acme_")}`)
    expect(catalogModelId("other", providers.other, "tts")).toBeUndefined()
  })

  it("reports unbilled entries instead of guessing a model", () => {
    const { events, unbilled } = usageToCatalogEvents(
      usage([
        { stage: "tts", provider: "other", characters: 5 },
        { stage: "stt", provider: "unknown", audioSeconds: 3, model: "x" },
        { stage: "realtime", provider: "acme", audioSeconds: 3 },
        { stage: "tts", provider: "acme", characters: 0 },
      ]),
      { providers },
    )
    expect(events).toEqual([])
    expect(unbilled).toEqual(["tts:other", "stt:unknown", "realtime:acme"])
  })
})
