import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { VOICE_DEFAULTS, type AudioFrame } from "@agentproto/voice"
import {
  makeReplayFetch,
  makeReplaySocket,
  scanForSecrets,
  sttConformanceCases,
  ttsConformanceCases,
  type RecordedExchange,
  type RecordedHttpExchange,
  type RecordedWsExchange,
} from "@agentproto/voice/testing"
import assemblyaiDefault, { createAssemblyAIProvider, languageName, makeAssemblyAIStt, makeAssemblyAITts, wavFromPcm16 } from "../index.js"

const D = VOICE_DEFAULTS.providers.assemblyai
const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const load = <T extends RecordedExchange>(name: string): T => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as T
const KEY = "test-key-not-a-secret"

describe("recorded fixtures", () => {
  const files = readdirSync(dir).filter(f => f.endsWith(".json"))
  it("has the recorded exchanges", () => {
    expect(files.sort()).toEqual(["stt-create.json", "stt-poll.json", "stt-upload.json", "stt-ws.json", "tts-http.json", "tts-ws.json"])
  })
  it("holds no key, no authorization header, no account or session identifier", () => {
    const live = [process.env.ASSEMBLYAI_API_KEY].filter((v): v is string => !!v)
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
  it("declares the stt and tts stages (no hosted agent) and the key variable", () => {
    const p = createAssemblyAIProvider()
    expect(p.slug).toBe("assemblyai")
    expect(p.env.apiKey).toBe("ASSEMBLYAI_API_KEY")
    expect(Object.keys(p.capabilities).sort()).toEqual(["stt", "tts"])
    expect(p.realtime).toBeUndefined()
    expect(p.stt!.capabilities.streaming).toBe(true)
    expect(p.stt!.capabilities.file).toBe(true)
    expect(p.stt!.capabilities.partials).toBe(true)
    expect(p.stt!.capabilities.manualCommit).toBe(true)
    expect(p.tts!.capabilities.cancel).toBe(true)
    expect(p.tts!.capabilities.languages).toEqual(["en", "es", "fr", "de", "it", "pt"])
    expect(assemblyaiDefault.slug).toBe("assemblyai")
  })
  it("refuses to open anything without a key, naming the variable", async () => {
    const saved = process.env.ASSEMBLYAI_API_KEY
    delete process.env.ASSEMBLYAI_API_KEY
    try {
      await expect(makeAssemblyAITts().synthesize({ text: "x" })).rejects.toThrow(/ASSEMBLYAI_API_KEY/)
      await expect(makeAssemblyAIStt().openStream({ sampleRate: 16000 })).rejects.toThrow(/ASSEMBLYAI_API_KEY/)
    } finally {
      if (saved !== undefined) process.env.ASSEMBLYAI_API_KEY = saved
    }
  })
  it("maps BCP-47 language codes (incl. regional tags) to the API full names and fails fast on the rest", () => {
    expect(languageName("fr")).toBe("french")
    expect(languageName("en")).toBe("english")
    expect(languageName("fr-FR")).toBe("french")
    expect(languageName("pt-BR")).toBe("portuguese")
    expect(languageName(undefined)).toBeUndefined()
    expect(languageName("french")).toBe("french")
    expect(languageName("FRENCH")).toBe("french")
    // Anything the API cannot take is a caller bug: refused, never passed
    // through to the vendor (this covers the fail-fast throw).
    expect(() => languageName("klingon")).toThrow(/not supported/)
    expect(() => languageName("xx-YY")).toThrow(/not supported/)
  })
})

describe("TTS over the recorded WebSocket", () => {
  const ex = load<RecordedWsExchange>("tts-ws")

  it("replays the recorded exchange: same frames out, audio then done, PCM16 at the configured rate", async () => {
    const replay = makeReplaySocket(ex)
    const tts = makeAssemblyAITts({ apiKey: KEY, socket: replay.factory })
    const stream = await tts.openStream({})
    const frames: AudioFrame[] = []
    const order: string[] = []
    await new Promise<void>(resolve => {
      stream.on("audio", f => (frames.push(f), order.push("audio")))
      stream.on("done", () => (order.push("done"), resolve()))
      stream.on("error", e => { throw e })
      stream.sendText("Bonjour, ")
      stream.sendText("ceci est un test.")
      stream.flush()
      stream.end()
    })
    await stream.close()
    expect(replay.mismatches).toEqual([])
    expect(replay.done()).toBe(true)
    expect(order[order.length - 1]).toBe("done")
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(f => f.sampleRate === D.ttsSampleRate.value)).toBe(true)
    expect(frames.every(f => f.pcm16.byteLength % 2 === 0)).toBe(true)
    expect(replay.urls[0]).toContain(`sample_rate=${D.ttsSampleRate.value}`)
    expect(replay.urls[0]).toContain(`encoding=${D.ttsEncoding.value}`)
    expect(replay.urls[0]).toContain(`model_id=${D.ttsModel.value}`)
    // No deployment language: omitted from the query string, the vendor default applies.
    expect(replay.urls[0]).not.toContain("language=")
  })

  it("honours a per-stream sampleRate override in both the URL and the emitted frames", async () => {
    const replay = makeReplaySocket(ex)
    const tts = makeAssemblyAITts({ apiKey: KEY, socket: replay.factory })
    const stream = await tts.openStream({ sampleRate: 16000 })
    const frames: AudioFrame[] = []
    await new Promise<void>(resolve => {
      stream.on("audio", f => frames.push(f))
      stream.on("done", () => resolve())
      stream.on("error", e => { throw e })
      stream.sendText("Bonjour, ")
      stream.sendText("ceci est un test.")
      stream.flush()
      stream.end()
    })
    await stream.close()
    expect(replay.mismatches).toEqual([])
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(f => f.sampleRate === 16000)).toBe(true)
    expect(replay.urls[0]).toContain("sample_rate=16000")
  })

  it("refuses a per-stream sampleRate outside the vendor set, like the constructor does", async () => {
    const replay = makeReplaySocket(ex)
    const tts = makeAssemblyAITts({ apiKey: KEY, socket: replay.factory })
    await expect(tts.openStream({ sampleRate: 12345 })).rejects.toThrow(/sample rate 12345/)
  })

  it("puts the key in the Authorization header, never in the URL or in a frame", async () => {
    const headers: Array<Record<string, string> | undefined> = []
    const urls: string[] = []
    const sent: string[] = []
    const inner = makeReplaySocket(ex).factory
    const tts = makeAssemblyAITts({
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
    expect(headers[0]).toEqual({ Authorization: KEY })
    expect(urls.join("\n")).not.toContain(KEY)
    expect(sent.join("\n")).not.toContain(KEY)
  })

  it("after cancel() no audio and no done is delivered, and cancel() is idempotent", async () => {
    const replay = makeReplaySocket(ex, { releaseWhen: () => false })
    const tts = makeAssemblyAITts({ apiKey: KEY, socket: replay.factory })
    const stream = await tts.openStream({})
    let after = 0
    let cancelled = false
    stream.on("audio", () => cancelled && after++)
    stream.on("done", () => cancelled && after++)
    stream.sendText("Une phrase assez longue pour generer de l'audio. ")
    stream.cancel()
    cancelled = true
    stream.cancel()
    stream.end()
    await new Promise(r => setTimeout(r, 30))
    expect(after).toBe(0)
    await stream.close()
  })

  it("sends Generate only after the recorded Begin (the docs say wait for Begin)", async () => {
    const sent: unknown[] = []
    const inner = makeReplaySocket(ex).factory
    const tts = makeAssemblyAITts({
      apiKey: KEY,
      socket: (u, i) => {
        const s = inner(u, i)
        const send = s.send.bind(s)
        s.send = d => (sent.push(JSON.parse(String(d))), send(d))
        return s
      },
    })
    const stream = await tts.openStream({})
    await new Promise(r => setTimeout(r, 5)) // open + Begin delivered by the replay
    stream.sendText("Bonjour, ")
    await new Promise(r => setTimeout(r, 5))
    expect(sent).toEqual([{ type: "Generate", text: "Bonjour, " }])
    stream.end()
    await stream.close()
  })

  // A socket that serves the recorded Begin at open (the provider waits for
  // it before sending text), then every other recorded in-frame on the first
  // Generate/Terminate, so the generic conformance text still gets the
  // recorded audio and Termination.
  const beginThenRestSocket = () => {
    const sent: string[] = []
    const cbs = { open: [] as Array<() => void>, message: [] as Array<(d: string) => void>, error: [] as Array<(e: Error) => void>, close: [] as Array<(c?: number) => void> }
    const begin = ex.frames.find(f => f.dir === "in" && (f.data as { type?: string }).type === "Begin")
    let released = false
    const factory = (u: string) => {
      queueMicrotask(() => {
        cbs.open.forEach(cb => cb())
        if (begin) for (const cb of cbs.message) cb(JSON.stringify(begin.data))
      })
      return {
        send(d: string | Uint8Array) {
          const text = String(d)
          sent.push(text)
          let parsed: { type?: string }
          try { parsed = JSON.parse(text) } catch { return }
          if (!released && (parsed.type === "Generate" || parsed.type === "Terminate")) {
            released = true
            for (const f of ex.frames) if (f.dir === "in" && f !== begin) for (const cb of cbs.message) cb(JSON.stringify(f.data))
          }
        },
        close: () => queueMicrotask(() => cbs.close.forEach(cb => cb(1000))),
        on: (e: string, cb: never) => { ;(cbs as Record<string, unknown[]>)[e]!.push(cb) },
      }
    }
    return { factory: factory as never, sent }
  }

  for (const c of ttsConformanceCases(
    makeAssemblyAITts({ apiKey: KEY, socket: beginThenRestSocket().factory, fetch: makeReplayFetch([load<RecordedHttpExchange>("tts-http")]).fetch }),
  )) {
    it(`conformance: ${c.name}`, c.run)
  }
})

describe("TTS over recorded HTTP", () => {
  const ex = load<RecordedHttpExchange>("tts-http")
  it("synthesizes raw PCM and sends model, rate and encoding from the defaults (no language)", async () => {
    const { fetch: f, requests } = makeReplayFetch([ex])
    const tts = makeAssemblyAITts({ apiKey: KEY, fetch: f })
    const r = await tts.synthesize({ text: "Bonjour, ceci est un test de la voix." })
    expect(r.mimeType).toBe("audio/pcm")
    expect(r.bytes.byteLength).toBeGreaterThan(0)
    expect(r.durationSeconds).toBeCloseTo(r.bytes.byteLength / 2 / D.ttsSampleRate.value, 5)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(ex.request.url)
    expect(requests[0]!.body).toMatchObject({
      model_id: D.ttsModel.value,
      sample_rate: D.ttsSampleRate.value,
      encoding: D.ttsEncoding.value,
      container: "raw",
    })
    expect(requests[0]!.body).not.toHaveProperty("language")
  })
  it("turns an HTTP error into an error that names the status and not the key", async () => {
    const tts = makeAssemblyAITts({ apiKey: KEY, fetch: (async () => new Response("unauthorized", { status: 401 })) as typeof fetch })
    await expect(tts.synthesize({ text: "x" })).rejects.toThrow(/401/)
    await expect(tts.synthesize({ text: "x" })).rejects.not.toThrow(new RegExp(KEY))
  })
  it("refuses a sample rate outside the vendor set", () => {
    expect(() => makeAssemblyAITts({ sampleRate: 12345 })).toThrow(/sample rate/)
  })
})

describe("STT over the recorded streaming v3 WebSocket", () => {
  const ex = load<RecordedWsExchange>("stt-ws")
  const finalTurn = ex.frames.find(f => f.dir === "in" && (f.data as { type?: string }).type === "Turn" && (f.data as { end_of_turn?: boolean }).end_of_turn === true)!.data as { transcript: string }
  const partialTurn = ex.frames.find(f => f.dir === "in" && (f.data as { type?: string }).type === "Turn" && (f.data as { end_of_turn?: boolean }).end_of_turn === false)!.data as { transcript: string }

  it("replays the recorded exchange: binary audio up, ForceEndpoint on commit(), partial then final down", async () => {
    // Lenient: the test sends its own audio chunks, not the recorded ones.
    // commit() releases the recorded in-frames (Begin, partial Turn, final Turn).
    const replay = makeReplaySocket(ex, { releaseWhen: f => (f as { type?: string }).type === "ForceEndpoint" })
    const sent: Array<string | Uint8Array> = []
    const stt = makeAssemblyAIStt({
      apiKey: KEY,
      socket: (u, i) => {
        const s = replay.factory(u, i)
        const send = s.send.bind(s)
        s.send = d => (sent.push(d), send(d))
        return s
      },
    })
    const stream = await stt.openStream({ sampleRate: 24000, language: "fr" })
    const partials: string[] = []
    const result = await new Promise<string>(resolve => {
      stream.on("partial", t => partials.push(t.text))
      stream.on("final", t => resolve(t.text))
      stream.on("error", e => resolve(`error: ${e.message}`))
      for (let i = 0; i < 5; i++) stream.pushAudio({ pcm16: new Int16Array(4800).buffer, sampleRate: 24000, sequenceNumber: i })
      stream.commit()
    })
    await stream.close()
    expect(result).toBe(finalTurn.transcript)
    expect(partials).toContain(partialTurn.transcript)
    expect(replay.mismatches).toEqual([])
    expect(replay.done()).toBe(true)
    expect(sent.filter(d => typeof d !== "string").length).toBe(5) // binary audio frames
    expect(sent.map(d => (typeof d === "string" ? JSON.parse(d) : d))).toContainEqual({ type: "ForceEndpoint" })
    expect(replay.urls[0]).toContain("sample_rate=24000")
    expect(replay.urls[0]).toContain(`encoding=${D.sttEncoding.value}`)
    expect(replay.urls[0]).toContain("language_codes=fr")
  })

  it("an Error frame is an error event", async () => {
    const bad: RecordedWsExchange = {
      ...ex,
      frames: [
        { dir: "in", data: { type: "Begin", id: "<redacted>", expires_at: 0, configuration: {} } },
        { dir: "out", data: { type: "ForceEndpoint" } },
        { dir: "in", data: { type: "Error", error_code: 1008, error: "credential rejected" } },
      ],
    }
    const stt = makeAssemblyAIStt({ apiKey: KEY, socket: makeReplaySocket(bad, { strictOut: false }).factory })
    const stream = await stt.openStream({ sampleRate: 16000 })
    const err = await new Promise<Error>(resolve => {
      stream.on("error", resolve)
      stream.commit()
    })
    expect(err.message).toMatch(/credential rejected/)
    await stream.close()
  })

  for (const c of sttConformanceCases(
    makeAssemblyAIStt({
      apiKey: KEY,
      socket: (u, i) => makeReplaySocket(ex, { releaseWhen: f => (f as { type?: string }).type === "ForceEndpoint" }).factory(u, i),
      fetch: makeReplayFetch([load<RecordedHttpExchange>("stt-upload"), load<RecordedHttpExchange>("stt-create"), load<RecordedHttpExchange>("stt-poll")]).fetch,
    }),
    { sampleRate: 24000, frames: [{ pcm16: new Int16Array(4800).buffer, sampleRate: 24000, sequenceNumber: 0 }] },
  )) {
    it(`conformance: ${c.name}`, c.run)
  }
})

describe("STT over recorded HTTP (upload, create, poll)", () => {
  const upload = load<RecordedHttpExchange>("stt-upload")
  const create = load<RecordedHttpExchange>("stt-create")
  const poll = load<RecordedHttpExchange>("stt-poll")
  const finalText = (poll.response.body as { text: string }).text

  it("uploads, creates with the requested language, polls until completed", async () => {
    const { fetch: f, requests } = makeReplayFetch([upload, create, poll])
    const stt = makeAssemblyAIStt({ apiKey: KEY, fetch: f, pollMs: 1 })
    const r = await stt.transcribe({ bytes: new Uint8Array(48000), mimeType: "audio/wav" }, { language: "fr" })
    expect(r.text).toBe(finalText)
    expect(r.language).toBe("fr")
    expect(r.durationSeconds).toBe(3)
    expect(requests.map(q => `${q.method} ${q.url}`)).toEqual([
      `POST ${upload.request.url}`,
      `POST ${create.request.url}`,
      `GET ${poll.request.url}`,
    ])
    expect(create.request.body).toMatchObject({ audio_url: "<upload-url>", language_code: "fr" })
  })

  it("transcribes raw PCM as a WAV upload and requires sampleRate for audio/pcm", async () => {
    const { fetch: f, requests } = makeReplayFetch([upload, create, poll])
    const stt = makeAssemblyAIStt({ apiKey: KEY, fetch: f, pollMs: 1 })
    await stt.transcribe({ bytes: new Uint8Array(48000), mimeType: "audio/pcm", sampleRate: 24000 })
    const body = requests[0]!.body as Uint8Array
    expect(body).toBeInstanceOf(Uint8Array)
    expect(body.byteLength).toBe(48000 + 44) // WAV header added
    expect(Buffer.from(body).toString("ascii", 0, 4)).toBe("RIFF")
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
