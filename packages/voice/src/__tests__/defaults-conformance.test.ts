import { describe, expect, it } from "vitest"
import { startCascade } from "../cascade/start-cascade.js"
import { VOICE_DEFAULTS, VOICE_ENV, type Origin } from "../defaults.js"
import { startRealtime } from "../realtime.js"
import {
  makeFakeRealtime,
  makeFakeStt,
  makeFakeTts,
  pcmFrame,
  sessionConformanceCases,
  sttConformanceCases,
  ttsConformanceCases,
} from "../testing/index.js"

function walk(obj: unknown, path: string[], out: Array<{ path: string; origin: string }>) {
  if (obj && typeof obj === "object" && "origin" in obj && "value" in obj) {
    out.push({ path: path.join("."), origin: (obj as Origin<unknown>).origin })
    return
  }
  if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) walk(v, [...path, k], out)
}

describe("defaults file", () => {
  const all: Array<{ path: string; origin: string }> = []
  walk(VOICE_DEFAULTS, [], all)

  it("every default carries a non-empty origin", () => {
    expect(all.length).toBeGreaterThan(30)
    for (const d of all) expect(d.origin.trim().length, d.path).toBeGreaterThan(10)
  })

  it("the default engine is the cascade with the same default provider on both stages (decision of 2026-11-20)", () => {
    expect(VOICE_DEFAULTS.selection.engine.value).toBe("cascade")
    expect(VOICE_DEFAULTS.selection.stt.value).toBe(VOICE_DEFAULTS.selection.tts.value)
    expect(VOICE_DEFAULTS.selection.realtime.value).toBe(VOICE_DEFAULTS.selection.tts.value)
  })

  it("holds no product-specific setting and no account identifier", () => {
    const text = JSON.stringify(VOICE_DEFAULTS)
    expect(text).not.toMatch(/S2S_AGENT|agent_id|whatsapp|filler|clip/i)
    expect(VOICE_DEFAULTS.cascade.vad.silenceEndMs.value).toBe(700)
  })

  it("names the standard variables", () => {
    expect(Object.values(VOICE_ENV).sort()).toEqual(["VOICE_ID", "VOICE_LANGUAGE", "VOICE_PROVIDER", "VOICE_STT_PROVIDER", "VOICE_TTS_PROVIDER"])
  })
})

describe("conformance on fakes: STT provider", () => {
  const frames = [pcmFrame(200, 16_000)]
  for (const c of sttConformanceCases(makeFakeStt(), { sampleRate: 16_000, frames, timeoutMs: 200 })) it(c.name, c.run)
  for (const c of sttConformanceCases(makeFakeStt({ streaming: false }), { sampleRate: 16_000, frames })) it(`file only: ${c.name}`, c.run)
})

describe("conformance on fakes: TTS provider", () => {
  for (const c of ttsConformanceCases(makeFakeTts())) it(c.name, c.run)
  for (const c of ttsConformanceCases(makeFakeTts({ streaming: false }))) it(`file only: ${c.name}`, c.run)
})

describe("conformance on fakes: realtime session", () => {
  const provider = makeFakeRealtime()
  const harness = {
    start: (emit: Parameters<typeof startRealtime>[1]["emit"]) => startRealtime(provider, { emit, hooks: {} }),
    async completeTurn(s: Awaited<ReturnType<typeof startRealtime>>) {
      s.pushAudio(pcmFrame(100, 16_000))
      provider.sessions.at(-1)!.vendorTurn("hi", "hello")
    },
    async interruptedTurn() {
      provider.sessions.at(-1)!.vendorBargeIn()
    },
  }
  for (const c of sessionConformanceCases(harness)) it(c.name, c.run)
})

describe("conformance on fakes: cascade session", () => {
  const harness = {
    start: (emit: Parameters<typeof startCascade>[0]["emit"]) =>
      startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt(),
        tts: makeFakeTts(),
        vad: false,
        brain: async function* () { yield "Une phrase complète. " },
      }),
    async completeTurn(s: Awaited<ReturnType<typeof startCascade>>) {
      const loud = new Int16Array(320).map((_, i) => Math.round(Math.sin(i / 3) * 8000))
      for (let i = 0; i < 10; i++) await s.pushAudio({ pcm16: loud.buffer.slice(0), sampleRate: 16_000, sequenceNumber: i })
      await s.commit()
      await new Promise(r => setTimeout(r, 30))
    },
  }
  for (const c of sessionConformanceCases(harness)) it(c.name, c.run)
})
