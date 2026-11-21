import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startCascade } from "../cascade/start-cascade.js"
import { VOICE_DEFAULTS } from "../defaults.js"
import { makeFakeStt, makeFakeTts, type Timeline } from "../testing/fakes.js"
import type { VoiceEmit, VoiceSession } from "../types.js"
import { feed, loudFrame, quietFrame, SR } from "./cascade/pipeline-test-kit.js"

const SILENCE = 60

function recorder(timeline: Timeline) {
  const events: Array<{ type: string; text?: string }> = []
  const emit: VoiceEmit = {
    audio: () => {
      events.push({ type: "audio" })
      timeline.push("emit:audio")
    },
    userTranscript: (text, final) => events.push({ type: "user", text: `${text}:${final}` }),
    assistantTranscript: (text, final) => events.push({ type: "assistant", text: `${text}:${final}` }),
    toolCallStart: () => undefined,
    toolCallEnd: () => undefined,
    interrupt: () => {
      events.push({ type: "interrupt" })
      timeline.push("emit:interrupt")
    },
    responseComplete: () => events.push({ type: "complete" }),
    error: err => events.push({ type: "error", text: err.message }),
  }
  return { events, emit }
}

const frame = (kind: "loud" | "quiet", ms: number, seq = 0) => {
  const pcm = kind === "loud" ? loudFrame(ms) : quietFrame(ms)
  return { pcm16: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer, sampleRate: SR, sequenceNumber: seq }
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

describe("startCascade", () => {
  let log: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    log = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    log.mockRestore()
    vi.restoreAllMocks()
  })

  it("runs a turn: transcripts, brain text to TTS audio, one responseComplete", async () => {
    const timeline: Timeline = []
    const { events, emit } = recorder(timeline)
    const stt = makeFakeStt({ finals: ["bonjour"] })
    const tts = makeFakeTts()
    const brainInputs: string[] = []
    const session = await startCascade({
      emit,
      hooks: {},
      stt,
      tts,
      vad: { silenceEndMs: SILENCE },
      brain: ({ text }) => {
        brainInputs.push(text)
        return words("Voici une première phrase. ", "Et une seconde phrase. ")
      },
    })
    await speak(session)
    expect(brainInputs).toEqual(["bonjour"])
    const types = events.map(e => e.type)
    expect(types.filter(t => t === "complete")).toHaveLength(1)
    expect(types.filter(t => t === "audio").length).toBeGreaterThan(0)
    expect(events.find(e => e.type === "user")?.text).toBe("bonjour:true")
    expect(events.find(e => e.type === "assistant")?.text).toContain("première phrase")
    expect(types).not.toContain("interrupt")
    await session.close()
  })

  it("the brain yields text and the engine owns synthesis: sentences go to the TTS provider", async () => {
    const { emit } = recorder([])
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
    await session.close()
  })

  it("reports usage: STT seconds and TTS characters, cumulative, final after close", async () => {
    const { emit } = recorder([])
    const stt = makeFakeStt({ slug: "sttvendor" })
    const tts = makeFakeTts({ slug: "ttsvendor" })
    const session = await startCascade({
      emit,
      hooks: {},
      stt,
      tts,
      vad: { silenceEndMs: SILENCE },
      brain: () => words("Une phrase à dire. "),
    })
    expect(session.getUsage?.()?.entries).toEqual([])
    await speak(session)
    const mid = session.getUsage!()!
    const sttEntry = mid.entries.find(e => e.stage === "stt")
    const ttsEntry = mid.entries.find(e => e.stage === "tts")
    expect(sttEntry?.provider).toBe("sttvendor")
    expect(sttEntry?.audioSeconds).toBeGreaterThan(0)
    expect(ttsEntry?.provider).toBe("ttsvendor")
    expect(ttsEntry?.characters).toBe("Une phrase à dire.".length)
    expect(mid.engine).toBe("cascade")
    expect(JSON.stringify(mid)).not.toContain("bonjour")
    await session.close()
    const final = session.getUsage!()!
    await vi.advanceTimersByTimeAsync(2000)
    expect(session.getUsage!()!).toEqual(final)
    expect(final.entries.find(e => e.stage === "tts")?.characters).toBe(ttsEntry?.characters)
  })

  describe("barge-in", () => {
    it("aborts the brain and cancels TTS BEFORE emitting interrupt, and no audio follows", async () => {
      const timeline: Timeline = []
      const { events, emit } = recorder(timeline)
      const tts = makeFakeTts({ timeline, slowAfterStreams: 1 })
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt(),
        tts,
        vad: { silenceEndMs: SILENCE },
        bargeIn: { enabled: true, minSpeechMs: 100, guardMs: 0 },
        brain: async function* ({ signal }) {
          signal.addEventListener("abort", () => timeline.push("brain:abort"), { once: true })
          yield "Première phrase complète. "
          yield "Deuxième phrase qui reste en cours. "
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        },
      })
      await speak(session)
      // The assistant is now speaking (second TTS stream still generating).
      expect(events.some(e => e.type === "audio")).toBe(true)
      for (let t = 0; t < 300; t += 20) {
        await vi.advanceTimersByTimeAsync(20)
        await session.pushAudio(frame("loud", 20))
      }
      const cut = timeline.indexOf("emit:interrupt")
      expect(cut).toBeGreaterThan(-1)
      expect(timeline.indexOf("brain:abort")).toBeGreaterThan(-1)
      expect(timeline.indexOf("brain:abort")).toBeLessThan(cut)
      expect(timeline.indexOf("tts:cancel")).toBeGreaterThan(-1)
      expect(timeline.indexOf("tts:cancel")).toBeLessThan(cut)
      expect(timeline.slice(cut)).not.toContain("emit:audio")
      expect(events.filter(e => e.type === "interrupt")).toHaveLength(1)
      expect(events.some(e => e.type === "complete")).toBe(false)
      await session.close()
    })

    it("interrupt() cuts the running turn the same way", async () => {
      const timeline: Timeline = []
      const { events, emit } = recorder(timeline)
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt(),
        tts: makeFakeTts({ timeline, slowAfterStreams: 1 }),
        vad: { silenceEndMs: SILENCE },
        brain: async function* ({ signal }) {
          signal.addEventListener("abort", () => timeline.push("brain:abort"), { once: true })
          yield "Première phrase complète. "
          yield "Deuxième phrase qui reste en cours. "
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        },
      })
      await speak(session)
      await session.interrupt()
      expect(timeline.indexOf("brain:abort")).toBeLessThan(timeline.indexOf("emit:interrupt"))
      expect(events.filter(e => e.type === "interrupt")).toHaveLength(1)
      await session.interrupt()
      expect(events.filter(e => e.type === "interrupt")).toHaveLength(1)
      await session.close()
    })
  })

  describe("manual mode (vad: false)", () => {
    it("runs no local VAD: commit() ends the utterance", async () => {
      const { events, emit } = recorder([])
      const brain = vi.fn(() => words("Une réponse complète. "))
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt({ finals: ["bonjour"] }),
        tts: makeFakeTts(),
        vad: false,
        brain,
      })
      for (let t = 0; t < 200; t += 20) {
        await vi.advanceTimersByTimeAsync(20)
        await session.pushAudio(frame("loud", 20))
      }
      for (let t = 0; t < 3000; t += 20) {
        await vi.advanceTimersByTimeAsync(20)
        await session.pushAudio(frame("quiet", 20))
      }
      expect(brain).not.toHaveBeenCalled()
      const done = session.commit()
      await vi.advanceTimersByTimeAsync(200)
      await done
      expect(brain).toHaveBeenCalledTimes(1)
      expect(events.filter(e => e.type === "complete")).toHaveLength(1)
      await session.close()
    })

    it("with the local VAD on, commit() is a no-op", async () => {
      const { emit } = recorder([])
      const brain = vi.fn(() => words("Une réponse. "))
      const session = await startCascade({ emit, hooks: {}, stt: makeFakeStt(), tts: makeFakeTts(), vad: { silenceEndMs: SILENCE }, brain })
      await session.commit()
      expect(brain).not.toHaveBeenCalled()
      await session.close()
    })
  })

  describe("STT", () => {
    it("falls back to file transcription with the kept audio when the stream gives no final", async () => {
      const { events, emit } = recorder([])
      const stt = makeFakeStt({ silent: true, finals: ["depuis le fichier"] })
      const session = await startCascade({
        emit,
        hooks: {},
        stt,
        tts: makeFakeTts(),
        sttFinalTimeoutMs: 100,
        vad: { silenceEndMs: SILENCE },
        brain: () => words("Réponse complète. "),
      })
      await speak(session, 200, SILENCE + 400)
      expect(stt.transcribed).toHaveLength(1)
      expect(stt.transcribed[0]!.sampleRate).toBe(SR)
      expect(stt.transcribed[0]!.bytes).toBeGreaterThan(0)
      expect(events.find(e => e.type === "user")?.text).toBe("depuis le fichier:true")
      await session.close()
    })

    it("a file-only STT provider works with no stream", async () => {
      const { events, emit } = recorder([])
      const stt = makeFakeStt({ streaming: false, finals: ["fichier seul"] })
      const session = await startCascade({ emit, hooks: {}, stt, tts: makeFakeTts(), vad: { silenceEndMs: SILENCE }, brain: () => words("Réponse complète. ") })
      await speak(session)
      expect(stt.streams).toHaveLength(0)
      expect(events.find(e => e.type === "user")?.text).toBe("fichier seul:true")
      await session.close()
    })

    it("a stream that cannot open falls back to file transcription instead of failing the call", async () => {
      const { events, emit } = recorder([])
      const stt = makeFakeStt({ openFails: true, finals: ["quand même"] })
      const session = await startCascade({ emit, hooks: {}, stt, tts: makeFakeTts(), vad: { silenceEndMs: SILENCE }, brain: () => words("Réponse complète. ") })
      await speak(session)
      expect(events.find(e => e.type === "user")?.text).toBe("quand même:true")
      await session.close()
    })
  })

  describe("brain", () => {
    it("a stalled brain is abandoned by the guard and speaks the product's failure text", async () => {
      const { events, emit } = recorder([])
      const tts = makeFakeTts()
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt(),
        tts,
        vad: { silenceEndMs: SILENCE },
        brainGuards: { firstChunkMs: 300 },
        failureText: "Désolé, un souci.",
        brain: async function* () {
          await new Promise(() => undefined)
          yield "jamais"
        },
      })
      await speak(session, 200, SILENCE + 600)
      expect(tts.streams.map(s => s.texts.join(""))).toContain("Désolé, un souci.")
      expect(events.some(e => e.type === "error")).toBe(false)
      await session.close()
    })

    it("hooks.onTranscript receives each final turn", async () => {
      const { emit } = recorder([])
      const turns: Array<{ role: string; text: string }> = []
      const session = await startCascade({
        emit,
        hooks: { onTranscript: async t => void turns.push({ role: t.role, text: t.text }) },
        stt: makeFakeStt({ finals: ["salut"] }),
        tts: makeFakeTts(),
        vad: { silenceEndMs: SILENCE },
        brain: () => words("Une réponse complète. "),
      })
      await speak(session)
      expect(turns.map(t => t.role)).toEqual(["user", "assistant"])
      expect(turns[0]!.text).toBe("salut")
      await session.close()
    })
  })

  describe("TTS modes", () => {
    it("continuous mode feeds one stream per reply the raw text", async () => {
      const { emit } = recorder([])
      const tts = makeFakeTts()
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt(),
        tts,
        ttsMode: "continuous",
        vad: { silenceEndMs: SILENCE },
        brain: () => words("Première partie, ", "seconde partie."),
      })
      await speak(session)
      expect(tts.streams).toHaveLength(1)
      expect(tts.streams[0]!.texts.join("")).toBe("Première partie, seconde partie.")
      await session.close()
    })

    it("continuous mode keeps text that arrives before the stream has opened, in order", async () => {
      const { emit } = recorder([])
      const tts = makeFakeTts({ openDelayMs: 200 })
      const session = await startCascade({
        emit,
        hooks: {},
        stt: makeFakeStt(),
        tts,
        ttsMode: "continuous",
        vad: { silenceEndMs: SILENCE },
        brain: () => words("Début de phrase, ", "milieu, ", "fin."),
      })
      await speak(session, 200, SILENCE + 400)
      expect(tts.streams).toHaveLength(1)
      expect(tts.streams[0]!.texts.join("")).toBe("Début de phrase, milieu, fin.")
      await session.close()
    })

    it("a file-only TTS provider speaks through synthesize()", async () => {
      const { events, emit } = recorder([])
      const tts = makeFakeTts({ streaming: false })
      const session = await startCascade({ emit, hooks: {}, stt: makeFakeStt(), tts, vad: { silenceEndMs: SILENCE }, brain: () => words("Une phrase complète. ") })
      await speak(session)
      expect(tts.synthesized).toEqual(["Une phrase complète."])
      expect(events.some(e => e.type === "audio")).toBe(true)
      await session.close()
    })

    it("continuous mode is refused for a provider that cannot take chunked input", async () => {
      const { emit } = recorder([])
      const tts = makeFakeTts()
      ;(tts.capabilities as { chunkedInput: boolean }).chunkedInput = false
      await expect(
        startCascade({ emit, hooks: {}, stt: makeFakeStt(), tts, ttsMode: "continuous", brain: () => words("x") }),
      ).rejects.toThrow(/chunked input/)
    })
  })

  it("rejects a frame at another sample rate with an error event instead of corrupting the VAD", async () => {
    const { events, emit } = recorder([])
    const session = await startCascade({ emit, hooks: {}, stt: makeFakeStt(), tts: makeFakeTts(), brain: () => words("x") })
    await session.pushAudio({ pcm16: new Int16Array(160).buffer, sampleRate: 8000, sequenceNumber: 0 })
    expect(events.find(e => e.type === "error")?.text).toMatch(/Hz/)
    await session.close()
  })

  it("uses the kit defaults for VAD silence when none is given", async () => {
    // 700 ms is the kit default (the 550 ms of one deployment stays with that deployment).
    expect(VOICE_DEFAULTS.cascade.vad.silenceEndMs.value).toBeGreaterThan(550)
    const { events, emit } = recorder([])
    const session = await startCascade({ emit, hooks: {}, stt: makeFakeStt(), tts: makeFakeTts(), brain: () => words("Une réponse complète. ") })
    await speak(session, 200, VOICE_DEFAULTS.cascade.vad.silenceEndMs.value - 100)
    expect(events.some(e => e.type === "user")).toBe(false)
    await speak(session, 0, 300)
    expect(events.some(e => e.type === "user")).toBe(true)
    await session.close()
  })
})

void feed
