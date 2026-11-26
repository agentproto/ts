/**
 * The `cascade` engine of AIP-VOICE: STT provider, a host brain, TTS provider,
 * with the local VAD, barge-in, bounded outbound queue and brain guards of
 * `createCallPipeline` (ported from the studio call pipeline).
 *
 * `startCascade` is the entry point:
 *
 *     startCascade(opts: VoiceStartOptions & CascadeOptions): Promise<VoiceSession>
 *
 * `emit`, `hooks`, `onUsage`, `language` and `voiceId` come from `VoiceStartOptions`.
 * `brain` yields reply TEXT; this engine owns synthesis, so the brain never
 * returns audio and the TTS provider is replaceable by configuration.
 */
import { VOICE_DEFAULTS } from "../defaults.js"
import { deliverUsage, makeUsageMeter } from "../usage.js"
import { createProcessorRuntime, type BrainEvent, type TextChunk } from "../processors.js"
import { Pcm16ChunkAligner } from "../pcm16.js"
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
import { createSttDedup, type SttDedupOptions } from "./stt-dedup.js"

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
  brain(input: CascadeBrainInput): AsyncIterable<string | BrainEvent>
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
   * stream fails (needs `tts.capabilities.chunkedInput`). The studio
   * spellings `http-sentence` / `ws-continuous` (`VOICE_TTS_MODE`) are
   * accepted and mean the same. Default from defaults.ts: `sentence`.
   */
  ttsMode?: "sentence" | "continuous" | "http-sentence" | "ws-continuous"
  /**
   * Per-sentence TTS transport. `stream`: the provider's streaming socket
   * when it has one. `http`: the one-shot call only, so an operator can
   * opt out of a flaky socket (`VOICE_TTS_TRANSPORT=http` in the studio).
   * Default from defaults.ts: `stream`.
   */
  ttsTransport?: "stream" | "http"
  /**
   * Transcript dedup (three-guard, see cascade/stt-dedup.ts). `false`
   * disables it; a partial object overrides the kit defaults field by
   * field. Default: the kit defaults (on).
   */
  sttDedup?: false | Partial<SttDedupOptions>
  /**
   * Close the session after this long without an inbound mic frame
   * (`pushAudio`); the mic-idle hook of `hooks` is called first. Some
   * vendors bill the open socket second, so a forgotten session must not
   * stay alive. 0 keeps the session open forever. Default from
   * defaults.ts: 60 s.
   */
  idleMicMs?: number
  /** Spoken when the brain fails or returns nothing. The text is the product's. */
  failureText?: string
  logPrefix?: string
}

const A = VOICE_DEFAULTS.cascade.audio

const toBuffer = (frame: AudioFrame): Buffer => Buffer.from(frame.pcm16)

/** A per-sentence TTS call on a provider: a stream when it has one, else a file. */
function makeSentenceTts(tts: TtsProvider, voiceId: string | undefined, language: string | undefined, sampleRate: number, preferStream: boolean) {
  return async (input: {
    text: string
    onChunk: (chunk: Buffer) => void | Promise<void>
    signal?: AbortSignal
  }): Promise<void> => {
    if (input.signal?.aborted) return
    // `http` transport opts out of the streaming socket, but a provider
    // that can only stream still streams: no transport ever fails a turn.
    const useStream = tts.capabilities.streaming && (preferStream || !tts.capabilities.file)
    if (useStream) {
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
  // `ws-continuous` (studio spelling of VOICE_TTS_MODE) maps to the kit's
  // `continuous`; every other value is the per-sentence mode.
  const ttsContinuous =
    (opts.ttsMode ?? VOICE_DEFAULTS.tts.mode.value) === "ws-continuous" ||
    opts.ttsMode === "continuous"
  const ttsTransport = opts.ttsTransport ?? VOICE_DEFAULTS.tts.transport.value
  const idleMicMs = opts.idleMicMs ?? VOICE_DEFAULTS.session.idleMicMs.value
  const manual = opts.vad === false
  const vad = opts.vad === false ? {} : (opts.vad ?? {})
  if (!stt.capabilities.streaming && !stt.capabilities.file) {
    throw new Error(`stt provider "${stt.slug}" has neither streaming nor file transcription`)
  }
  if (ttsContinuous && !tts.capabilities.chunkedInput) {
    throw new Error(`tts provider "${tts.slug}" cannot take chunked input; use ttsMode "sentence"`)
  }

  // Mount-time validation: a bad processor array throws here, before any socket.
  const runtime = opts.processors?.length
    ? createProcessorRuntime({
        processors: opts.processors,
        callId: globalThis.crypto.randomUUID(),
        ...(opts.language ? { language: opts.language } : {}),
        onEvent: e => hooks.onProcessorEvent?.(e),
        budgetMs: {
          audioIn: VOICE_DEFAULTS.processors.budgetMs.audioIn.value,
          audioOut: VOICE_DEFAULTS.processors.budgetMs.audioOut.value,
          transcript: VOICE_DEFAULTS.processors.budgetMs.transcript.value,
          textOut: VOICE_DEFAULTS.processors.budgetMs.textOut.value,
        },
      })
    : undefined
  // The cascade engine runs textOut; the other points are reserved.
  runtime?.reportReserved(["audioIn", "transcript", "audioOut"])
  const meter = makeUsageMeter("cascade")
  let closed = false
  let seq = 0
  // Every outbound frame is even-aligned PCM16 (see pcm16.ts): a vendor
  // chunk with an odd byte never reaches the caller as a half-sample.
  const audioAligner = new Pcm16ChunkAligner()
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

  const sentenceTts = makeSentenceTts(tts, opts.voiceId, opts.language, outboundSampleRate, ttsTransport === "stream")
  const continuous =
    ttsContinuous
      ? makeContinuousOpener(tts, opts.voiceId, opts.language, outboundSampleRate)
      : undefined
  const dedup = opts.sttDedup === false ? undefined : createSttDedup(opts.sttDedup ?? {})

  // Mic-idle pause: some vendors bill the open socket per second, so a
  // session whose mic went quiet closes itself and tells the host (the
  // host starts a fresh session when the caller comes back). 0 disables.
  let micIdleTimer: ReturnType<typeof setTimeout> | undefined
  const disarmMicIdle = () => {
    clearTimeout(micIdleTimer)
    micIdleTimer = undefined
  }
  const armMicIdle = () => {
    if (idleMicMs <= 0) return
    disarmMicIdle()
    micIdleTimer = setTimeout(() => {
      if (closed) return
      console.log(
        `${opts.logPrefix ?? "[cascade]"} mic idle ${idleMicMs}ms — closing the session`,
      )
      try {
        Promise.resolve(hooks.onMicIdle?.({ idleMs: idleMicMs })).catch(() => undefined)
      } catch {
        // the idle hook never affects the close
      }
      void closeSession()
    }, idleMicMs)
  }
  const closeSession = async (): Promise<void> => {
    if (closed) return
    disarmMicIdle()
    pipeline.close()
    closed = true
    runtime?.close()
    meter.seal()
    await deliverUsage(opts.onUsage, meter.snapshot())
  }
  const deps: CallPipelineDeps = {
    transport: {
      isOpen: () => !closed,
      send: msg => {
        if (msg.type === "audio") {
          const bytes = Buffer.from(String(msg.audio), "base64")
          // Even-align so an odd vendor byte never becomes a half-sample.
          const aligned = audioAligner.push(bytes)
          if (aligned.byteLength === 0) return
          const frame: AudioFrame = {
            pcm16: aligned.buffer.slice(aligned.byteOffset, aligned.byteOffset + aligned.byteLength) as ArrayBuffer,
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
    ...(dedup ? { sttDedup: dedup } : {}),
    sampleRate,
    outboundSampleRate,
    silenceEndMs: manual ? Infinity : (vad.silenceEndMs ?? VOICE_DEFAULTS.cascade.vad.silenceEndMs.value),
    maxUtteranceMs: manual ? Infinity : (vad.maxUtteranceMs ?? VOICE_DEFAULTS.cascade.vad.maxUtteranceMs.value),
    ...(vad.preRollMs !== undefined ? { preRollMs: vad.preRollMs } : {}),
    ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
    ...(sttSession ? { sttStream: sttSession, sttFinalTimeoutMs: finalTimeoutMs } : {}),
    sttStreamLabel: stt.slug,
    sttFileLabel: stt.slug,
    ...(stt.models?.stream ? { sttStreamModel: stt.models.stream } : {}),
    ...(stt.models?.file ? { sttFileModel: stt.models.file } : {}),
    transcribe: makeTranscribe(stt, opts.language, finalTimeoutMs),
    onSttUsage: u => meter.addSttSeconds(u.provider, u.seconds, u.model),
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
      // textOut: every brain chunk goes through the processors before the
      // sentence splitter and the TTS. The transcript shown to the host keeps
      // the brain's own text; the TTS, and the usage counted from it, get the
      // processed one.
      let rawText = ""
      let spokenText = ""
      const useTextOut = runtime?.has("textOut") === true
      const spoken = await streamTurnWithSentences(
        {
          brain: async ({ onDelta, signal: s }) => {
            if (!useTextOut || !runtime) {
              await consumeBrain(brain, onDelta, { ...(opts.brainGuards ?? {}), ...(s ? { signal: s } : {}) })
              return
            }
            const scope = { ...(utteranceId !== undefined ? { utteranceId } : {}), signal: s ?? new AbortController().signal }
            let tail: Promise<void> = Promise.resolve()
            const feed = (chunk: TextChunk) => {
              tail = tail.catch(() => undefined).then(async () => {
                const outs = await runtime.process("textOut", chunk, scope)
                for (const o of outs) {
                  if (!o.text) continue
                  spokenText += o.text
                  onDelta(o.text)
                }
              })
            }
            try {
              await consumeBrain(
                brain,
                d => {
                  rawText += d
                  feed({ text: d })
                },
                {
                  ...(opts.brainGuards ?? {}),
                  ...(s ? { signal: s } : {}),
                  onEvent: (event: BrainEvent) => feed({ text: "", event }),
                },
              )
              // The brain is done: tell the chain, so a transformer that holds
              // text back can release it with the chunk that carries `end`.
              feed({ text: "", end: true })
            } finally {
              // Whatever happened to the brain, what was already fed settles
              // before the turn goes on (and a failed feed never poisons it).
              await tail.catch(() => undefined)
            }
          },
          tts: sentenceTts,
          ...(continuous ? { ttsStream: continuous } : {}),
          onTtsChars: n => meter.addTtsCharacters(tts.slug, n, tts.model),
          ...(opts.failureText !== undefined ? { failureText: opts.failureText } : {}),
          ...(opts.logPrefix ? { logPrefix: opts.logPrefix } : {}),
        },
        { text, onChunk, utteranceId, ...(signal ? { signal } : {}) },
      )
      // Keep the brain's own words in the transcript; anything the engine added
      // after them (a failure apology) stays as is.
      return useTextOut && spoken.startsWith(spokenText)
        ? rawText + spoken.slice(spokenText.length)
        : spoken
    },
    ...(opts.logPrefix ? { logPrefix: opts.logPrefix } : {}),
  }
  const pipeline = createCallPipeline(deps)
  // Armed only once `pipeline` exists: the timer callback closes through it.
  armMicIdle()

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
      armMicIdle()
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
    ...(runtime ? { getProcessorStats: () => runtime.stats() } : {}),
    close: closeSession,
  }
}

/**
 * Operator tuning for the turn-level TTS mode, read from `VOICE_TTS_MODE`
 * (the studio name): `http-sentence` (default) keeps one TTS request per
 * sentence, `ws-continuous` streams the brain's raw deltas into one vendor
 * stream per reply. Invalid or unset keeps the kit default; the kit
 * spellings (`sentence`, `continuous`) are also accepted.
 */
export function ttsModeFromEnv(
  value: string | undefined,
): "sentence" | "continuous" | undefined {
  const v = value?.trim().toLowerCase()
  if (!v) return undefined
  if (v === "ws-continuous" || v === "continuous") return "continuous"
  if (v === "http-sentence" || v === "sentence") return "sentence"
  return undefined
}

/**
 * Operator opt-out of the per-sentence TTS socket, read from
 * `VOICE_TTS_TRANSPORT` (the studio name): `http` forces one-shot
 * synthesis when the provider offers it, anything else keeps the stream.
 */
export function ttsTransportFromEnv(
  value: string | undefined,
): "stream" | "http" | undefined {
  const v = value?.trim().toLowerCase()
  if (!v) return undefined
  if (v === "http") return "http"
  if (v === "ws" || v === "stream") return "stream"
  return undefined
}
