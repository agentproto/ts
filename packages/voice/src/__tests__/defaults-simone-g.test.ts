/**
 * Unit tests of the Simone [G] settings ported into the kit defaults
 * (inventory: REGLAGES-VOIX-SIMONE-20-11.md, voice kit): turn-level TTS
 * mode and per-sentence transport, session mic-idle close, the three-guard
 * STT dedup, PCM16 even-chunk alignment, and the data-only transport and
 * billing values. Fail timers are fake, like the other cascade tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { VOICE_DEFAULTS } from "../defaults.js"
import {
  startCascade,
  ttsModeFromEnv,
  ttsTransportFromEnv,
} from "../cascade/start-cascade.js"
import {
  createSttDedup,
  DEFAULT_STT_DEDUP,
  type SttDedup,
} from "../cascade/stt-dedup.js"
import { Pcm16ChunkAligner, isEvenPcm16 } from "../pcm16.js"
import { makeFakeStt, makeFakeTts } from "../testing/fakes.js"
import type { VoiceEmit, VoiceSession } from "../types.js"
import { loudFrame, quietFrame, SR } from "./cascade/pipeline-test-kit.js"

const SILENCE = 60

const frame = (kind: "loud" | "quiet", ms: number) => {
  const pcm = kind === "loud" ? loudFrame(ms) : quietFrame(ms)
  return {
    pcm16: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
    sampleRate: SR,
    sequenceNumber: 0,
  }
}

function recorder() {
  const events: Array<{ type: string; text?: string }> = []
  const emit: VoiceEmit = {
    audio: () => events.push({ type: "audio" }),
    userTranscript: (text, final) => events.push({ type: "user", text: `${text}:${final}` }),
    assistantTranscript: (text, final) => events.push({ type: "assistant", text: `${text}:${final}` }),
    toolCallStart: () => undefined,
    toolCallEnd: () => undefined,
    interrupt: () => events.push({ type: "interrupt" }),
    responseComplete: () => events.push({ type: "complete" }),
    error: err => events.push({ type: "error", text: err.message }),
  }
  return { events, emit }
}

async function speak(session: VoiceSession, loudMs = 200, quietMs = SILENCE + 100) {
  for (let t = 0; t < loudMs; t += 20) {
    await vi.advanceTimersByTimeAsync(20)
    await session.pushAudio(frame("loud", 20))
  }
  for (let t = 0; t < quietMs; t += 20) {
    await vi.advanceTimersByTimeAsync(20)
    await session.pushAudio(frame("quiet", 20))
  }
  await vi.advanceTimersByTimeAsync(50)
}

async function* words(...parts: string[]) {
  for (const p of parts) yield p
}

describe("Simone [G] port: kit defaults carry the studio values", () => {
  const s = VOICE_DEFAULTS.tts

  it("tts.mode defaults to http-sentence and tts.transport to the stream (VOICE_TTS_MODE / VOICE_TTS_TRANSPORT)", () => {
    expect(s.mode.value).toBe("http-sentence")
    expect(s.transport.value).toBe("stream")
    expect(s.mode.origin.length).toBeGreaterThan(10)
    expect(s.transport.origin.length).toBeGreaterThan(10)
  })

  it("session.idleMicMs defaults to 60 s with 0 disabling it", () => {
    expect(VOICE_DEFAULTS.session.idleMicMs.value).toBe(60_000)
    expect(VOICE_DEFAULTS.session.idleMicMs.origin.length).toBeGreaterThan(10)
  })

  it("the STT dedup carries the three-guard windows of the studio turn runner", () => {
    const d = VOICE_DEFAULTS.cascade.stt.dedup
    expect(d.duplicateWindowMs.value).toBe(5000)
    expect(d.echoWindowMs.value).toBe(10_000)
    expect(d.echoOverlapRatio.value).toBe(0.6)
    expect(d.minTokenLength.value).toBe(3)
    expect(DEFAULT_STT_DEDUP).toEqual({
      duplicateWindowMs: 5000,
      echoWindowMs: 10_000,
      echoOverlapRatio: 0.6,
      minTokenLength: 3,
    })
  })

  it("the WebRTC transport values are data-only defaults with their origins", () => {
    const w = VOICE_DEFAULTS.transport.webrtc
    expect(w.opusSampleRate.value).toBe(48_000)
    expect(w.frameMs.value).toBe(20)
    expect(w.payloadType.value).toBe(111)
    expect(w.opusBitrate.value).toBe(32_000)
    expect(w.opusApplication.value).toBe("audio")
    expect(w.resampler.value).toBe("windowed-sinc")
    expect(w.maxOutboundQueueMs.value).toBe(120_000)
  })

  it("the billing model ids match the studio speech-to-speech mapping", () => {
    const b = VOICE_DEFAULTS.billing.s2sModel
    expect(b.openai.value).toBe("openai/gpt-realtime")
    expect(b.elevenlabs.value).toBe("elevenlabs/conversational")
    expect(b.gemini.value).toBe("google/gemini-live")
  })
})

describe("ttsModeFromEnv (VOICE_TTS_MODE)", () => {
  it("reads the studio spellings and the kit spellings, rejects the rest", () => {
    expect(ttsModeFromEnv("http-sentence")).toBe("sentence")
    expect(ttsModeFromEnv("ws-continuous")).toBe("continuous")
    expect(ttsModeFromEnv("sentence")).toBe("sentence")
    expect(ttsModeFromEnv("continuous")).toBe("continuous")
    expect(ttsModeFromEnv("  WS-CONTINUOUS  ")).toBe("continuous")
    expect(ttsModeFromEnv("nonsense")).toBeUndefined()
    expect(ttsModeFromEnv("")).toBeUndefined()
    expect(ttsModeFromEnv(undefined)).toBeUndefined()
  })
})

describe("ttsTransportFromEnv (VOICE_TTS_TRANSPORT)", () => {
  it("http is the only opt-out; ws keeps the stream", () => {
    expect(ttsTransportFromEnv("http")).toBe("http")
    expect(ttsTransportFromEnv("ws")).toBe("stream")
    expect(ttsTransportFromEnv("stream")).toBe("stream")
    expect(ttsTransportFromEnv("nonsense")).toBeUndefined()
    expect(ttsTransportFromEnv(undefined)).toBeUndefined()
  })
})

describe("default TTS mode and transport in startCascade", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("the default mode is http-sentence: one stream per sentence", async () => {
    const { emit } = recorder()
    const tts = makeFakeTts()
    const session = await startCascade({
      emit,
      hooks: {},
      stt: makeFakeStt(),
      tts,
      vad: { silenceEndMs: SILENCE },
      brain: () => words("Première phrase complète. ", "Deuxième phrase complète. "),
    })
    await speak(session)
    expect(tts.streams.map(s => s.texts.join(""))).toEqual([
      "Première phrase complète.",
      "Deuxième phrase complète.",
    ])
    expect(tts.synthesized).toEqual([])
    await session.close()
  })

  it("the studio spelling ws-continuous selects the continuous mode", async () => {
    const { emit } = recorder()
    const tts = makeFakeTts()
    const session = await startCascade({
      emit,
      hooks: {},
      stt: makeFakeStt(),
      tts,
      ttsMode: "ws-continuous",
      vad: { silenceEndMs: SILENCE },
      brain: () => words("Première partie, ", "seconde partie."),
    })
    await speak(session)
    expect(tts.streams).toHaveLength(1)
    expect(tts.streams[0]!.texts.join("")).toBe("Première partie, seconde partie.")
    await session.close()
  })

  it("the default transport is the streaming socket; http opts out to synthesize()", async () => {
    const { emit } = recorder()
    const streamTts = makeFakeTts()
    const session = await startCascade({
      emit,
      hooks: {},
      stt: makeFakeStt(),
      tts: streamTts,
      ttsTransport: "http",
      vad: { silenceEndMs: SILENCE },
      brain: () => words("Une phrase complète. "),
    })
    await speak(session)
    expect(streamTts.streams).toHaveLength(0)
    expect(streamTts.synthesized).toEqual(["Une phrase complète."])
    await session.close()
  })

  it("http transport still streams for a provider that cannot synthesize", async () => {
    const { emit } = recorder()
    const tts = makeFakeTts({ file: false })
    const session = await startCascade({
      emit,
      hooks: {},
      stt: makeFakeStt(),
      tts,
      ttsTransport: "http",
      vad: { silenceEndMs: SILENCE },
      brain: () => words("Une phrase complète. "),
    })
    await speak(session)
    expect(tts.streams.map(s => s.texts.join(""))).toEqual(["Une phrase complète."])
    await session.close()
  })
})

describe("STT dedup (three guards)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("guard 2: an identical transcript inside 5 s is a duplicate and is not re-registered", () => {
    const dedup = createSttDedup()
    expect(dedup.isDuplicateRecentText("Bonjour !")).toBe(false)
    expect(dedup.isDuplicateRecentText("bonjour")).toBe(true)
    expect(dedup.lastDrop()).toBe("duplicate")
    vi.advanceTimersByTime(5_001)
    expect(dedup.isDuplicateRecentText("Bonjour !!")).toBe(false)
  })

  it("guard 3: a transcript echoing the assistant inside 10 s is dropped", () => {
    const dedup: SttDedup = createSttDedup()
    dedup.recordAssistantUtterance("Voici la réponse complète maintenant")
    expect(dedup.isAssistantEcho("voici la réponse complète")).toBe(true)
    expect(dedup.lastDrop()).toBe("assistant-echo")
    vi.advanceTimersByTime(10_001)
    expect(dedup.isAssistantEcho("voici la réponse complète")).toBe(false)
  })

  it("guard 3: a genuine reply sharing a word is not an echo (60 % token overlap)", () => {
    const dedup = createSttDedup()
    dedup.recordAssistantUtterance("voici la réponse complète maintenant")
    expect(dedup.isAssistantEcho("voici une autre question")).toBe(false)
  })

  it("guard 3: short tokens never identify an echo", () => {
    const dedup = createSttDedup()
    dedup.recordAssistantUtterance("je suis là ok")
    expect(dedup.isAssistantEcho("ok ok je")).toBe(false)
  })

  it("a partial override tunes one field and keeps the other kit defaults", () => {
    const dedup = createSttDedup({ duplicateWindowMs: 60_000 })
    expect(dedup.isDuplicateRecentText("allo")).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(dedup.isDuplicateRecentText("allo")).toBe(true)
  })

  describe("in the running cascade", () => {
    let log: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      log = vi.spyOn(console, "log").mockImplementation(() => {})
      vi.spyOn(console, "warn").mockImplementation(() => {})
    })
    afterEach(() => vi.restoreAllMocks())

    it("a repeated transcript inside the window fires one turn, not two", async () => {
      const { events, emit } = recorder()
      const brainInputs: string[] = []
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt({ finals: ["allo"] }),
        tts: makeFakeTts(),
        vad: { silenceEndMs: SILENCE },
        brain: ({ text }) => {
          brainInputs.push(text)
          return words("Réponse complète. ")
        },
      })
      await speak(session)
      await speak(session)
      expect(brainInputs).toEqual(["allo"])
      expect(events.filter(e => e.type === "complete")).toHaveLength(1)
      expect(log.mock.calls.some(c => String(c[0]).includes("stt dedup dropped"))).toBe(true)
      await session.close()
    })

    it("sttDedup: false restores the unfiltered behaviour", async () => {
      const { emit } = recorder()
      const brainInputs: string[] = []
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt({ finals: ["allo"] }),
        tts: makeFakeTts(),
        sttDedup: false,
        vad: { silenceEndMs: SILENCE },
        brain: ({ text }) => {
          brainInputs.push(text)
          return words("Réponse complète. ")
        },
      })
      await speak(session)
      await speak(session)
      expect(brainInputs).toEqual(["allo", "allo"])
      await session.close()
    })

    it("the assistant's own words coming back through the mic never start a turn", async () => {
      const { emit } = recorder()
      const brainInputs: string[] = []
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt({ finals: ["salut", "voici la réponse complète"] }),
        tts: makeFakeTts(),
        vad: { silenceEndMs: SILENCE },
        brain: ({ text }) => {
          brainInputs.push(text)
          return words("Voici la réponse complète. ")
        },
      })
      await speak(session)
      expect(brainInputs).toEqual(["salut"])
      await speak(session)
      expect(brainInputs).toEqual(["salut"])
      expect(log.mock.calls.some(c => String(c[0]).includes("reason=assistant-echo"))).toBe(true)
      await session.close()
    })
  })
})

describe("session mic-idle close (MIC_IDLE_PAUSE_MS)", () => {
  let log: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    log = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("closes the session after the 60 s default and notifies the host", async () => {
    const { events, emit } = recorder()
    const idle: Array<{ idleMs: number }> = []
    const s = await startCascade({
      emit,
      hooks: { onMicIdle: async info => void idle.push(info) },
      stt: makeFakeStt({ finals: ["allo"] }),
      tts: makeFakeTts(),
      vad: { silenceEndMs: SILENCE },
      brain: () => words("Réponse complète. "),
    })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(idle).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    expect(idle).toEqual([{ idleMs: 60_000 }])
    // Closed: a full utterance after the idle produces no transcript, no turn.
    await speak(s)
    expect(events.some(e => e.type === "user")).toBe(false)
    await s.close() // idempotent after the idle close
  })

  it("mic frames keep the session open across the bound and it still turns", async () => {
    const { events, emit } = recorder()
    const idle: Array<{ idleMs: number }> = []
    const s = await startCascade({
      emit,
      hooks: { onMicIdle: async info => void idle.push(info) },
      stt: makeFakeStt({ finals: ["allo"] }),
      tts: makeFakeTts(),
      vad: { silenceEndMs: SILENCE },
      brain: () => words("Réponse complète. "),
    })
    for (let t = 0; t < 3; t++) {
      await vi.advanceTimersByTimeAsync(59_000)
      await s.pushAudio(frame("quiet", 20))
    }
    expect(idle).toEqual([])
    await speak(s)
    expect(events.some(e => e.type === "user")).toBe(true)
    await s.close()
  })

  it("idleMicMs: 0 keeps the session open forever", async () => {
    const idle: Array<{ idleMs: number }> = []
    const s = await startCascade({
      emit: recorder().emit,
      hooks: { onMicIdle: async info => void idle.push(info) },
      stt: makeFakeStt(),
      tts: makeFakeTts(),
      idleMicMs: 0,
      vad: { silenceEndMs: SILENCE },
      brain: () => words("Réponse complète. "),
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(idle).toEqual([])
    await s.close()
  })

  it("an explicit idleMicMs overrides the 60 s default", async () => {
    const idle: Array<{ idleMs: number }> = []
    const s = await startCascade({
      emit: recorder().emit,
      hooks: { onMicIdle: async info => void idle.push(info) },
      stt: makeFakeStt(),
      tts: makeFakeTts(),
      idleMicMs: 5_000,
      vad: { silenceEndMs: SILENCE },
      brain: () => words("Réponse complète. "),
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(idle).toEqual([{ idleMs: 5_000 }])
    await s.close()
  })
})

describe("PCM16 even-chunk alignment", () => {
  const u8 = (...bytes: number[]) => new Uint8Array(bytes)

  it("an even chunk passes through with nothing withheld", () => {
    const a = new Pcm16ChunkAligner()
    expect(a.push(u8(1, 2, 3, 4))).toEqual(u8(1, 2, 3, 4))
    expect(a.flush()).toEqual(u8())
  })

  it("an odd chunk emits the even part and keeps the dangling byte for the next", () => {
    const a = new Pcm16ChunkAligner()
    expect(a.push(u8(1, 2, 3))).toEqual(u8(1, 2))
    const next = a.push(u8(4))
    expect(next).toEqual(u8(3, 4))
    expect(isEvenPcm16(next)).toBe(true)
    expect(a.flush()).toEqual(u8())
  })

  it("a stream of odd chunks never loses a byte and never emits a half-sample", () => {
    const a = new Pcm16ChunkAligner()
    const chunks = [u8(1), u8(2), u8(3), u8(4), u8(5), u8(6), u8(7)]
    const out: number[] = []
    for (const c of chunks) {
      const part = a.push(c)
      expect(part.byteLength % 2).toBe(0)
      out.push(...part)
    }
    out.push(...a.flush())
    expect(out).toEqual([1, 2, 3, 4, 5, 6])
  })

  it("flush() drops a lone dangling byte instead of shipping a half-sample", () => {
    const a = new Pcm16ChunkAligner()
    expect(a.push(u8(1, 2, 3))).toEqual(u8(1, 2))
    expect(a.flush()).toEqual(u8())
    expect(a.push(u8(4, 5))).toEqual(u8(4, 5))
  })
})
