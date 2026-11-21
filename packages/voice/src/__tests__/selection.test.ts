import { describe, expect, it } from "vitest"
import { VOICE_DEFAULTS } from "../defaults.js"
import { defineVoiceProvider } from "../define.js"
import { makeVoiceRegistry } from "../registry.js"
import { resolveVoiceSelection } from "../selection.js"
import { makeFakeRealtime, makeFakeStt, makeFakeTts } from "../testing/fakes.js"

const def = VOICE_DEFAULTS.selection
const prov = (slug: string, aliases: { stt?: string[] } = {}, realtimeId?: string) =>
  defineVoiceProvider({
    slug,
    name: slug,
    env: { apiKey: `${slug.toUpperCase()}_API_KEY` },
    stt: makeFakeStt({ slug }),
    tts: makeFakeTts({ slug }),
    ...(realtimeId ? { realtime: makeFakeRealtime({ slug, id: realtimeId }) } : {}),
    valueAliases: aliases,
  })

// The default providers, plus the ones the legacy values imply, as installed packages.
const registry = () =>
  makeVoiceRegistry({
    providers: [
      prov(def.stt.value, { stt: ["scribe"] }, "elevenlabs-s2s"),
      prov("openai", { stt: ["whisper"] }, "openai-realtime-id"),
      prov("assemblyai"),
    ],
  })

describe("resolveVoiceSelection: priority rule", () => {
  it("unset: the kit default engine with the default provider of each stage", async () => {
    const s = await resolveVoiceSelection({}, registry())
    expect(s).toMatchObject({ engine: def.engine.value, stt: def.stt.value, tts: def.tts.value })
  })

  it("elevenlabs-realtime keeps its meaning: a cascade, same provider on both stages", async () => {
    const s = await resolveVoiceSelection({ VOICE_PROVIDER: "elevenlabs-realtime" }, registry())
    expect(s).toMatchObject({ engine: "cascade", stt: "elevenlabs", tts: "elevenlabs" })
  })

  it("whisper-elevenlabs: a cascade with OpenAI file STT and ElevenLabs TTS", async () => {
    const s = await resolveVoiceSelection({ VOICE_PROVIDER: "whisper-elevenlabs" }, registry())
    expect(s).toMatchObject({ engine: "cascade", stt: "openai", tts: "elevenlabs" })
  })

  it("openai-realtime: a realtime engine on openai", async () => {
    const s = await resolveVoiceSelection({ VOICE_PROVIDER: "openai-realtime" }, registry())
    expect(s).toMatchObject({ engine: "realtime", realtime: "openai" })
  })

  it("VOICE_STT_PROVIDER wins over what VOICE_PROVIDER implies for that stage (a deployment that sets the legacy value keeps it)", async () => {
    const s = await resolveVoiceSelection({ VOICE_PROVIDER: "elevenlabs-realtime", VOICE_STT_PROVIDER: "whisper" }, registry())
    expect(s).toMatchObject({ engine: "cascade", stt: "whisper", tts: "elevenlabs" })
    expect((await registry().stt(s.stt!)).slug).toBe("openai")
  })

  it("the legacy value scribe still resolves to the default STT provider", async () => {
    const s = await resolveVoiceSelection({ VOICE_STT_PROVIDER: "scribe" }, registry())
    expect((await registry().stt(s.stt!)).slug).toBe(def.stt.value)
  })

  it("the unset-STT deployment moves to the kit default, the set one does not", async () => {
    const unset = await resolveVoiceSelection({ VOICE_PROVIDER: "elevenlabs-realtime" }, registry())
    const pinned = await resolveVoiceSelection({ VOICE_PROVIDER: "elevenlabs-realtime", VOICE_STT_PROVIDER: "whisper" }, registry())
    expect(unset.stt).toBe(def.stt.value)
    expect(pinned.stt).toBe("whisper")
  })

  it("VOICE_TTS_PROVIDER selects another TTS in a cascade", async () => {
    const s = await resolveVoiceSelection({ VOICE_TTS_PROVIDER: "assemblyai" }, registry())
    expect(s).toMatchObject({ engine: "cascade", tts: "assemblyai" })
  })

  it("STT and TTS variables are ignored with a realtime engine, with a warning", async () => {
    const s = await resolveVoiceSelection({ VOICE_PROVIDER: "openai-realtime", VOICE_STT_PROVIDER: "whisper", VOICE_TTS_PROVIDER: "assemblyai" }, registry())
    expect(s.engine).toBe("realtime")
    expect(s.stt).toBeUndefined()
    expect(s.tts).toBeUndefined()
    expect(s.warnings).toHaveLength(1)
  })

  it("a realtime id declared by a provider is a VOICE_PROVIDER value", async () => {
    const s = await resolveVoiceSelection({ VOICE_PROVIDER: "elevenlabs-s2s" }, registry())
    expect(s).toMatchObject({ engine: "realtime", realtime: "elevenlabs-s2s" })
  })

  it("an unknown VOICE_PROVIDER fails, naming the value and the accepted ones", async () => {
    await expect(resolveVoiceSelection({ VOICE_PROVIDER: "nonsense" }, registry())).rejects.toThrow(/nonsense.*elevenlabs-realtime/)
  })

  it("an unresolvable slug fails with the slug and the stage, with no fallback", async () => {
    await expect(resolveVoiceSelection({ VOICE_TTS_PROVIDER: "nobody" }, registry())).rejects.toThrow(/nobody.*tts/)
    await expect(resolveVoiceSelection({ VOICE_STT_PROVIDER: "nobody" }, registry())).rejects.toThrow(/nobody.*stt/)
  })

  it("VOICE_ID wins; otherwise the TTS provider's own <SLUG>_VOICE_ID; language passes through", async () => {
    expect((await resolveVoiceSelection({ VOICE_ID: "v1", ELEVENLABS_VOICE_ID: "v2", VOICE_LANGUAGE: "fr" }, registry()))).toMatchObject({ voiceId: "v1", language: "fr" })
    expect((await resolveVoiceSelection({ ELEVENLABS_VOICE_ID: "v2" }, registry())).voiceId).toBe("v2")
    expect((await resolveVoiceSelection({ VOICE_TTS_PROVIDER: "assemblyai", ELEVENLABS_VOICE_ID: "v2", ASSEMBLYAI_VOICE_ID: "v3" }, registry())).voiceId).toBe("v3")
    expect((await resolveVoiceSelection({ VOICE_PROVIDER: "openai-realtime", OPENAI_VOICE_ID: "v4" }, registry())).voiceId).toBe("v4")
  })
})
