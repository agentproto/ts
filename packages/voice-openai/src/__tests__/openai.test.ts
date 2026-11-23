import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { VOICE_DEFAULTS, type AudioFrame, type VoiceEmit, type VoiceSession } from "@agentproto/voice"
import {
  makeReplayFetch,
  makeReplaySocket,
  scanForSecrets,
  sessionConformanceCases,
  sttConformanceCases,
  ttsConformanceCases,
  type RecordedExchange,
  type RecordedHttpExchange,
  type RecordedWsExchange,
} from "@agentproto/voice/testing"
import openaiDefault, { createOpenAIProvider, makeOpenAIRealtime, makeOpenAIStt, makeOpenAITts, wavFromPcm16 } from "../index.js"

const D = VOICE_DEFAULTS.providers.openai
const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const load = <T extends RecordedExchange>(name: string): T => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as T
const KEY = "test-key-not-a-secret"

describe("recorded fixtures", () => {
  const files = readdirSync(dir).filter(f => f.endsWith(".json"))
  it("has the recorded exchanges", () => {
    expect(files.sort()).toEqual(["realtime-ws.json", "stt-file.json", "tts-http.json"])
  })
  it("holds no key, no authorization header, no account or session identifier", () => {
    // Exact live values too, when the recording process environment is present.
    const live = [process.env.OPENAI_API_KEY].filter((v): v is string => !!v)
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8")
      expect(scanForSecrets(text, live), f).toEqual([])
    }
  })
  it("states that audio was truncated, and is small enough to commit", () => {
    for (const f of files) {
      const ex = JSON.parse(readFileSync(join(dir, f), "utf8"))
      if (ex.kind === "ws") {
        expect(ex.audioTruncatedTo).toBeGreaterThan(0)
        // "delta" carries audio in the Realtime protocol, so it is cut too.
        for (const fr of ex.frames as Array<{ dir: string; data: { type?: string; delta?: string; audio?: string } }>) {
          for (const v of [fr.data.delta, fr.data.audio]) if (typeof v === "string") expect(v.length).toBeLessThanOrEqual(ex.audioTruncatedTo)
        }
      }
      expect(readFileSync(join(dir, f)).byteLength).toBeLessThan(80_000)
    }
  })
})

describe("provider declaration", () => {
  it("declares the three stages, the key variable and the historical STT value", () => {
    const p = createOpenAIProvider()
    expect(p.slug).toBe("openai")
    expect(p.env.apiKey).toBe("OPENAI_API_KEY")
    expect(Object.keys(p.capabilities).sort()).toEqual(["realtime", "stt", "tts"])
    // "whisper" is the historical VOICE_STT_PROVIDER.
    expect(p.valueAliases.stt).toEqual(["whisper"])
    expect(p.realtime!.capabilities.id).toBe("openai-realtime")
    expect(openaiDefault.slug).toBe("openai")
  })
  it("exposes the model it synthesizes with, the configured one over the default", () => {
    expect(makeOpenAITts().model).toBe("gpt-4o-mini-tts")
    expect(makeOpenAITts({ modelId: "tts-1" }).model).toBe("tts-1")
  })
  it("refuses to open anything without a key, naming the variable", async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      await expect(makeOpenAITts().synthesize({ text: "x" })).rejects.toThrow(/OPENAI_API_KEY/)
      await expect(makeOpenAIStt().transcribe({ bytes: new Uint8Array(4), mimeType: "audio/wav" })).rejects.toThrow(/OPENAI_API_KEY/)
      await expect(makeOpenAIRealtime().start({ emit: noopEmit(), hooks: {} })).rejects.toThrow(/OPENAI_API_KEY/)
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved
    }
  })
  it("has no streaming STT or TTS endpoint: openStream names the alternative", async () => {
    await expect(makeOpenAIStt({ apiKey: KEY }).openStream({ sampleRate: D.ttsSampleRate.value })).rejects.toThrow(/realtime session/)
    await expect(makeOpenAITts({ apiKey: KEY }).openStream({})).rejects.toThrow(/realtime session/)
  })
})

describe("TTS over recorded HTTP", () => {
  const ex = load<RecordedHttpExchange>("tts-http")
  const TEXT = (ex.request.body as { input: string }).input

  it("synthesizes PCM at the default rate, with the model, voice and format from the defaults", async () => {
    const { fetch: f, requests } = makeReplayFetch([ex])
    const tts = makeOpenAITts({ apiKey: KEY, fetch: f })
    const r = await tts.synthesize({ text: TEXT })
    expect(r.mimeType).toBe("audio/pcm")
    expect(r.bytes.byteLength).toBeGreaterThan(0)
    expect(r.bytes.byteLength % 2).toBe(0)
    expect(r.durationSeconds).toBeCloseTo(r.bytes.byteLength / 2 / D.ttsSampleRate.value, 5)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(ex.request.url)
    expect(requests[0]!.body).toEqual(ex.request.body)
  })
  it("honors a per call voiceId over the default", async () => {
    const { fetch: f, requests } = makeReplayFetch([ex])
    const tts = makeOpenAITts({ apiKey: KEY, fetch: f })
    await tts.synthesize({ text: "x", voiceId: "verse" })
    expect((requests[0]!.body as { voice: string }).voice).toBe("verse")
  })
  it("turns an HTTP error into an error that names the status and not the key", async () => {
    const tts = makeOpenAITts({ apiKey: KEY, fetch: (async () => new Response("quota exceeded", { status: 401 })) as typeof fetch })
    await expect(tts.synthesize({ text: "x" })).rejects.toThrow(/401/)
    await expect(tts.synthesize({ text: "x" })).rejects.not.toThrow(new RegExp(KEY))
  })

  for (const c of ttsConformanceCases(makeOpenAITts({ apiKey: KEY, fetch: makeReplayFetch([ex]).fetch }))) {
    it(`conformance: ${c.name}`, c.run)
  }
})

describe("Whisper over recorded HTTP", () => {
  const ex = load<RecordedHttpExchange>("stt-file")

  it("transcribes a WAV file with the file model and the language from the call", async () => {
    const { fetch: f, requests } = makeReplayFetch([ex])
    const stt = makeOpenAIStt({ apiKey: KEY, fetch: f })
    const r = await stt.transcribe({ bytes: wavFromPcm16(new Uint8Array(48000), D.ttsSampleRate.value), mimeType: "audio/wav" }, { language: "fr" })
    expect(r.text).toBe((ex.response.body as { text: string }).text)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(ex.request.url)
    const form = requests[0]!.body as FormData
    expect(form.get("model")).toBe(D.sttFileModel.value)
    expect(form.get("response_format")).toBe("json")
    expect(form.get("language")).toBe("fr")
    const file = form.get("file") as File
    expect(file.type).toBe("audio/wav")
    expect(file.name).toBe("audio.wav")
  })
  it("maps an mpeg mime type to the mp3 file name the API picks the format from", async () => {
    const { fetch: f, requests } = makeReplayFetch([ex])
    const stt = makeOpenAIStt({ apiKey: KEY, fetch: f })
    await stt.transcribe({ bytes: new Uint8Array(480), mimeType: "audio/mpeg" })
    const file = (requests[0]!.body as FormData).get("file") as File
    expect(file.name).toBe("audio.mp3")
    expect(file.type).toBe("audio/mpeg")
  })
  it("requires sampleRate for raw PCM", async () => {
    const stt = makeOpenAIStt({ apiKey: KEY, fetch: makeReplayFetch([ex]).fetch })
    await expect(stt.transcribe({ bytes: new Uint8Array(4), mimeType: "audio/pcm" })).rejects.toThrow(/sampleRate/)
  })
  it("wavFromPcm16 writes a valid mono PCM16 header", () => {
    const wav = wavFromPcm16(new Uint8Array(10), 16000)
    const b = Buffer.from(wav)
    expect(b.toString("ascii", 0, 4)).toBe("RIFF")
    expect(b.toString("ascii", 8, 12)).toBe("WAVE")
    expect(b.readUInt16LE(22)).toBe(1)
    expect(b.readUInt32LE(24)).toBe(16000)
    expect(b.readUInt32LE(40)).toBe(10)
    expect(b.byteLength).toBe(54)
  })
  it("turns an HTTP error into an error that names the status and not the key", async () => {
    const stt = makeOpenAIStt({ apiKey: KEY, fetch: (async () => new Response("nope", { status: 429 })) as typeof fetch })
    await expect(stt.transcribe({ bytes: new Uint8Array(4), mimeType: "audio/wav" })).rejects.toThrow(/429/)
    await expect(stt.transcribe({ bytes: new Uint8Array(4), mimeType: "audio/wav" })).rejects.not.toThrow(new RegExp(KEY))
  })

  for (const c of sttConformanceCases(
    makeOpenAIStt({ apiKey: KEY, fetch: makeReplayFetch([ex]).fetch }),
    { sampleRate: D.ttsSampleRate.value, frames: [{ pcm16: new Int16Array(4800).buffer, sampleRate: D.ttsSampleRate.value, sequenceNumber: 0 }] },
  )) {
    it(`conformance: ${c.name}`, c.run)
  }
})

describe("Realtime on the recorded full turn", () => {
  const ex = load<RecordedWsExchange>("realtime-ws")
  const appends = ex.frames.filter(f => f.dir === "out" && (f.data as { type?: string }).type === "input_audio_buffer.append").length
  const PROMPT = ((ex.frames[0]!.data as { session: { instructions?: string } }).session.instructions ?? "")
  const audioDeltas = ex.frames.filter(
    f => f.dir === "in" && ["response.audio.delta", "response.output_audio.delta"].includes((f.data as { type: string }).type),
  ).length
  const transcriptDeltas = ex.frames.filter(
    f => f.dir === "in" && ["response.audio_transcript.delta", "response.output_audio_transcript.delta"].includes((f.data as { type: string }).type),
  ).length
  const userText = ((ex.frames.find(
    f => f.dir === "in" && (f.data as { type: string }).type === "conversation.item.input_audio_transcription.completed",
  )!.data as { transcript: string }).transcript)
  const errors = ex.frames.filter(f => f.dir === "in" && (f.data as { type: string }).type === "error").length
  const doneUsage = ((ex.frames.find(f => f.dir === "in" && (f.data as { type: string }).type === "response.done")!.data as { response: { usage?: Record<string, unknown> } }).response.usage)!

  it("the recording holds a full turn, with its benign VAD race errors", () => {
    // Guard for the drive below: the fixture records exactly one full turn.
    expect(appends).toBeGreaterThan(0)
    expect(errors).toBeGreaterThan(0)
    expect(userText.length).toBeGreaterThan(0)
  })

  it("replays the recorded turn: session.update from the defaults, appends, commit, one completion", async () => {
    const spy = emitSpy()
    let resolveDone!: () => void
    let complete = 0
    const done = new Promise<void>(r => { resolveDone = r })
    const emit: VoiceEmit = {
      ...spy.emit,
      responseComplete: () => { spy.emit.responseComplete(); complete++; resolveDone() },
    }
    const replay = makeReplaySocket(ex)
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: replay.factory }).start({
      emit,
      hooks: { getSystemPrompt: async () => PROMPT },
    })
    await tick()
    // Drive the recorded exchange: the provider was built against this API,
    // so it sends exactly the frames the recording holds, in order.
    for (let i = 0; i < appends; i++) {
      session.pushAudio({ pcm16: new Int16Array(2400).buffer, sampleRate: D.realtimeSampleRate.value, sequenceNumber: i })
    }
    await session.commit()
    const finished = await withTimeout(done, 2000)
    expect(finished).toBe(true)
    expect(replay.mismatches).toEqual([])
    expect(replay.done()).toBe(true)
    expect(replay.urls[0]).toContain(`model=${D.realtimeModel.value}`)
    expect(complete).toBe(1)
    expect(spy.ev.filter(e => e === "interrupt")).toHaveLength(0)
    expect(spy.ev.filter(e => e === "error")).toHaveLength(errors)
    const audio = spy.detail.audio as AudioFrame[]
    expect(audio).toHaveLength(audioDeltas)
    expect(audio.every(f => f.sampleRate === D.realtimeSampleRate.value)).toBe(true)
    expect(audio.every(f => f.pcm16.byteLength % 2 === 0)).toBe(true)
    expect(audio.every((f, i) => f.sequenceNumber === i)).toBe(true)
    const user = spy.detail.user as Array<[string, boolean]>
    expect(user).toEqual([[userText, true]])
    const assistant = spy.detail.assistant as Array<[string, boolean]>
    expect(assistant.filter(([, fin]) => !fin)).toHaveLength(transcriptDeltas)
    expect(assistant.filter(([, fin]) => fin)).toHaveLength(1)
    // Usage: tokens from response.done, mapped onto the kit's buckets; audio seconds from pushAudio.
    const usage = session.getUsage!()!
    expect(usage.engine).toBe("realtime")
    const entry = usage.entries.find(e => e.stage === "realtime")!
    expect(entry.provider).toBe("openai")
    expect(entry.model).toBe(D.realtimeModel.value)
    expect(entry.audioSeconds).toBeGreaterThan(0)
    const num = (v: unknown) => (typeof v === "number" ? v : 0)
    const inDet = (doneUsage.input_token_details ?? {}) as Record<string, unknown>
    const outDet = (doneUsage.output_token_details ?? {}) as Record<string, unknown>
    // GA shape: the breakdown lives under cached_tokens_details.
    const cachedDetails = (inDet.cached_tokens_details ?? {}) as Record<string, unknown>
    expect(entry.tokens).toEqual({
      audioIn: num(inDet.audio_tokens),
      audioOut: num(outDet.audio_tokens),
      textIn: Math.max(0, num(doneUsage.input_tokens) - num(inDet.audio_tokens)),
      textOut: Math.max(0, num(doneUsage.output_tokens) - num(outDet.audio_tokens)),
      cachedAudioIn: num(cachedDetails.audio_tokens),
      cachedTextIn: num(cachedDetails.text_tokens),
    })
    expect(entry.tokens!.audioOut).toBeGreaterThan(0)
    await session.close()
  })

  it("puts the key in the header, never in the URL or in a frame", async () => {
    const inner = makeReplaySocket(ex).factory
    let url = ""
    let headers: Record<string, string> | undefined
    const sent: string[] = []
    const socket = (u: string, init?: { headers?: Record<string, string> }) => {
      url = u
      headers = init?.headers
      const s = inner(u, init)
      const raw = s.send.bind(s)
      s.send = d => (sent.push(String(d)), raw(d))
      return s
    }
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket }).start({ emit: noopEmit(), hooks: {} })
    await tick()
    expect(url).toContain(`model=${D.realtimeModel.value}`)
    expect(url).not.toContain(KEY)
    expect(headers).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(sent.join("\n")).not.toContain(KEY)
    await session.close()
  })

  it("the recorded session.update carries the defaults and the recorded prompt", () => {
    const su = ex.frames[0]!.data as { type: string; session: Record<string, unknown> }
    const s = su.session
    expect(su.type).toBe("session.update")
    expect(s.type).toBe("realtime")
    expect(s.model).toBe(D.realtimeModel.value)
    expect(s.instructions).toBe(PROMPT)
    const audio = s.audio as { input: { format: { type: string; rate: number }; transcription: { model: string }; turn_detection: Record<string, unknown> }; output: { format: { rate: number }; voice: string } }
    expect(audio.input.format).toEqual({ type: "audio/pcm", rate: D.realtimeSampleRate.value })
    expect(audio.input.transcription.model).toBe(D.realtimeInputTranscription.value)
    expect(audio.input.turn_detection).toEqual({ type: D.realtimeVad.value.type, threshold: D.realtimeVad.value.threshold, silence_duration_ms: D.realtimeVad.value.silenceMs })
    expect(audio.output.format.rate).toBe(D.realtimeSampleRate.value)
    expect(audio.output.voice).toBe(D.realtimeVoice.value)
  })
})

// The barge-in was never captured in a recording (two real attempts ended in a
// completed response: the short test turn finishes before the burst lands, see
// scripts/record.mjs), so the interrupted case and the rest of the session
// behavior run on scripted protocol frames, written from the wire described in
// realtime.ts and from the recorded full turn above.
describe("Realtime, scripted protocol frames", () => {
  const mkSocket = () => {
    const sent: Array<Record<string, unknown>> = []
    const listeners: { open: Array<() => void>; message: Array<(d: string) => void>; close: Array<(c?: number) => void> } = { open: [], message: [], close: [] }
    let url = ""
    let headers: Record<string, string> | undefined
    let closed = false
    const factory = (u: string, init?: { headers?: Record<string, string> }) => {
      url = u
      headers = init?.headers
      queueMicrotask(() => listeners.open.forEach(cb => cb()))
      return {
        send: (d: string | Uint8Array) => void sent.push(JSON.parse(String(d))),
        close: (c?: number) => { closed = true; listeners.close.forEach(cb => cb(c ?? 1000)) },
        on: (e: string, cb: never) => { if (e in listeners) (listeners as Record<string, unknown[]>)[e]!.push(cb) },
      }
    }
    return { factory: factory as never, sent, serve: (m: unknown) => listeners.message.forEach(cb => cb(JSON.stringify(m))), url: () => url, headers: () => headers, isClosed: () => closed }
  }

  it("opens with a session.update built from the defaults, and without instructions when there is no prompt", async () => {
    const s = mkSocket()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {} })
    await tick()
    expect(session.engine).toBe("realtime")
    expect(session.capabilities).toEqual({ serverVad: true, interruption: true, functionCalling: true, say: false, languages: [] })
    expect(s.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        type: "realtime",
        model: D.realtimeModel.value,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: D.realtimeSampleRate.value },
            transcription: { model: D.realtimeInputTranscription.value },
            turn_detection: { type: D.realtimeVad.value.type, threshold: D.realtimeVad.value.threshold, silence_duration_ms: D.realtimeVad.value.silenceMs },
          },
          output: { format: { type: "audio/pcm", rate: D.realtimeSampleRate.value }, voice: D.realtimeVoice.value },
        },
      },
    })
    expect((s.sent[0] as { session: Record<string, unknown> }).session.instructions).toBeUndefined()
    await session.close()
  })

  it("attaches an async getSystemPrompt and the language to the session", async () => {
    const s = mkSocket()
    await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({
      emit: emitSpy().emit,
      hooks: { getSystemPrompt: async () => "You are a helpful voice concierge." },
      language: "fr",
    })
    await tick()
    expect(s.sent[0]).toMatchObject({ type: "session.update", session: { instructions: "You are a helpful voice concierge.", audio: { input: { transcription: { model: D.realtimeInputTranscription.value, language: "fr" } } } } })
  })

  it("still starts when getSystemPrompt rejects, without instructions", async () => {
    const s = mkSocket()
    await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({
      emit: emitSpy().emit,
      hooks: { getSystemPrompt: async () => { throw new Error("no prompt") } },
    })
    await tick()
    expect(s.sent[0]).toMatchObject({ type: "session.update" })
    expect((s.sent[0] as { session: Record<string, unknown> }).session.instructions).toBeUndefined()
  })

  it("pushAudio sends base64 appends and counts the audio seconds in the usage record", async () => {
    const s = mkSocket()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {} })
    await tick()
    session.pushAudio({ pcm16: new Int16Array(16000).buffer, sampleRate: 16000, sequenceNumber: 0 })
    const append = s.sent.find(m => m.type === "input_audio_buffer.append")
    expect(append).toBeTruthy()
    expect(Buffer.from(String(append!.audio), "base64").byteLength).toBe(32000)
    const entry = session.getUsage!()!.entries.find(e => e.stage === "realtime")!
    expect(entry.provider).toBe("openai")
    expect(entry.audioSeconds).toBe(1)
    await session.close()
    session.pushAudio({ pcm16: new Int16Array(16000).buffer, sampleRate: 16000, sequenceNumber: 1 })
    expect(session.getUsage!()!.entries.find(e => e.stage === "realtime")!.audioSeconds).toBe(1)
  })

  it("commit() and pushText() send the documented frames", async () => {
    const s = mkSocket()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {} })
    await tick()
    const before = s.sent.length
    await session.commit()
    expect(s.sent.slice(before).map(m => m.type)).toEqual(["input_audio_buffer.commit", "response.create"])
    await session.pushText!("Bonjour")
    expect(s.sent.slice(before + 2)).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Bonjour" }] } },
      { type: "response.create" },
    ])
  })

  it("refreshTools() sends a fresh session.update with the tools and tool_choice", async () => {
    const s = mkSocket()
    let calls = 0
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({
      emit: emitSpy().emit,
      hooks: {
        getTools: async () => { calls++; return [{ name: "lookup", description: "Look a thing up", parameters: { type: "object", properties: {} } }] },
        getSystemPrompt: async () => "prompt one",
      },
    })
    await tick()
    expect((s.sent[0] as { session: { tools?: unknown[] } }).session.tools).toEqual([{ type: "function", name: "lookup", description: "Look a thing up", parameters: { type: "object", properties: {} } }])
    expect((s.sent[0] as { session: { tool_choice?: string } }).session.tool_choice).toBe("auto")
    s.sent.length = 0
    await session.refreshTools!()
    expect(calls).toBe(2)
    expect(s.sent.filter(m => m.type === "session.update")).toHaveLength(1)
  })

  it("a manual interrupt() cancels, clears and emits interrupt once per response", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    s.serve({ type: "response.created" })
    await session.interrupt()
    expect(spy.ev.filter(e => e === "interrupt")).toHaveLength(1)
    expect(s.sent.filter(m => m.type === "response.cancel")).toHaveLength(1)
    expect(s.sent.filter(m => m.type === "input_audio_buffer.clear")).toHaveLength(1)
    await session.interrupt()
    expect(spy.ev.filter(e => e === "interrupt")).toHaveLength(1)
    expect(spy.ev).not.toContain("complete")
  })

  it("server VAD barge-in: speech_started during an active response cuts the turn, no audio after it", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    await tick()
    s.serve({ type: "response.created" })
    s.serve({ type: "response.output_audio.delta", delta: Buffer.alloc(320).toString("base64") })
    s.serve({ type: "input_audio_buffer.speech_started" })
    s.serve({ type: "response.output_audio.delta", delta: Buffer.alloc(320).toString("base64") })
    s.serve({ type: "response.output_audio_transcript.delta", delta: "never" })
    s.serve({ type: "response.done", response: { status: "cancelled" } })
    await tick()
    expect(spy.ev.filter(e => e === "interrupt")).toHaveLength(1)
    expect(spy.ev.filter(e => e === "audio")).toHaveLength(1)
    expect(((spy.detail.assistant ?? []) as Array<[string, boolean]>).filter(([t]) => t === "never")).toHaveLength(0)
    expect(spy.ev).not.toContain("complete")
    // The buffer restarts cleanly for the next turn.
    s.serve({ type: "response.created" })
    s.serve({ type: "response.output_audio.delta", delta: Buffer.alloc(320).toString("base64") })
    s.serve({ type: "response.done", response: { status: "completed" } })
    await tick()
    expect(spy.ev.filter(e => e === "audio")).toHaveLength(2)
    expect(spy.ev.filter(e => e === "interrupt")).toHaveLength(1)
    expect(spy.ev.filter(e => e === "complete")).toHaveLength(1)
    await session.close()
  })

  it("a cancelled response that never saw speech_started still emits interrupt, never complete", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    s.serve({ type: "response.created" })
    s.serve({ type: "response.done", response: { status: "cancelled" } })
    await tick()
    expect(spy.ev).toEqual(["interrupt"])
    await session.close()
  })

  it("maps the input transcription to a final user transcript and calls the hook", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const transcripts: Array<{ role: string; text: string; finalized: boolean }> = []
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({
      emit: spy.emit,
      hooks: { onTranscript: async t => { transcripts.push({ role: t.role, text: t.text, finalized: t.finalizedAt > 0 }) } },
    })
    s.serve({ type: "conversation.item.input_audio_transcription.completed", transcript: "Bonjour, ceci est un test." })
    await tick()
    expect(spy.detail.user).toEqual([["Bonjour, ceci est un test.", true]])
    expect(transcripts).toEqual([{ role: "user", text: "Bonjour, ceci est un test.", finalized: true }])
    await session.close()
  })

  it("answers a function call from response.done through the host hook and returns the value", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({
      emit: spy.emit,
      hooks: { onToolCall: async (name, args) => { if (name === "boom") throw new Error("nope"); return { ok: true, args } } },
    })
    s.serve({
      type: "response.done",
      response: { status: "completed", output: [
        { type: "function_call", call_id: "c1", name: "lookup", arguments: "{\"q\":1}" },
        { type: "function_call", call_id: "c2", name: "boom", arguments: "{}" },
      ] },
    })
    await tick()
    expect(spy.detail["tool.start"]).toEqual([["lookup", { q: 1 }], ["boom", {}]])
    expect(s.sent).toContainEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ ok: true, args: { q: 1 } }) } })
    expect(s.sent).toContainEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c2", output: JSON.stringify({ error: "nope" }) } })
    expect(s.sent.filter(m => m.type === "response.create").length).toBeGreaterThanOrEqual(2)
    expect(spy.ev).not.toContain("error")
    // A tool-call-only response did not speak: it must not complete the turn
    // nor finalize an empty assistant transcript.
    expect(spy.ev).not.toContain("complete")
    expect(spy.detail.assistant).toBeUndefined()
    await session.close()
  })

  it("the tool-call response does not emit responseComplete; the spoken response after the tool result emits exactly one", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({
      emit: spy.emit,
      hooks: { onToolCall: async () => "done" },
    })
    s.serve({ type: "response.created" })
    s.serve({
      type: "response.done",
      response: { status: "completed", output: [{ type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" }] },
    })
    await tick()
    // The old code emitted complete + an empty final transcript here,
    // before the tool result even came back.
    expect(spy.ev.filter(e => e === "complete")).toHaveLength(0)
    expect(spy.detail.assistant).toBeUndefined()
    expect(s.sent.filter(m => m.type === "response.create").length).toBeGreaterThanOrEqual(1)
    // ... then the real spoken response arrives after the tool result.
    s.serve({ type: "response.created" })
    s.serve({ type: "response.audio_transcript.delta", delta: "Voila le resultat." })
    s.serve({ type: "response.done", response: { status: "completed", output: [{ type: "message" }] } })
    await tick()
    expect(spy.ev.filter(e => e === "complete")).toHaveLength(1)
    const assistant = spy.detail.assistant as Array<[string, boolean]>
    expect(assistant).toEqual([["Voila le resultat.", false], ["Voila le resultat.", true]])
    await session.close()
  })

  it("maps GA usage: the cached breakdown comes from input_token_details.cached_tokens_details", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    s.serve({
      type: "response.done",
      response: {
        status: "completed",
        output: [{ type: "message" }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          input_token_details: {
            audio_tokens: 60,
            text_tokens: 40,
            cached_tokens: 12,
            cached_tokens_details: { audio_tokens: 8, text_tokens: 4 },
          },
          output_token_details: { audio_tokens: 30, text_tokens: 20 },
        },
      },
    })
    await tick()
    const usage = session.getUsage!()!
    const entry = usage.entries.find(e => e.stage === "realtime")!
    expect(entry.tokens).toEqual({
      audioIn: 60,
      audioOut: 30,
      textIn: 40, // 100 input - 60 audio; cached audio is already inside audioIn
      textOut: 20,
      cachedAudioIn: 8,
      cachedTextIn: 4,
    })
    await session.close()
  })

  it("a function call whose arguments are not JSON reports bad_arguments", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    s.serve({ type: "response.done", response: { status: "completed", output: [{ type: "function_call", call_id: "c1", name: "lookup", arguments: "not json" }] } })
    await tick()
    expect(spy.detail["tool.end"]).toEqual([["lookup", expect.objectContaining({ error: expect.stringMatching(/JSON|token/i) })]])
    expect(s.sent).toContainEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ error: "bad_arguments" }) } })
    await session.close()
  })

  it("also dispatches a function call announced by response.function_call_arguments.done", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: { onToolCall: async () => "done" } })
    s.serve({ type: "response.function_call_arguments.done", call_id: "c9", name: "later", arguments: "{}" })
    await tick()
    expect(spy.detail["tool.end"]).toEqual([["later", "done"]])
    expect(s.sent).toContainEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c9", output: "done" } })
    await session.close()
  })

  it("dispatches a call reported by both arguments.done and response.done exactly once", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: { onToolCall: async () => "done" } })
    s.serve({ type: "response.function_call_arguments.done", call_id: "c9", name: "later", arguments: "{}" })
    s.serve({
      type: "response.done",
      response: { status: "completed", output: [{ type: "function_call", call_id: "c9", name: "later", arguments: "{}" }] },
    })
    await tick()
    expect(spy.detail["tool.end"]).toEqual([["later", "done"]])
    expect(s.sent.filter(m => m.type === "conversation.item.create" && (m.item as { call_id?: string }).call_id === "c9")).toHaveLength(1)
    expect(s.sent.filter(m => m.type === "response.create")).toHaveLength(1)
    await session.close()
  })

  it("interrupt() while no response is in flight only clears the buffer", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    await session.interrupt()
    expect(spy.ev).not.toContain("interrupt")
    expect(s.sent.filter(m => m.type === "response.cancel")).toHaveLength(0)
    expect(s.sent.filter(m => m.type === "input_audio_buffer.clear")).toHaveLength(1)
    await session.close()
  })

  it("an error event is an emit error that carries the server message", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    s.serve({ type: "error", error: { message: "committing an empty buffer" } })
    await tick()
    expect(spy.detail.error).toEqual(["openai realtime: committing an empty buffer"])
    await session.close()
  })

  it("close() is idempotent, sends nothing after, and closes the socket", async () => {
    const s = mkSocket()
    const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {} })
    await tick()
    await session.close()
    await session.close()
    expect(s.isClosed()).toBe(true)
    const before = s.sent.length
    session.pushAudio({ pcm16: new Int16Array(100).buffer, sampleRate: 16000, sequenceNumber: 0 })
    await session.commit()
    await session.interrupt()
    expect(s.sent.length).toBe(before)
  })

  it("passes AIP conformance cases on a scripted session", async () => {
    const harness = {
      start: async (emit: VoiceEmit) => {
        const s = mkSocket()
        const session = await makeOpenAIRealtime({ apiKey: KEY, socket: s.factory }).start({ emit, hooks: {} })
        ;(harness as unknown as { s: ReturnType<typeof mkSocket> }).s = s
        await tick()
        return session
      },
      completeTurn: async (session: VoiceSession) => {
        const s = (harness as unknown as { s: ReturnType<typeof mkSocket> }).s
        session.pushAudio({ pcm16: new Int16Array(1600).buffer, sampleRate: 16000, sequenceNumber: 0 })
        s.serve({ type: "response.created" })
        s.serve({ type: "response.output_audio.delta", delta: Buffer.alloc(320).toString("base64") })
        s.serve({ type: "conversation.item.input_audio_transcription.completed", transcript: "conformed" })
        s.serve({ type: "response.done", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5, input_token_details: { audio_tokens: 2 }, output_token_details: { audio_tokens: 3 } } } })
        await tick()
      },
      interruptedTurn: async () => {
        const s = (harness as unknown as { s: ReturnType<typeof mkSocket> }).s
        s.serve({ type: "response.created" })
        s.serve({ type: "response.output_audio.delta", delta: Buffer.alloc(320).toString("base64") })
        s.serve({ type: "input_audio_buffer.speech_started" })
        s.serve({ type: "response.done", response: { status: "cancelled" } })
        await tick()
      },
    }
    for (const c of sessionConformanceCases(harness)) await c.run()
  })
})

// ── helpers ─────────────────────────────────────────────────────────

function emitSpy() {
  const ev: string[] = []
  const detail: Record<string, unknown[]> = {}
  const note = (k: string, v?: unknown) => { ev.push(k); (detail[k] ??= []).push(v) }
  const emit: VoiceEmit = {
    audio: f => note("audio", f), userTranscript: (t, f) => note("user", [t, f]), assistantTranscript: (t, f) => note("assistant", [t, f]),
    toolCallStart: (n, a) => note("tool.start", [n, a]), toolCallEnd: (n, r) => note("tool.end", [n, r]),
    interrupt: () => note("interrupt"), responseComplete: () => note("complete"), error: e => note("error", e.message),
  }
  return { ev, detail, emit }
}
const tick = () => new Promise(r => setTimeout(r, 0))
const noopEmit = (): VoiceEmit => ({
  audio: () => {}, userTranscript: () => {}, assistantTranscript: () => {}, toolCallStart: () => {}, toolCallEnd: () => {},
  interrupt: () => {}, responseComplete: () => {}, error: () => {},
})
async function withTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  return await Promise.race([p.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))])
}
