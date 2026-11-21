import { describe, expect, it } from "vitest"
import { VOICE_DEFAULTS, type VoiceEmit, type VoiceSession } from "@agentproto/voice"
import { sessionConformanceCases } from "@agentproto/voice/testing"
import geminiDefault, { createGeminiProvider, makeGeminiLive, resolveGeminiKey } from "../index.js"

const D = VOICE_DEFAULTS.providers.gemini
const KEY = "test-key-not-a-secret"

// Why this package has no recorded fixture: the only Google API key on this
// machine answers 403 PERMISSION_DENIED ("issues with your billing account",
// tried twice on 2026-11-21, both the TTS and the Live endpoint), so a
// recording was impossible; fixing Google billing is an operator action. The
// frames below are scripted from the wire the studio runs in production
// (integration/mastra gemini-live.adapter.ts and @google/genai's
// BidiGenerateContent), exactly like the elevenlabs package scripted its
// hosted agent. scripts/record.mjs turns them into a real recording once the
// account accepts requests again.

/** One scripted socket per factory call: sent frames, url, per-socket serve. */
function sockets() {
  const made: Array<{ sent: Array<Record<string, unknown>>; url: string; isClosed: () => boolean; serve: (m: unknown) => void; openNow: () => void }> = []
  const factory = (url: string) => {
    const sent: Array<Record<string, unknown>> = []
    const listeners: { open: Array<() => void>; message: Array<(d: string) => void>; error: Array<(e: Error) => void>; close: Array<(c?: number) => void> } = { open: [], message: [], error: [], close: [] }
    let closed = false
    const entry = {
      sent,
      url,
      isClosed: () => closed,
      serve: (m: unknown) => listeners.message.forEach(cb => (typeof m === "string" ? cb(m) : cb(JSON.stringify(m)))),
      openNow: () => listeners.open.forEach(cb => cb()),
    }
    made.push(entry)
    // Auto-open, like the recorded exchanges: the socket is open one tick in.
    queueMicrotask(() => entry.openNow())
    return {
      send: (d: string | Uint8Array) => void sent.push(JSON.parse(String(d))),
      close: (c?: number) => { closed = true; listeners.close.forEach(cb => cb(c ?? 1000)) },
      on: (e: string, cb: never) => { if (e in listeners) (listeners as Record<string, unknown[]>)[e]!.push(cb) },
    }
  }
  return { factory: factory as never, sockets: made, sentFrames: () => made.flatMap(m => m.sent) }
}

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

describe("provider declaration", () => {
  it("declares the live stage, the key variable it reads first, and no stt or tts", () => {
    const p = createGeminiProvider()
    expect(p.slug).toBe("gemini")
    expect(p.env.apiKey).toBe("GEMINI_API_KEY")
    expect(Object.keys(p.capabilities).sort()).toEqual(["realtime"])
    expect(p.capabilities.realtime).toMatchObject({ id: "gemini-live", serverVad: false, interruption: true, functionCalling: true, say: false, refreshTools: true })
    expect(geminiDefault.slug).toBe("gemini")
  })
  it("reads GEMINI_API_KEY first, then GOOGLE_API_KEY, refusing with a named variable", () => {
    const savedGem = process.env.GEMINI_API_KEY
    const savedGoogle = process.env.GOOGLE_API_KEY
    try {
      process.env.GEMINI_API_KEY = "gem-key"
      process.env.GOOGLE_API_KEY = "google-key"
      expect(resolveGeminiKey({})).toBe("gem-key")
      delete process.env.GEMINI_API_KEY
      expect(resolveGeminiKey({})).toBe("google-key")
      delete process.env.GOOGLE_API_KEY
      expect(() => resolveGeminiKey({})).toThrow(/GEMINI_API_KEY/)
      // An explicit function wins over the environment.
      expect(resolveGeminiKey({ apiKey: () => "fn-key" })).toBe("fn-key")
    } finally {
      if (savedGem !== undefined) process.env.GEMINI_API_KEY = savedGem
      else delete process.env.GEMINI_API_KEY
      if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle
      else delete process.env.GOOGLE_API_KEY
    }
  })
  it("refuses to start without a key, naming the variable", async () => {
    const savedGem = process.env.GEMINI_API_KEY
    const savedGoogle = process.env.GOOGLE_API_KEY
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    try {
      await expect(makeGeminiLive().start({ emit: noopEmit(), hooks: {} })).rejects.toThrow(/GEMINI_API_KEY/)
    } finally {
      if (savedGem !== undefined) process.env.GEMINI_API_KEY = savedGem
      if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle
    }
  })
})

describe("Gemini Live, scripted protocol frames", () => {
  it("opens with one setup frame built from the defaults, and the key only in the URL", async () => {
    const s = sockets()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {} })
    await tick()
    expect(session.engine).toBe("realtime")
    expect(session.capabilities).toEqual({ serverVad: false, interruption: true, functionCalling: true, say: false, languages: [] })
    expect(s.sockets[0]!.url).toContain("BidiGenerateContent")
    expect(s.sockets[0]!.url).toContain(`key=${KEY}`)
    expect(s.sockets[0]!.sent).toHaveLength(1)
    expect(JSON.stringify(s.sockets[0]!.sent[0])).not.toContain(KEY)
    expect(s.sockets[0]!.sent[0]).toEqual({
      setup: {
        model: `models/${D.liveModel.value}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: D.voice.value } } },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    })
    await session.close()
  })

  it("attaches an async getSystemPrompt and the tool declarations, in JSON Schema form", async () => {
    const s = sockets()
    await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({
      emit: emitSpy().emit,
      hooks: {
        getSystemPrompt: async () => "You are a helpful voice concierge.",
        getTools: async () => [{ name: "lookup", description: "Look a thing up", parameters: { type: "object", properties: { q: { type: "string" } } } }],
      },
    })
    await tick()
    expect(s.sockets[0]!.sent[0]).toEqual({
      setup: {
        model: `models/${D.liveModel.value}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: D.voice.value } } },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: "You are a helpful voice concierge." }] },
        tools: [{ functionDeclarations: [{ name: "lookup", description: "Look a thing up", parametersJsonSchema: { type: "object", properties: { q: { type: "string" } } } }] }],
      },
    })
  })

  it("still starts when getSystemPrompt rejects, without a system instruction", async () => {
    const s = sockets()
    await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({
      emit: emitSpy().emit,
      hooks: { getSystemPrompt: async () => { throw new Error("no prompt") } },
    })
    await tick()
    expect(s.sockets[0]!.sent[0]).toMatchObject({ setup: { model: `models/${D.liveModel.value}` } })
    expect((s.sockets[0]!.sent[0] as { setup: Record<string, unknown> }).setup.systemInstruction).toBeUndefined()
  })

  it("pushAudio sends base64 realtimeInput at the frame's rate, commit is activityEnd, pushText is clientContent", async () => {
    const s = sockets()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {} })
    await tick()
    session.pushAudio({ pcm16: new Int16Array(16000).buffer, sampleRate: 16000, sequenceNumber: 0 })
    const audio = s.sockets[0]!.sent.find(m => (m as { realtimeInput?: { audio?: unknown } }).realtimeInput?.audio) as { realtimeInput: { audio: { data: string; mimeType: string } } }
    expect(Buffer.from(audio.realtimeInput.audio.data, "base64").byteLength).toBe(32000)
    expect(audio.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000")
    await session.commit()
    expect(s.sockets[0]!.sent.some(m => JSON.stringify(m) === JSON.stringify({ realtimeInput: { activityEnd: {} } }))).toBe(true)
    await session.pushText!("Bonjour")
    expect(s.sockets[0]!.sent.some(m => JSON.stringify(m) === JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "Bonjour" }] }], turnComplete: true } }))).toBe(true)
  })

  it("buffers frames sent before the socket is open, setup first once it opens", async () => {
    const listeners: { open: Array<() => void> } = { open: [] }
    const sent: Array<Record<string, unknown>> = []
    let url = ""
    const factory = (u: string) => {
      url = u
      return {
        send: (d: string | Uint8Array) => void sent.push(JSON.parse(String(d))),
        close: () => {},
        on: (e: string, cb: never) => { if (e === "open") listeners.open.push(cb) },
      }
    }
    const session = await makeGeminiLive({ apiKey: KEY, socket: factory as never }).start({ emit: emitSpy().emit, hooks: {} })
    session.pushAudio({ pcm16: new Int16Array(100).buffer, sampleRate: 16000, sequenceNumber: 0 })
    expect(sent).toEqual([]) // still buffered, the socket never opened
    listeners.open.forEach(cb => cb())
    expect(sent.map(m => (m as { setup?: unknown }).setup ? "setup" : "audio")).toEqual(["setup", "audio"])
    expect(url).toContain("BidiGenerateContent")
    await session.close()
  })

  it("maps modelTurn audio at the default rate, one completion per turn", async () => {
    const s = sockets()
    const spy = emitSpy()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    await tick()
    s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(320).toString("base64") } }] } } })
    s.sockets[0]!.serve({ serverContent: { outputTranscription: { text: "Bon" } } })
    s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(320).toString("base64") } }] } } })
    s.sockets[0]!.serve({ serverContent: { outputTranscription: { text: "jour." } } })
    s.sockets[0]!.serve({ serverContent: { turnComplete: true } })
    await tick()
    const audio = spy.detail.audio as Array<{ sampleRate: number; pcm16: ArrayBuffer; sequenceNumber: number }>
    expect(audio).toHaveLength(2)
    expect(audio.every(f => f.sampleRate === D.sampleRate.value)).toBe(true)
    expect(audio.every(f => f.pcm16.byteLength % 2 === 0)).toBe(true)
    expect(audio.every((f, i) => f.sequenceNumber === i)).toBe(true)
    expect(spy.detail.assistant).toEqual([["Bon", false], ["jour.", false], ["Bonjour.", true]])
    expect(spy.ev.filter(e => e === "complete")).toEqual(["complete"])
    await session.close()
  })

  it("finalizes the user transcript from inputTranscription deltas, even without finished", async () => {
    const s = sockets()
    const spy = emitSpy()
    const transcripts: Array<{ role: string; text: string }> = []
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({
      emit: spy.emit,
      hooks: { onTranscript: async t => { transcripts.push({ role: t.role, text: t.text }) } },
    })
    await tick()
    s.sockets[0]!.serve({ serverContent: { inputTranscription: { text: "Bonjour" } } })
    s.sockets[0]!.serve({ serverContent: { inputTranscription: { text: ", ceci" } } })
    s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(320).toString("base64") } }] } } }) // the assistant replying flushes the user turn
    await tick()
    expect(spy.detail.user).toEqual([["Bonjour", false], [", ceci", false], ["Bonjour, ceci", true]])
    expect(transcripts).toContainEqual({ role: "user", text: "Bonjour, ceci" })
    await session.close()
  })

  it("a manual interrupt() cuts playback: one interrupt, no audio and no complete for that turn", async () => {
    const s = sockets()
    const spy = emitSpy()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    await tick()
    s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(320).toString("base64") } }] } } })
    await session.interrupt()
    expect(spy.ev.filter(e => e === "interrupt")).toHaveLength(1)
    s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(320).toString("base64") } }] } } })
    s.sockets[0]!.serve({ serverContent: { outputTranscription: { text: "never" } } })
    s.sockets[0]!.serve({ serverContent: { turnComplete: true } })
    await tick()
    expect(spy.ev.filter(e => e === "interrupt")).toHaveLength(1)
    expect(spy.ev.filter(e => e === "audio")).toHaveLength(1)
    expect((spy.detail.assistant ?? []).length).toBe(0)
    expect(spy.ev).not.toContain("complete")
    // The session is ready for the next turn.
    s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(320).toString("base64") } }] } } })
    s.sockets[0]!.serve({ serverContent: { turnComplete: true } })
    await tick()
    expect(spy.ev.filter(e => e === "audio")).toHaveLength(2)
    expect(spy.ev.filter(e => e === "complete")).toHaveLength(1)
    await session.close()
  })

  it("serverContent.interrupted (the API's own cut) emits interrupt and drops the rest of the turn", async () => {
    const s = sockets()
    const spy = emitSpy()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    await tick()
    s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(320).toString("base64") } }] } } })
    s.sockets[0]!.serve({ serverContent: { interrupted: true } })
    s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(320).toString("base64") } }] } } })
    s.sockets[0]!.serve({ serverContent: { turnComplete: true } })
    await tick()
    expect(spy.ev.filter(e => e === "interrupt")).toHaveLength(1)
    expect(spy.ev.filter(e => e === "audio")).toHaveLength(1)
    expect(spy.ev).not.toContain("complete")
    await session.close()
  })

  it("maps usageMetadata onto the kit's token buckets (undifferentiated counts)", async () => {
    const s = sockets()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {} })
    await tick()
    s.sockets[0]!.serve({ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 } })
    await tick()
    const entry = session.getUsage!()!.entries.find(e => e.stage === "realtime")!
    expect(entry.provider).toBe("gemini")
    expect(entry.model).toBe(D.liveModel.value)
    expect(entry.tokens).toMatchObject({ textIn: 12, textOut: 7, audioIn: 0, audioOut: 0 })
    await session.close()
    s.sockets[0]!.serve({ usageMetadata: { promptTokenCount: 99 } })
    expect(session.getUsage!()!.entries.find(e => e.stage === "realtime")!.tokens!.textIn).toBe(12) // sealed
  })

  it("answers a toolCall through the host hook and returns a normalized functionResponse", async () => {
    const s = sockets()
    const spy = emitSpy()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({
      emit: spy.emit,
      hooks: { onToolCall: async (name, args) => { if (name === "boom") throw new Error("nope"); return args && (args as { q?: number }).q } },
    })
    await tick()
    s.sockets[0]!.serve({ toolCall: { functionCalls: [
      { id: "c1", name: "lookup", args: { q: 42 } },
      { id: "c2", name: "boom", args: {} },
      { id: "c3", name: "textTool", args: { q: 1 } },
    ] } })
    await tick()
    expect(spy.detail["tool.start"]).toEqual([["lookup", { q: 42 }], ["boom", {}], ["textTool", { q: 1 }]])
    expect(s.sentFrames()).toContainEqual({ toolOutput: { functionResponses: [{ id: "c1", name: "lookup", response: { output: 42 } }] } })
    expect(s.sentFrames()).toContainEqual({ toolOutput: { functionResponses: [{ id: "c2", name: "boom", response: { error: "nope" } }] } })
    expect(spy.ev).not.toContain("error")
    await session.close()
  })

  it("also dispatches a functionCall embedded in a modelTurn part", async () => {
    const s = sockets()
    const spy = emitSpy()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({
      emit: spy.emit,
      hooks: { onToolCall: async () => ({ ok: true }) },
    })
    await tick()
    s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ functionCall: { id: "c9", name: "later", args: {} } }] } } })
    await tick()
    expect(spy.detail["tool.end"]).toEqual([["later", { ok: true }]])
    expect(s.sentFrames()).toContainEqual({ toolOutput: { functionResponses: [{ id: "c9", name: "later", response: { ok: true } }] } })
    await session.close()
  })

  it("a non-JSON message is an emit error, not a crash", async () => {
    const s = sockets()
    const spy = emitSpy()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit: spy.emit, hooks: {} })
    await tick()
    s.sockets[0]!.serve("not json")
    await tick()
    expect(spy.ev.filter(e => e === "error")).toHaveLength(1)
    await session.close()
  })

  it("refreshTools() reconnects with a fresh setup carrying the new tools (the wire freezes them at setup)", async () => {
    const s = sockets()
    let n = 0
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({
      emit: emitSpy().emit,
      hooks: {
        getTools: async () => { n++; return [{ name: `tool${n}`, parameters: { type: "object" } }] },
        getSystemPrompt: async () => "prompt",
      },
    })
    await tick()
    expect(s.sockets).toHaveLength(1)
    await session.refreshTools!()
    expect(s.sockets).toHaveLength(2)
    expect(s.sockets[0]!.isClosed()).toBe(true)
    expect((s.sockets[1]!.sent[0] as { setup: { model: string; systemInstruction: { parts: Array<{ text: string }> } } }).setup.systemInstruction).toEqual({ parts: [{ text: "prompt" }] })
    const tools = (s.sockets[1]!.sent[0] as { setup: { tools?: Array<{ functionDeclarations: Array<{ name: string }> }> } }).setup.tools
    expect(tools?.[0]!.functionDeclarations[0]!.name).toBe("tool2")
  })

  it("close() is idempotent, sends nothing after", async () => {
    const s = sockets()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {} })
    await tick()
    await session.close()
    await session.close()
    expect(s.sockets[0]!.isClosed()).toBe(true)
    const before = s.sentFrames().length
    session.pushAudio({ pcm16: new Int16Array(100).buffer, sampleRate: 16000, sequenceNumber: 0 })
    await session.commit()
    await session.interrupt()
    await session.pushText!("x")
    await session.refreshTools!()
    expect(s.sentFrames().length).toBe(before)
    expect(s.sockets).toHaveLength(1)
  })

  it("counts pushed audio seconds in the usage record, final after close", async () => {
    const s = sockets()
    const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit: emitSpy().emit, hooks: {} })
    await tick()
    session.pushAudio({ pcm16: new Int16Array(16000).buffer, sampleRate: 16000, sequenceNumber: 0 })
    const entry = session.getUsage!()!.entries.find(e => e.stage === "realtime")!
    expect(entry.audioSeconds).toBe(1)
    await session.close()
    session.pushAudio({ pcm16: new Int16Array(16000).buffer, sampleRate: 16000, sequenceNumber: 1 })
    expect(session.getUsage!()!.entries.find(e => e.stage === "realtime")!.audioSeconds).toBe(1)
  })

  it("passes AIP conformance cases on a scripted session", async () => {
    const harness = {
      start: async (emit: VoiceEmit) => {
        const s = sockets()
        const session = await makeGeminiLive({ apiKey: KEY, socket: s.factory }).start({ emit, hooks: {} })
        ;(harness as unknown as { s: ReturnType<typeof sockets> }).s = s
        await tick()
        return session
      },
      completeTurn: async (session: VoiceSession) => {
        const s = (harness as unknown as { s: ReturnType<typeof sockets> }).s
        session.pushAudio({ pcm16: new Int16Array(1600).buffer, sampleRate: 16000, sequenceNumber: 0 })
        s.sockets[0]!.serve({ serverContent: { inputTranscription: { text: "conformed" } } })
        s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(320).toString("base64") } }] } } })
        s.sockets[0]!.serve({ serverContent: { outputTranscription: { text: "ok" } } })
        s.sockets[0]!.serve({ serverContent: { turnComplete: true } })
        s.sockets[0]!.serve({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })
        await tick()
      },
      interruptedTurn: async () => {
        const s = (harness as unknown as { s: ReturnType<typeof sockets> }).s
        s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(320).toString("base64") } }] } } })
        s.sockets[0]!.serve({ serverContent: { interrupted: true } })
        s.sockets[0]!.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(320).toString("base64") } }] } } })
        s.sockets[0]!.serve({ serverContent: { turnComplete: true } })
        await tick()
      },
    }
    for (const c of sessionConformanceCases(harness)) await c.run()
  })
})
