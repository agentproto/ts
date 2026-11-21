import { describe, expect, it } from "vitest"
import { apiKeyName, defineVoiceProvider } from "../define.js"
import { makeVoiceRegistry } from "../registry.js"
import { makeFakeRealtime, makeFakeStt, makeFakeTts } from "../testing/fakes.js"

const both = (slug: string, extra: Partial<Parameters<typeof defineVoiceProvider>[0]> = {}) =>
  defineVoiceProvider({
    slug,
    name: slug,
    env: { apiKey: apiKeyName(slug) },
    stt: makeFakeStt({ slug }),
    tts: makeFakeTts({ slug }),
    ...extra,
  })

describe("defineVoiceProvider", () => {
  it("derives capabilities from the stages present, and nothing else", () => {
    const p = both("acme")
    expect(Object.keys(p.capabilities).sort()).toEqual(["stt", "tts"])
    expect(p.realtime).toBeUndefined()
  })

  it("requires the key variable to be <SLUG>_API_KEY, with - as _", () => {
    expect(apiKeyName("my-vendor")).toBe("MY_VENDOR_API_KEY")
    expect(() => defineVoiceProvider({ slug: "acme", name: "x", env: { apiKey: "KEY" }, stt: makeFakeStt({ slug: "acme" }) })).toThrow(/ACME_API_KEY/)
  })

  it("refuses a provider with no stage", () => {
    expect(() => defineVoiceProvider({ slug: "acme", name: "x", env: { apiKey: "ACME_API_KEY" } })).toThrow(/no stage/)
  })

  it("refuses a non kebab-case slug and a stage that reports another slug", () => {
    expect(() => defineVoiceProvider({ slug: "Acme", name: "x", env: { apiKey: "ACME_API_KEY" }, stt: makeFakeStt() })).toThrow(/kebab/)
    expect(() => defineVoiceProvider({ slug: "acme", name: "x", env: { apiKey: "ACME_API_KEY" }, stt: makeFakeStt({ slug: "other" }) })).toThrow(/other/)
  })

  it("refuses a stage that is neither streaming nor file", () => {
    expect(() => defineVoiceProvider({ slug: "acme", name: "x", env: { apiKey: "ACME_API_KEY" }, tts: makeFakeTts({ slug: "acme", streaming: false, file: false }) })).toThrow(/streaming or file/)
  })
})

describe("makeVoiceRegistry", () => {
  it("resolves stages by slug and by declared value alias", async () => {
    const reg = makeVoiceRegistry({ providers: [both("acme", { valueAliases: { stt: ["legacy"] } }), both("other")] })
    expect((await reg.stt("acme")).slug).toBe("acme")
    expect((await reg.stt("legacy")).slug).toBe("acme")
    expect((await reg.tts("other")).slug).toBe("other")
  })

  it("names the slug and the stage when a stage is missing or a slug unknown", async () => {
    const rt = defineVoiceProvider({ slug: "rtonly", name: "x", env: { apiKey: "RTONLY_API_KEY" }, realtime: makeFakeRealtime({ slug: "rtonly" }) })
    const reg = makeVoiceRegistry({ providers: [rt] })
    await expect(reg.stt("rtonly")).rejects.toThrow(/rtonly.*stt/)
    await expect(reg.tts("nobody")).rejects.toThrow(/nobody.*tts/)
  })

  it("rejects an alias declared by two providers for one stage", async () => {
    const reg = makeVoiceRegistry({ providers: [both("a", { valueAliases: { stt: ["dup"] } }), both("b", { valueAliases: { stt: ["dup"] } })] })
    await expect(reg.stt("dup")).rejects.toThrow(/several providers/)
  })

  it("resolves a realtime provider by its declared id", async () => {
    const rt = defineVoiceProvider({ slug: "rtonly", name: "x", env: { apiKey: "RTONLY_API_KEY" }, realtime: makeFakeRealtime({ slug: "rtonly", id: "rtonly-live" }) })
    const reg = makeVoiceRegistry({ providers: [rt] })
    expect((await reg.realtime("rtonly-live")).slug).toBe("rtonly")
  })

  it("reads the key from <SLUG>_API_KEY or a declared alias, canonical name first", () => {
    const p = both("acme", { env: { apiKey: "ACME_API_KEY", aliases: ["ACME_LEGACY_KEY"] } })
    const reg = makeVoiceRegistry({ providers: [p], env: { ACME_LEGACY_KEY: "legacy" } })
    expect(reg.apiKey(p)).toBe("legacy")
    expect(makeVoiceRegistry({ providers: [p], env: { ACME_API_KEY: "canon", ACME_LEGACY_KEY: "legacy" } }).apiKey(p)).toBe("canon")
    expect(makeVoiceRegistry({ providers: [p], env: {} }).apiKey(p)).toBeUndefined()
  })

  it("an uninstalled catalog provider resolves to null (supported, not installed) with no daemon and no home", async () => {
    const reg = makeVoiceRegistry({ importPackage: async name => { throw new Error(`cannot find ${name}`) } })
    expect(await reg.provider("elevenlabs")).toBeNull()
    const list = await reg.family.list()
    expect(list.map(e => e.status)).toEqual(list.map(() => "supported"))
  })

  it("lists an installed provider as ready through the family, with a descriptor that carries no key", async () => {
    const reg = makeVoiceRegistry({ providers: [both("acme")], env: { ACME_API_KEY: "secret-value" } })
    const list = await reg.family.list()
    const entry = list.find(e => e.slug === "acme")!
    expect(entry.status).toBe("ready")
    expect(entry.info).toEqual({ slug: "acme", stages: ["stt", "tts"], apiKeyVariable: "ACME_API_KEY" })
    expect(JSON.stringify(list)).not.toContain("secret-value")
  })

  it("imports a provider package for a catalog slug", async () => {
    const acme = both("elevenlabs")
    const reg = makeVoiceRegistry({ importPackage: async () => ({ default: acme }) })
    expect((await reg.provider("elevenlabs"))?.slug).toBe("elevenlabs")
  })
})
