/**
 * The `cascade` engine of AIP-VOICE: STT provider, a host brain, TTS provider,
 * with the local VAD, barge-in, bounded outbound queue and brain guards of
 * `createCallPipeline` (ported from the studio call pipeline).
 *
 * `startCascade` is the entry point:
 *
 *     startCascade(opts: VoiceStartOptions & CascadeOptions): Promise<VoiceSession>
 *
 * `emit`, `hooks`, `language` and `voiceId` come from `VoiceStartOptions`.
 * `brain` yields reply TEXT; this engine owns synthesis, so the brain never
 * returns audio and the TTS provider is replaceable by configuration.
 */
import { VOICE_DEFAULTS } from "../defaults.js"
import { makeUsageMeter } from "../usage.js"
import type {
  AudioFrame,
  SttProvider,
  TtsProvider,
  TtsStream,
  VoiceSession,
  VoiceStartOptions,
} from "../types.js"
import { consumeBrain, type BrainGuardOptions } from "./brain-guard.js"
import {
  createCallPipeline,
  type BargeInOptions,
  type CallPipelineDeps,
  type CallPlayback,
} from "./pipeline.js"
import {
  streamTurnWithSentences,
  type CallTtsStreamHandle,
  type CallTtsStreamOpener,
} from "./speak-turn.js"
import { openSttSession, type SttSession } from "./stt-session.js"

export interface CascadeVadOptions {
  /** Silence that ends an utterance. */
  silenceEndMs?: number
  /** Max utterance length before a forced flush. */
  maxUtteranceMs?: number
  /** Silence kept before the first loud frame. */
  preRollMs?: number
}

export type CascadeBargeInOptions = BargeInOptions

export interface CascadeBrainInput {
  text: string
  /** Fires when the turn is abandoned (barge-in, watchdog, hang-up). */
  signal: AbortSignal
  utteranceId: number
}

export interface CascadeOptions {
  stt: SttProvider
  tts: TtsProvider
  /** Reply text, in chunks. */
  brain(input: CascadeBrainInput): AsyncIterable<string>
  /** `false`: manual mode, no local VAD; `commit()` ends the utterance (push-to-talk). */
  vad?: CascadeVadOptions | false
  bargeIn?: CascadeBargeInOptions
  /** Read-side view of the host's outbound audio queue (back-pressure, settle wait). */
  playback?: CallPlayback
  /** Sample rate of the frames pushed with `pushAudio`. Default from defaults.ts. */
  sampleRate?: number
  /** Sample rate of the audio the TTS provider produces. Default from defaults.ts. */
  outboundSampleRate?: number
  outboundQueueMaxMs?: number
  turnTimeoutMs?: number
  sttFinalTimeoutMs?: number
  brainGuards?: BrainGuardOptions
  /**
   * `sentence`: one TTS request per sentence. `continuous`: one stream per
   * reply fed the raw brain text, with a fallback to `sentence` when the
   * stream fails (needs `tts.capabilities.chunkedInput`).
   */
  ttsMode?: "sentence" | "continuous"
  /** Spoken when the brain fails or returns nothing. The text is the product's. */
  failureText?: string
  logPrefix?: string
}

const A = VOICE_DEFAULTS.cascade.audio

const toBuffer = (frame: AudioFrame): Buffer => Buffer.from(frame.pcm16)

/** A per-sentence TTS call on a provider: a stream when it has one, else a file. */
function makeSentenceTts(tts: TtsProvider, voiceId: string | undefined, language: string | undefined, sampleRate: number) {
  return async (input: {
    text: string
    onChunk: (chunk: Buffer) => void | Promise<void>
    signal?: AbortSignal
  }): Promise<void> => {
    if (input.signal?.aborted) return
    if (tts.capabilities.streaming) {
      const stream = await tts.openStream({
        ...(voiceId ? { voiceId } : {}),
        ...(language ? { language } : {}),
        sampleRate,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      await new Promise<void>((resolve, reject) => {
        let chain: Promise<void> = Promise.resolve()
        let finished = false
        const finish = (err?: Error) => {
          if (finished) return
          finished = true
          input.signal?.removeEventListener("abort", onAbort)
          void chain.then(() => (err ? reject(err) : resolve()))
        }
        const onAbort = () => {
          stream.cancel()
          finish()
        }
        input.signal?.addEventListener("abort", onAbort, { once: true })
        stream.on("audio", frame => {
          chain = chain.then(() => input.onChunk(toBuffer(frame)))
        })
        stream.on("done", () => finish())
        stream.on("error", err => finish(err))
        stream.sendText(input.text)
        stream.end()
      }).finally(() => void stream.close().catch(() => undefined))
      return
    }
    const result = await tts.synthesize({
      text: input.text,
      ...(voiceId ? { voiceId } : {}),
      ...(language ? { language } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (input.signal?.aborted) return
    if (result.mimeType !== "audio/pcm") {
      throw new Error(`tts provider "${tts.slug}" synthesize() returned ${result.mimeType}; the cascade needs audio/pcm`)
    }
    await input.onChunk(Buffer.from(result.bytes))
  }
}

/** Adapt an AIP-VOICE `TtsStream` to the structural handle `streamTurn` uses. */
function makeContinuousOpener(tts: TtsProvider, voiceId: string | undefined, language: string | undefined, sampleRate: number): CallTtsStreamOpener {
  return {
    open({ onChunk, signal }): CallTtsStreamHandle {
      let stream: TtsStream | undefined
      // Text pushed before the vendor stream has opened is kept, in order,
      // and sent as soon as it has; it is never dropped.
      let early: string[] = []
      let cancelled = false
      let hadAudio = false
      let chain: Promise<void> = Promise.resolve()
      let resolveClosed!: () => void
      const closed = new Promise<void>(r => (resolveClosed = r))
      const ready = tts
        .openStream({
          ...(voiceId ? { voiceId } : {}),
          ...(language ? { language } : {}),
          sampleRate,
          ...(signal ? { signal } : {}),
        })
        .then(s => {
          if (cancelled) {
            s.cancel()
            return
          }
          stream = s
          s.on("audio", frame => {
            hadAudio = true
            chain = chain.then(() => onChunk(toBuffer(frame)))
          })
          s.on("done", () => resolveClosed())
          s.on("error", () => resolveClosed())
          const queued = early
          early = []
          for (const t of queued) s.sendText(t)
        })
      ready.catch(() => resolveClosed())
      return {
        ready,
        closed,
        pushText: delta => {
          if (stream) stream.sendText(delta)
          else early.push(delta)
        },
        end: async () => {
          await ready.catch(() => undefined)
          stream?.end()
          await closed
          await chain
        },
        abort: () => {
          cancelled = true
          early = []
          stream?.cancel()
          resolveClosed()
        },
        hadAudio: () => hadAudio,
        connectCount: () => 1,
      }
    },
  }
}

/** One-shot transcription through a stream, for a provider with no file call. */
function makeTranscribe(stt: SttProvider, language: string | undefined, finalTimeoutMs: number) {
  return async (
    audio: { pcm16: Int16Array; sampleRate: number },
    opts?: { signal: AbortSignal },
  ): Promise<string> => {
    const bytes = new Uint8Array(audio.pcm16.buffer.slice(audio.pcm16.byteOffset, audio.pcm16.byteOffset + audio.pcm16.byteLength))
    if (stt.capabilities.file) {
      const r = await stt.transcribe(
        { bytes, mimeType: "audio/pcm", sampleRate: audio.sampleRate },
        { ...(language ? { language } : {}), ...(opts?.signal ? { signal: opts.signal } : {}) },
      )
      return r.text
    }
    const stream = await stt.openStream({ sampleRate: audio.sampleRate, ...(language ? { language } : {}), ...(opts?.signal ? { signal: opts.signal } : {}) })
    return await new Promise<string>(resolve => {
      const timer = setTimeout(() => resolve(""), finalTimeoutMs)
      stream.on("final", t => {
        clearTimeout(timer)
        resolve(t.text)
      })
      stream.on("error", () => {
        clearTimeout(timer)
        resolve("")
      })
      stream.pushAudio({ pcm16: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, sampleRate: audio.sampleRate, sequenceNumber: 0 })
      stream.commit()
    }).finally(() => void stream.close().catch(() => undefined))
  }
}

export async function startCascade(opts: VoiceStartOptions & CascadeOptions): Promise<VoiceSession> {
  const { emit, hooks, stt, tts } = opts
  const sampleRate = opts.sampleRate ?? A.inboundSampleRate.value
  const outboundSampleRate = opts.outboundSampleRate ?? A.outboundSampleRate.value
  const finalTimeoutMs = opts.sttFinalTimeoutMs ?? VOICE_DEFAULTS.cascade.stt.finalTimeoutMs.value
  const manual = opts.vad === false
  const vad = opts.vad === false ? {} : (opts.vad ?? {})
  if (!stt.capabilities.streaming && !stt.capabilities.file) {
    throw new Error(`stt provider "${stt.slug}" has neither streaming nor file transcription`)
  }
  if (opts.ttsMode === "continuous" && !tts.capabilities.chunkedInput) {
    throw new Error(`tts provider "${tts.slug}" cannot take chunked input; use ttsMode "sentence"`)
  }

  const meter = makeUsageMeter("cascade")
  let closed = false
  let seq = 0
  let sttSession: SttSession | undefined
  if (stt.capabilities.streaming) {
    try {
      sttSession = await openSttSession(stt, {
        sampleRate,
        ...(opts.language ? { language: opts.language } : {}),
        finalTimeoutMs,
      })
    } catch (err) {
      if (!stt.capabilities.file) throw err
      console.warn(`${opts.logPrefix ?? "[cascade]"} streaming stt did not open, using file transcription`, {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const sentenceTts = makeSentenceTts(tts, opts.voiceId, opts.language, outboundSampleRate)
  const continuous =
    opts.ttsMode === "continuous"
      ? makeContinuousOpener(tts, opts.voiceId, opts.language, outboundSampleRate)
      : undefined

  const deps: CallPipelineDeps = {
    transport: {
      isOpen: () => !closed,
      send: msg => {
        if (msg.type === "audio") {
          const bytes = Buffer.from(String(msg.audio), "base64")
          const frame: AudioFrame = {
            pcm16: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
            sampleRate: Number(msg.sampleRate),
            sequenceNumber: seq++,
          }
          emit.audio(frame)
        } else if (msg.type === "control" && msg.event === "interrupt") {
          emit.interrupt()
        }
      },
    },
    ...(opts.playback ? { playback: opts.playback } : {}),
    ...(opts.outboundQueueMaxMs !== undefined
      ? { outboundQueueMaxMs: opts.outboundQueueMaxMs }
      : { outboundQueueMaxMs: VOICE_DEFAULTS.cascade.playback.outboundQueueMaxMs.value }),
    ...(opts.bargeIn ? { bargeIn: opts.bargeIn } : {}),
    sampleRate,
    outboundSampleRate,
    silenceEndMs: manual ? Infinity : (vad.silenceEndMs ?? VOICE_DEFAULTS.cascade.vad.silenceEndMs.value),
    maxUtteranceMs: manual ? Infinity : (vad.maxUtteranceMs ?? VOICE_DEFAULTS.cascade.vad.maxUtteranceMs.value),
    ...(vad.preRollMs !== undefined ? { preRollMs: vad.preRollMs } : {}),
    ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
    ...(sttSession ? { sttStream: sttSession, sttFinalTimeoutMs: finalTimeoutMs } : {}),
    sttStreamLabel: stt.slug,
    sttFileLabel: stt.slug,
    transcribe: makeTranscribe(stt, opts.language, finalTimeoutMs),
    onSttUsage: u => meter.addSttSeconds(u.provider, u.seconds),
    onTranscript: (text, role) => {
      if (role === "user") emit.userTranscript(text, true)
      else emit.assistantTranscript(text, true)
      void hooks.onTranscript?.({ role, text, finalizedAt: Date.now() })?.catch(() => undefined)
    },
    onTurnEnd: ({ completed, interrupted }) => {
      if (completed && !interrupted) emit.responseComplete()
    },
    onTurn: async ({ text, utteranceId, signal, onChunk }) => {
      const brain = opts.brain({ text, signal: signal as AbortSignal, utteranceId: utteranceId ?? 0 })
      return streamTurnWithSentences(
        {
          brain: async ({ onDelta, signal: s }) => {
            await consumeBrain(brain, onDelta, { ...(opts.brainGuards ?? {}), ...(s ? { signal: s } : {}) })
          },
          tts: sentenceTts,
          ...(continuous ? { ttsStream: continuous } : {}),
          onTtsChars: n => meter.addTtsCharacters(tts.slug, n),
          ...(opts.failureText !== undefined ? { failureText: opts.failureText } : {}),
          ...(opts.logPrefix ? { logPrefix: opts.logPrefix } : {}),
        },
        { text, onChunk, utteranceId, ...(signal ? { signal } : {}) },
      )
    },
    ...(opts.logPrefix ? { logPrefix: opts.logPrefix } : {}),
  }
  const pipeline = createCallPipeline(deps)

  const languages = [...new Set([...stt.capabilities.languages, ...tts.capabilities.languages])]

  return {
    engine: "cascade",
    capabilities: {
      serverVad: false,
      interruption: true,
      functionCalling: false,
      say: false,
      languages,
    },
    pushAudio(frame) {
      if (closed) return
      if (frame.sampleRate !== sampleRate) {
        emit.error(new Error(`cascade expects ${sampleRate} Hz frames, got ${frame.sampleRate}`))
        return
      }
      pipeline.pushFrame(new Int16Array(frame.pcm16))
    },
    async commit() {
      if (manual && !closed) await pipeline.flush()
    },
    async interrupt() {
      pipeline.interrupt()
    },
    getUsage: () => meter.snapshot(),
    async close() {
      if (closed) return
      pipeline.close()
      closed = true
      meter.seal()
    },
  }
}
