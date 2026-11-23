import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { VOICE_DEFAULTS, type AudioFrame, type VoiceEmit } from "@agentproto/voice"
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
import elevenlabsDefault, { createElevenLabsProvider, isScribeHallucination, makeElevenLabsRealtime, makeElevenLabsStt, makeElevenLabsTts, wavFromPcm16 } from "../index.js"

const D = VOICE_DEFAULTS.providers.elevenlabs
const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const load = <T extends RecordedExchange>(name: string): T => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as T
const KEY = "test-key-not-a-secret"

describe("recorded fixtures", () => {
  const files = readdirSync(dir).filter(f => f.endsWith(".json"))
  it("has the recorded exchanges", () => {
    expect(files.sort()).toEqual(["stt-file.json", "stt-ws.json", "tts-http.json", "tts-ws.json"])
  })
  it("holds no key, no authorization header, no account or session identifier", () => {
    // Exact live values too, when the recording process environment is present.
    const live = [process.env.ELEVENLABS_API_KEY, process.env.ELEVENLABS_RECORD_AGENT_ID].filter((v): v is string => !!v)
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8")
      expect(scanForSecrets(text, live), f).toEqual([])
    }
  })
  it("states that audio was truncated, and is small enough to commit", () => {
    for (const f of files) {
      const ex = JSON.parse(readFileSync(join(dir, f), "utf8"))
      if (ex.kind === "ws") expect(ex.audioTruncatedTo).toBeGreaterThan(0)
      expect(readFileSync(join(dir, f)).byteLength).toBeLessThan(20_000)
    }
  })
})

describe("provider declaration", () => {
  it("declares the three stages, the key variable and the historical STT value", () => {
    const p = createElevenLabsProvider()
    expect(p.slug).toBe("elevenlabs")
    expect(p.env.apiKey).toBe("ELEVENLABS_API_KEY")
    expect(Object.keys(p.capabilities).sort()).toEqual(["realtime", "stt", "tts"])
    expect(p.valueAliases.stt).toEqual(["scribe"])
    expect(p.realtime!.capabilities.id).toBe("elevenlabs-s2s")
    expect(elevenlabsDefault.slug).toBe("elevenlabs")
  })
  it("refuses to open anything without a key, naming the variable", async () => {
    const saved = process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_API_KEY
    try {
      await expect(makeElevenLabsTts().synthesize({ text: "x" })).rejects.toThrow(/ELEVENLABS_API_KEY/)
    } finally {
      if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved
    }
  })
})

describe("TTS over the recorded stream-input WebSocket", () => {
  const ex = load<RecordedWsExchange>("tts-ws")

  it("replays the recorded exchange: same frames out, audio then done, PCM16 at the output rate", async () => {
    const replay = makeReplaySocket(ex)
    const tts = makeElevenLabsTts({ apiKey: KEY, socket: replay.factory })
    const stream = await tts.openStream({})
    const frames: AudioFrame[] = []
    const order: string[] = []
    await new Promise<void>(resolve => {
      stream.on("audio", f => (frames.push(f), order.push("audio")))
      stream.on("done", () => (order.push("done"), resolve()))
      stream.on("error", e => { throw e })
      stream.sendText("Bonjour, ")
      stream.sendText("ceci est un test.")
      stream.end()
    })
    expect(replay.mismatches).toEqual([])
    expect(replay.done()).toBe(true)
    expect(order[order.length - 1]).toBe("done")
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(f => f.sampleRate === Number(D.outputFormat.value.replace("pcm_", "")))).toBe(true)
    expect(frames.every(f => f.pcm16.byteLength % 2 === 0)).toBe(true)
    expect(replay.urls[0]).toContain(`model_id=${D.ttsModel.value}`)
    expect(replay.urls[0]).toContain(`output_format=${D.outputFormat.value}`)
  })

  it("puts the key in the header, never in the URL or in a frame", async () => {
    const headers: Array<Record<string, string> | undefined> = []
    const urls: string[] = []
    const sent: string[] = []
    const inner = makeReplaySocket(ex).factory
    const tts = makeElevenLabsTts({
      apiKey: KEY,
      socket: (url, init) => {
        urls.push(url)
        headers.push(init?.headers)
        const s = inner(url, init)
        const send = s.send.bind(s)
        s.send = d => (sent.push(String(d)), send(d))
        return s
      },
    })
    const stream = await tts.openStream({})
    stream.sendText("x")
    stream.end()
    await new Promise(r => setTimeout(r, 20))
    expect(headers[0]).toEqual({ "xi-api-key": KEY })
    expect(urls.join("\n")).not.toContain(KEY)
    expect(sent.join("\n")).not.toContain(KEY)
  })

  it("the initial frame carries the voice settings and chunk schedule from the defaults", () => {
    const init = ex.frames[0]!.data as { text: string; voice_settings: Record<string, unknown>; generation_config: { chunk_length_schedule: number[] } }
    expect(init.text).toBe(" ")
    expect(init.voice_settings).toEqual({ stability: D.stability.value, similarity_boost: D.similarityBoost.value, style: D.style.value, use_speaker_boost: D.useSpeakerBoost.value })
    expect(init.generation_config.chunk_length_schedule).toEqual([...D.chunkLengthSchedule.value])
  })

  it("cancel() closes the socket and delivers neither audio nor done afterwards", async () => {
    const replay = makeReplaySocket(ex, { releaseWhen: f => f.text === "" })
    const tts = makeElevenLabsTts({ apiKey: KEY, socket: replay.factory })
    const stream = await tts.openStream({})
    let after = 0
    let cancelled = false
    stream.on("audio", () => cancelled && after++)
    stream.on("done", () => cancelled && after++)
    stream.sendText("Bonjour.")
    stream.cancel()
    cancelled = true
    stream.end() // would release the recorded audio if it reached the socket
    await new Promise(r => setTimeout(r, 20))
    expect(after).toBe(0)
  })

  it("flush() sends the documented flush frame", async () => {
    const sent: unknown[] = []
    const inner = makeReplaySocket(ex, { releaseWhen: () => false }).factory
    const tts = makeElevenLabsTts({
      apiKey: KEY,
      socket: (u, i) => {
        const s = inner(u, i)
        const send = s.send.bind(s)
        s.send = d => (sent.push(JSON.parse(String(d))), send(d))
        return s
      },
    })
    const stream = await tts.openStream({})
    stream.sendText("Début. ")
    stream.flush()
    await new Promise(r => setTimeout(r, 5))
    expect(sent).toContainEqual({ text: " ", flush: true })
  })

  for (const c of ttsConformanceCases(
    makeElevenLabsTts({ apiKey: KEY, socket: (u, i) => makeReplaySocket(ex, { releaseWhen: f => f.text === "" }).factory(u, i), fetch: makeReplayFetch([load<RecordedHttpExchange>("tts-http")]).fetch }),
  )) {
    it(`conformance: ${c.name}`, c.run)
  }
})

describe("TTS over recorded HTTP", () => {
  const ex = load<RecordedHttpExchange>("tts-http")
  it("synthesizes PCM and sends the model, voice settings and format from the defaults", async () => {
    const { fetch: f, requests } = makeReplayFetch([ex])
    const tts = makeElevenLabsTts({ apiKey: KEY, fetch: f })
    const r = await tts.synthesize({ text: "Bonjour, ceci est un test de la voix." })
    expect(r.mimeType).toBe("audio/pcm")
    expect(r.bytes.byteLength).toBeGreaterThan(0)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain(`output_format=${D.outputFormat.value}`)
    expect(requests[0]!.body).toMatchObject({ model_id: D.ttsModel.value, voice_settings: { stability: D.stability.value } })
  })
  it("turns an HTTP error into an error that names the status and not the key", async () => {
    const tts = makeElevenLabsTts({ apiKey: KEY, fetch: (async () => new Response("quota exceeded", { status: 401 })) as typeof fetch })
    await expect(tts.synthesize({ text: "x" })).rejects.toThrow(/401/)
    await expect(tts.synthesize({ text: "x" })).rejects.not.toThrow(new RegExp(KEY))
  })
  it("refuses a non-PCM output format, since the voice kit speaks PCM", () => {
    expect(() => makeElevenLabsTts({ outputFormat: "mp3_44100_128" })).toThrow(/PCM/)
  })
})

describe("Scribe over the recorded realtime WebSocket", () => {
  const ex = load<RecordedWsExchange>("stt-ws")
  const audioOuts = ex.frames.filter(f => f.dir === "out" && (f.data as { commit?: boolean }).commit !== true)
  const finalText = (ex.frames.find(f => f.dir === "in" && (f.data as { message_type?: string }).message_type === "committed_transcript")!.data as { text: string }).text

  it("replays the recorded exchange and returns the recorded final after commit()", async () => {
    const replay = makeReplaySocket(ex)
    const stt = makeElevenLabsStt({ apiKey: KEY, socket: replay.factory })
    const stream = await stt.openStream({ sampleRate: 24000 })
    const partials: string[] = []
    const result = await new Promise<string>(resolve => {
      stream.on("partial", t => partials.push(t.text))
      stream.on("final", t => resolve(t.text))
      stream.on("error", e => resolve(`error: ${e.message}`))
      const frame = { pcm16: new Int16Array(4800).buffer, sampleRate: 24000, sequenceNumber: 0 }
      for (let i = 0; i < audioOuts.length; i++) stream.pushAudio({ ...frame, sequenceNumber: i })
      stream.commit()
    })
    expect(result).toBe(finalText)
    expect(replay.mismatches).toEqual([])
    expect(replay.urls[0]).toContain("commit_strategy=manual")
    expect(replay.urls[0]).toContain("audio_format=pcm_24000")
    expect(replay.urls[0]).toContain(`model_id=${D.sttModel.value}`)
  })

  it("drops a stock subtitle-credit hallucination: the final is delivered blank", async () => {
    const hallucinated: RecordedWsExchange = {
      ...ex,
      frames: ex.frames.map(f =>
        f.dir === "in" && (f.data as { message_type?: string }).message_type === "committed_transcript"
          ? { ...f, data: { message_type: "committed_transcript", text: "Sous-titres réalisés par la communauté d'Amara.org" } }
          : f,
      ),
    }
    const stt = makeElevenLabsStt({ apiKey: KEY, socket: makeReplaySocket(hallucinated, { releaseWhen: f => f.commit === true }).factory })
    const stream = await stt.openStream({ sampleRate: 24000 })
    const text = await new Promise<string>(resolve => {
      stream.on("final", t => resolve(t.text))
      stream.commit()
    })
    expect(text).toBe("")
  })

  it("the filter can be turned off", async () => {
    const f = (t: string): RecordedWsExchange => ({ ...ex, frames: [{ dir: "in", data: { message_type: "committed_transcript", text: t } }] })
    const stt = makeElevenLabsStt({ apiKey: KEY, filterHallucinations: false, socket: makeReplaySocket(f("Thanks for watching"), { releaseWhen: x => x.commit === true }).factory })
    const stream = await stt.openStream({ sampleRate: 24000 })
    const text = await new Promise<string>(resolve => {
      stream.on("final", t => resolve(t.text))
      stream.commit()
    })
    expect(text).toBe("Thanks for watching")
  })

  it("a scribe error frame is an error event", async () => {
    const bad: RecordedWsExchange = {
      ...ex,
      frames: [
        { dir: "out", data: { message_type: "input_audio_chunk", audio_base_64: "", commit: true } },
        { dir: "in", data: { message_type: "scribe_quota_exceeded_error", error: "quota" } },
      ],
    }
    const stt = makeElevenLabsStt({ apiKey: KEY, socket: makeReplaySocket(bad).factory })
    const stream = await stt.openStream({ sampleRate: 24000 })
    const err = await new Promise<Error>(resolve => {
      stream.on("error", resolve)
      stream.commit()
    })
    expect(err.message).toMatch(/quota/)
  })

  for (const c of sttConformanceCases(
    makeElevenLabsStt({ apiKey: KEY, socket: (u, i) => makeReplaySocket(ex, { releaseWhen: f => f.commit === true }).factory(u, i), fetch: makeReplayFetch([load<RecordedHttpExchange>("stt-file")]).fetch }),
    { sampleRate: 24000, frames: [{ pcm16: new Int16Array(4800).buffer, sampleRate: 24000, sequenceNumber: 0 }] },
  )) {
    it(`conformance: ${c.name}`, c.run)
  }
})

describe("Scribe over recorded HTTP", () => {
  const ex = load<RecordedHttpExchange>("stt-file")
  it("transcribes raw PCM as a WAV upload with the file model from the defaults", async () => {
    const { fetch: f, requests } = makeReplayFetch([ex])
    const stt = makeElevenLabsStt({ apiKey: KEY, fetch: f })
    const r = await stt.transcribe({ bytes: new Uint8Array(48000), mimeType: "audio/pcm", sampleRate: 24000 })
    expect(r.text).toBe((ex.response.body as { text: string }).text)
    expect(r.durationSeconds).toBe(1)
    expect(requests[0]!.url).toBe(ex.request.url)
    const form = requests[0]!.body as FormData
    expect(form.get("model_id")).toBe(D.sttFileModel.value)
    expect((form.get("file") as File).type).toBe("audio/wav")
  })
  it("requires sampleRate for audio/pcm", async () => {
    const stt = makeElevenLabsStt({ apiKey: KEY, fetch: makeReplayFetch([ex]).fetch })
    await expect(stt.transcribe({ bytes: new Uint8Array(4), mimeType: "audio/pcm" })).rejects.toThrow(/sampleRate/)
  })
  it("wavFromPcm16 writes a valid mono PCM16 header", () => {
    const wav = wavFromPcm16(new Uint8Array(10), 16000)
    const b = Buffer.from(wav)
    expect(b.toString("ascii", 0, 4)).toBe("RIFF")
    expect(b.toString("ascii", 8, 12)).toBe("WAVE")
    expect(b.readUInt32LE(24)).toBe(16000)
    expect(b.readUInt16LE(22)).toBe(1)
    expect(b.readUInt32LE(40)).toBe(10)
    expect(b.byteLength).toBe(54)
  })
})

describe("isScribeHallucination", () => {
  it("matches the four stock phrases and not a real sentence", () => {
    for (const t of ["Sous-titres réalisés par la communauté", "amara.org", "Thanks for watching!", "please subscribe to my channel"]) expect(isScribeHallucination(t), t).toBe(true)
    expect(isScribeHallucination("Je voudrais réserver une table pour deux.")).toBe(false)
  })
})

// The hosted agent needs an agent of the caller's own account, so there is no
// committed recording of it. These frames are written from the wire protocol
// the studio runs in production (integration/speech conversational.provider.ts);
// they are a scripted protocol test, not a recording.
describe("hosted agent (realtime), scripted protocol frames", () => {
  const AGENT = { agentId: "agent-for-tests" }
  const mkSocket = () => {
    const sent: Array<Record<string, unknown>> = []
    const listeners: { open: Array<() => void>; message: Array<(d: string) => void>; close: Array<() => void> } = { open: [], message: [], close: [] }
    let url = ""
    let headers: Record<string, string> | undefined
    const factory = (u: string, init?: { headers?: Record<string, string> }) => {
      url = u
      headers = init?.headers
      queueMicrotask(() => listeners.open.forEach(cb => cb()))
      return {
        send: (d: string | Uint8Array) => void sent.push(JSON.parse(String(d))),
        close: () => listeners.close.forEach(cb => cb()),
        on: (e: string, cb: never) => { if (e in listeners) (listeners as Record<string, unknown[]>)[e]!.push(cb) },
      }
    }
    return { factory: factory as never, sent, serve: (m: unknown) => listeners.message.forEach(cb => cb(JSON.stringify(m))), url: () => url, headers: () => headers }
  }
  const emitSpy = () => {
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

  it("connects with the key in the header and the agent in the URL, and says hello", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    await makeElevenLabsRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {}, provider: AGENT })
    await tick()
    expect(s.url()).toContain("agent_id=agent-for-tests")
    expect(s.url()).not.toContain(KEY)
    expect(s.headers()).toEqual({ "xi-api-key": KEY })
    expect(s.sent[0]).toMatchObject({ type: "conversation_initiation_client_data" })
  })

  it("attaches an async getSystemPrompt to the conversation config override", async () => {
    const s = mkSocket()
    await makeElevenLabsRealtime({ apiKey: KEY, socket: s.factory }).start({
      emit: emitSpy().emit,
      hooks: { getSystemPrompt: async () => "You are a helpful voice concierge." },
      provider: AGENT,
    })
    await tick()
    expect(s.sent[0]).toMatchObject({
      type: "conversation_initiation_client_data",
      conversation_config_override: { agent: { prompt: { prompt: "You are a helpful voice concierge." } } },
    })
  })

  it("still connects when getSystemPrompt rejects", async () => {
    const s = mkSocket()
    await makeElevenLabsRealtime({ apiKey: KEY, socket: s.factory }).start({
      emit: emitSpy().emit,
      hooks: { getSystemPrompt: async () => { throw new Error("no prompt") } },
      provider: AGENT,
    })
    await tick()
    expect(s.sent[0]).toMatchObject({ type: "conversation_initiation_client_data" })
    expect(s.sent[0]).not.toHaveProperty("conversation_config_override")
  })

  it("a signed URL needs no key on the socket", async () => {
    const s = mkSocket()
    await makeElevenLabsRealtime({ socket: s.factory }).start({ emit: emitSpy().emit, hooks: {}, provider: { signedUrl: "wss://example.test/signed?x=1" } })
    await tick()
    expect(s.headers()).toBeUndefined()
  })

  it("refuses to start with neither an agent nor a signed URL", async () => {
    await expect(makeElevenLabsRealtime({ apiKey: KEY, socket: mkSocket().factory }).start({ emit: emitSpy().emit, hooks: {} })).rejects.toThrow(/agentId/)
  })

  it("maps agent events: audio at the announced rate, transcripts, response complete, ping/pong", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    const session = await makeElevenLabsRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {}, provider: AGENT })
    await tick()
    s.serve({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "c", agent_output_audio_format: "pcm_24000" } })
    s.serve({ type: "ping", ping_event: { event_id: 7, ping_ms: 10 } })
    s.serve({ type: "user_transcript", user_transcription_event: { user_transcript: "bonjour" } })
    s.serve({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(4800).toString("base64"), event_id: 1 } })
    s.serve({ type: "agent_response", agent_response_event: { agent_response: "salut", event_id: 1 } })
    expect(s.sent).toContainEqual({ type: "pong", event_id: 7 })
    expect(spy.ev).toEqual(["user", "audio", "assistant", "complete"])
    expect((spy.detail.audio![0] as AudioFrame).sampleRate).toBe(24000)
    expect(spy.detail.user![0]).toEqual(["bonjour", true])
    await session.close()
  })

  it("an interruption is reported once and drops audio of the interrupted reply that is still in flight", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    await makeElevenLabsRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {}, provider: AGENT })
    await tick()
    s.serve({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(320).toString("base64"), event_id: 1 } })
    s.serve({ type: "interruption", interruption_event: { event_id: 5 } })
    s.serve({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(320).toString("base64"), event_id: 3 } })
    s.serve({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(320).toString("base64"), event_id: 6 } })
    expect(spy.ev).toEqual(["audio", "interrupt", "audio"])
  })

  it("answers a client tool call through the host hook, and returns a failure to the model", async () => {
    const s = mkSocket()
    const spy = emitSpy()
    await makeElevenLabsRealtime({ apiKey: KEY, socket: s.factory }).start({
      emit: spy.emit,
      hooks: { onToolCall: async (name, args) => { if (name === "boom") throw new Error("nope"); return { ok: true, args } } },
      provider: AGENT,
    })
    await tick()
    s.serve({ type: "client_tool_call", client_tool_call: { tool_call_id: "t1", tool_name: "lookup", parameters: { q: 1 } } })
    s.serve({ type: "client_tool_call", client_tool_call: { tool_call_id: "t2", tool_name: "boom", parameters: {} } })
    await tick()
    expect(s.sent).toContainEqual({ type: "client_tool_result", tool_call_id: "t1", result: JSON.stringify({ ok: true, args: { q: 1 } }), is_error: false })
    expect(s.sent).toContainEqual({ type: "client_tool_result", tool_call_id: "t2", result: "nope", is_error: true })
    expect(spy.ev).not.toContain("error")
  })

  it("sends mic audio as user_audio_chunk and counts audio seconds in the usage record, final after close", async () => {
    const s = mkSocket()
    const session = await makeElevenLabsRealtime({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {}, provider: AGENT })
    await tick()
    session.pushAudio({ pcm16: new Int16Array(16000).buffer, sampleRate: 16000, sequenceNumber: 0 })
    expect(s.sent.some(m => typeof m.user_audio_chunk === "string")).toBe(true)
    expect(session.getUsage!()!.entries[0]).toMatchObject({ stage: "realtime", provider: "elevenlabs", audioSeconds: 1 })
    await session.close()
    session.pushAudio({ pcm16: new Int16Array(16000).buffer, sampleRate: 16000, sequenceNumber: 1 })
    expect(session.getUsage!()!.entries[0]!.audioSeconds).toBe(1)
  })

  it("passes AIP conformance cases on a scripted session", async () => {
    const harness = {
      start: async (emit: VoiceEmit) => {
        const s = mkSocket()
        const session = await makeElevenLabsRealtime({ apiKey: KEY, socket: s.factory }).start({ emit, hooks: {}, provider: AGENT })
        ;(harness as unknown as { s: ReturnType<typeof mkSocket> }).s = s
        await tick()
        return session
      },
      completeTurn: async (session: { pushAudio: (f: AudioFrame) => void }) => {
        const s = (harness as unknown as { s: ReturnType<typeof mkSocket> }).s
        session.pushAudio({ pcm16: new Int16Array(1600).buffer, sampleRate: 16000, sequenceNumber: 0 })
        s.serve({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(320).toString("base64"), event_id: 1 } })
        s.serve({ type: "agent_response", agent_response_event: { agent_response: "ok", event_id: 1 } })
      },
      interruptedTurn: async () => {
        const s = (harness as unknown as { s: ReturnType<typeof mkSocket> }).s
        s.serve({ type: "interruption", interruption_event: { event_id: 2 } })
      },
    }
    for (const c of sessionConformanceCases(harness as never)) await c.run()
  })
})
    it("exposes the model it synthesizes with, the configured one over the default", () => {
      expect(makeElevenLabsTts().model).toBe("eleven_flash_v2_5")
      expect(makeElevenLabsTts({ modelId: "eleven_turbo_v2_5" }).model).toBe("eleven_turbo_v2_5")
    })

