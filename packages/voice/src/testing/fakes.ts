/**
 * Fake providers for tests and for provider authors: no network, scripted
 * behaviour, and a shared timeline so a test can assert ordering (for example
 * that a barge-in cancels TTS before the interrupt is emitted).
 */
import type {
  AudioFrame,
  RealtimeProvider,
  SttProvider,
  SttStream,
  SttTranscript,
  TtsProvider,
  TtsStream,
  VoiceEmit,
  VoiceSession,
  VoiceStartOptions,
  VoiceUsage,
} from "../types.js"

export type Timeline = string[]

/** Mono PCM16 of `ms` at `sampleRate`, filled with a non-zero value. */
export function pcmFrame(ms: number, sampleRate: number, seq = 0): AudioFrame {
  const samples = Math.round((sampleRate * ms) / 1000)
  const pcm = new Int16Array(samples).fill(1000)
  return { pcm16: pcm.buffer, sampleRate, sequenceNumber: seq }
}

export function frameMs(frame: AudioFrame): number {
  return (frame.pcm16.byteLength / 2 / frame.sampleRate) * 1000
}

export interface FakeSttOptions {
  slug?: string
  streaming?: boolean
  file?: boolean
  /** Reported as `models` on the provider (and so on the STT usage entry). */
  models?: { stream?: string; file?: string }
  /** Texts returned by successive finals (stream) and successive `transcribe` calls. */
  finals?: string[]
  /** `commit()` produces no final: simulates a vendor that goes silent. */
  silent?: boolean
  /** `openStream` rejects. */
  openFails?: boolean
  timeline?: Timeline
}

export interface FakeStt extends SttProvider {
  readonly streams: Array<{ pushed: AudioFrame[]; commits: number; closed: boolean }>
  readonly transcribed: Array<{ bytes: number; sampleRate: number | undefined }>
}

export function makeFakeStt(opts: FakeSttOptions = {}): FakeStt {
  const finals = [...(opts.finals ?? ["hello"])]
  const streams: FakeStt["streams"] = []
  const transcribed: FakeStt["transcribed"] = []
  const nextText = () => (finals.length > 1 ? finals.shift()! : (finals[0] ?? ""))
  return {
    slug: opts.slug ?? "fakestt",
    ...(opts.models ? { models: opts.models } : {}),
    capabilities: {
      streaming: opts.streaming ?? true,
      file: opts.file ?? true,
      partials: true,
      serverEndpointing: false,
      manualCommit: true,
      languages: ["en"],
      sampleRates: [16_000],
    },
    streams,
    transcribed,
    async openStream(): Promise<SttStream> {
      if (opts.openFails) throw new Error("fake stt: open failed")
      const rec = { pushed: [] as AudioFrame[], commits: 0, closed: false }
      streams.push(rec)
      const cbs: { final: Array<(t: SttTranscript) => void>; partial: Array<(t: SttTranscript) => void>; error: Array<(e: Error) => void>; closed: Array<() => void> } = { final: [], partial: [], error: [], closed: [] }
      return {
        pushAudio: f => void rec.pushed.push(f),
        commit() {
          rec.commits++
          opts.timeline?.push("stt:commit")
          if (opts.silent) return
          const text = nextText()
          queueMicrotask(() => cbs.final.forEach(cb => cb({ text })))
        },
        on(event: string, cb: never) {
          ;(cbs as Record<string, unknown[]>)[event]!.push(cb)
        },
        async close() {
          rec.closed = true
          cbs.closed.forEach(cb => cb())
        },
      } as SttStream
    },
    async transcribe(input) {
      transcribed.push({ bytes: input.bytes.byteLength, sampleRate: input.sampleRate })
      return { text: nextText() }
    },
  }
}

export interface FakeTtsOptions {
  slug?: string
  /** Reported as `model` on the provider (and so on the TTS usage entry). */
  model?: string
  streaming?: boolean
  file?: boolean
  /** Audio per input character, in ms. Default 10. */
  msPerChar?: number
  sampleRate?: number
  /** Audio frames are delivered after this timer delay instead of in a microtask. */
  tickMs?: number
  /** Streams opened after the Nth one deliver after `slowMs` (a TTS that is still generating). */
  slowAfterStreams?: number
  slowMs?: number
  /** `openStream` resolves only after this delay (a handshake still in progress). */
  openDelayMs?: number
  timeline?: Timeline
}

export interface FakeTts extends TtsProvider {
  /** Text sent on every stream, in order, and whether each stream was cancelled. */
  readonly streams: Array<{ texts: string[]; ended: boolean; cancelled: boolean; flushes: number }>
  readonly synthesized: string[]
}

export function makeFakeTts(opts: FakeTtsOptions = {}): FakeTts {
  const streams: FakeTts["streams"] = []
  const synthesized: string[] = []
  const rate = opts.sampleRate ?? 24_000
  const msPerChar = opts.msPerChar ?? 10
  return {
    slug: opts.slug ?? "faketts",
    ...(opts.model ? { model: opts.model } : {}),
    capabilities: {
      streaming: opts.streaming ?? true,
      file: opts.file ?? true,
      chunkedInput: true,
      cancel: true,
      languages: ["en"],
      outputSampleRates: [rate],
    },
    streams,
    synthesized,
    async openStream(): Promise<TtsStream> {
      if (opts.openDelayMs) await new Promise(r => setTimeout(r, opts.openDelayMs))
      const rec = { texts: [] as string[], ended: false, cancelled: false, flushes: 0 }
      streams.push(rec)
      const cbs = { audio: [] as Array<(f: AudioFrame) => void>, done: [] as Array<() => void>, error: [] as Array<(e: Error) => void> }
      let seq = 0
      const index = streams.length - 1
      const deliver = (fn: () => void) => {
        const slow = opts.slowAfterStreams !== undefined && index >= opts.slowAfterStreams
        const delay = slow ? (opts.slowMs ?? 60_000) : opts.tickMs
        if (delay) setTimeout(fn, delay)
        else queueMicrotask(fn)
      }
      return {
        sendText(chunk) {
          if (rec.cancelled) return
          rec.texts.push(chunk)
        },
        flush() {
          rec.flushes++
        },
        end() {
          if (rec.cancelled || rec.ended) return
          rec.ended = true
          const text = rec.texts.join("")
          deliver(() => {
            if (rec.cancelled) return
            cbs.audio.forEach(cb => cb(pcmFrame(Math.max(20, text.length * msPerChar), rate, seq++)))
            if (rec.cancelled) return
            cbs.done.forEach(cb => cb())
          })
        },
        cancel() {
          if (rec.cancelled) return
          rec.cancelled = true
          opts.timeline?.push("tts:cancel")
        },
        on(event: string, cb: never) {
          ;(cbs as Record<string, unknown[]>)[event]!.push(cb)
        },
        async close() {},
      } as TtsStream
    },
    async synthesize(input) {
      synthesized.push(input.text)
      const ms = Math.max(20, input.text.length * msPerChar)
      return { bytes: new Uint8Array(pcmFrame(ms, rate).pcm16), mimeType: "audio/pcm", durationSeconds: ms / 1000 }
    },
  }
}

export interface FakeRealtimeOptions {
  slug?: string
  id?: string
  say?: boolean
  timeline?: Timeline
}

export interface FakeRealtimeSession extends VoiceSession {
  /** Drive the vendor side: a user turn answered by the assistant. */
  vendorTurn(user: string, assistant: string): void
  /** Drive the vendor side: the user cuts in. */
  vendorBargeIn(): void
  readonly closed: boolean
  readonly received: AudioFrame[]
}

export function makeFakeRealtime(opts: FakeRealtimeOptions = {}): RealtimeProvider & { sessions: FakeRealtimeSession[] } {
  const sessions: FakeRealtimeSession[] = []
  return {
    slug: opts.slug ?? "fakert",
    capabilities: {
      id: opts.id ?? "fakert-live",
      serverVad: true,
      interruption: true,
      functionCalling: true,
      say: opts.say ?? true,
      refreshTools: false,
      languages: ["en"],
      inputSampleRates: [16_000],
      outputSampleRate: 24_000,
    },
    sessions,
    async start(start: VoiceStartOptions): Promise<VoiceSession> {
      const emit: VoiceEmit = start.emit
      let closed = false
      let seconds = 0
      const started = Date.now()
      const received: AudioFrame[] = []
      const usage = (): VoiceUsage => ({
        engine: "realtime",
        wallSeconds: (Date.now() - started) / 1000,
        entries: [{ stage: "realtime", provider: opts.slug ?? "fakert", audioSeconds: seconds }],
      })
      const session: FakeRealtimeSession = {
        engine: "realtime",
        capabilities: { serverVad: true, interruption: true, functionCalling: true, say: opts.say ?? true, languages: ["en"] },
        pushAudio(frame) {
          if (closed) return
          received.push(frame)
          seconds += frameMs(frame) / 1000
        },
        async commit() {},
        async interrupt() {
          opts.timeline?.push("rt:interrupt")
        },
        ...(opts.say === false ? {} : { say: async (_d: string) => {} }),
        getUsage: usage,
        async close() {
          closed = true
        },
        vendorTurn(user, assistant) {
          emit.userTranscript(user, true)
          emit.assistantTranscript(assistant, true)
          emit.responseComplete()
        },
        vendorBargeIn() {
          emit.interrupt()
        },
        get closed() {
          return closed
        },
        received,
      }
      sessions.push(session)
      return session
    },
  }
}
