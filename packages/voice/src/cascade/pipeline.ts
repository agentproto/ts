/**
 * Sequential call pipeline (the local part of the AIP-VOICE cascade engine).
 *
 * PCM inbound (frames from the transport) is aggregated into utterances with
 * a simple silence VAD, transcribed, handed to `onTurn`, and the reply PCM is
 * pushed back through the transport as pcm16 audio messages.
 *
 * Ported from agentik-studio `projects/simone/apps/voice/src/calls/pipeline.ts`
 * (PRs #995, #1220, #1227, #1279). Removed on purpose, they stay in the
 * product: the endpoint and backchannel shadows (observation logs, never read
 * by the pipeline). Generalised: the STT provider labels are injected.
 *
 * STT/TTS/onTurn are injected so the e2e tests run with mocks.
 */
import { VOICE_DEFAULTS } from "../defaults.js"
import type { SttSession } from "./stt-session.js"

/** The two calls the pipeline makes on its outbound side. */
export interface CascadeTransport {
  send: (msg: Record<string, unknown>) => void | Promise<void>
  isOpen: () => boolean
}

export interface CallPipelineTranscript {
  pcm16: Int16Array
  sampleRate: number
}

export type PlaybackWaitResult = "ready" | "aborted" | "timeout" | "closed"

/** Read-side view of the transport's outbound audio queue. */
export interface CallPlayback {
  /** Audio (ms) accepted by the transport and not yet played. */
  queuedMs: () => number
  /** Resolves once the queue is at or below `ms`. */
  waitBelow: (
    ms: number,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<PlaybackWaitResult>
}

export interface BargeInOptions {
  /** Default true. */
  enabled?: boolean
  /** Continuous caller speech needed to cut the assistant off. Default 300 ms. */
  minSpeechMs?: number
  /**
   * Ignore speech this soon after audio starts playing (the first audio of a
   * turn, and again every time playback restarts from an empty queue).
   * Default 500 ms.
   */
  guardMs?: number
  /**
   * Frame RMS (int16 scale) needed to count as caller speech for barge-in.
   * Above the end-of-speech threshold (500) so the faintest residual echo
   * does not cut the assistant off, but low enough that a soft or AGC-attenuated
   * voice still can: a threshold the caller never reaches would make the stop
   * impossible. Default 1000 (about -30 dBFS), a compromise to calibrate on
   * the per-turn `caller audio` log line.
   */
  rms?: number
}

export interface CallPipelineDeps {
  transport: CascadeTransport
  /** Without it the pipeline cannot see the queue: no bound, no settle wait. */
  playback?: CallPlayback
  /**
   * Max audio (ms) allowed to sit in the outbound queue; the TTS write is
   * held (back-pressure) past it. 0 or unset disables the bound.
   */
  outboundQueueMaxMs?: number
  /** Caller talks over the assistant: abort the turn and purge the queue. */
  bargeIn?: BargeInOptions
  /** Silence kept before the first loud frame of an utterance. Default 300 ms. */
  preRollMs?: number
  /** STT: one finished utterance -> final transcript text. */
  transcribe: (
    audio: CallPipelineTranscript,
    opts?: { signal: AbortSignal }
  ) => Promise<string>
  /**
   * Optional streaming STT session (the stream). When provided and ready, the
   * pipeline pushes each frame as the caller speaks and asks for a final at
   * the local VAD end; the utterance only falls back to `transcribe` when the
   * session is not ready, drops, or misses the bounded final timeout. The PCM
   * buffer is kept in parallel so the fallback never loses audio.
   */
  sttStream?: SttSession
  /** Bounded wait for a streaming final after commit. Default 2000 ms. */
  sttFinalTimeoutMs?: number
  /**
   * Brain turn. Returns reply PCM (mono s16le) or streams chunks via
   * onChunk (same contract as start-voice-server's onTurn).
   */
  onTurn: (input: {
    text: string
    /** Pipeline-local utterance counter, for log correlation. */
    utteranceId?: number
    onChunk: (pcm: Buffer) => void | Promise<void>
    /** Fires when the turn is abandoned (watchdog) or the call closes. */
    signal?: AbortSignal
    /**
     * Fires ONLY on a confirmed caller barge-in (audio/RMS), before the abort
     * and the outbound purge, so the turn can snapshot what had actually
     * played. Distinct from `signal`, which also covers watchdog/hang-up.
     */
    bargeInSignal?: AbortSignal
  }) => Promise<string | void>
  /** Called with each final transcript (conversation persistence / logs). */
  onTranscript?: (text: string, role: "user" | "assistant") => void
  sampleRate?: number
  /**
   * Sample rate of the PCM chunks returned by `onTurn` (TTS output).
   * Inbound STT frames use `sampleRate`; TTS is 24 kHz (ElevenLabs
   * pcm_24000), so stamping inbound rate on outbound audio plays the
   * reply 1.5x too slow. Default 24000.
   */
  outboundSampleRate?: number
  /** Silence that ends an utterance. Default 700 ms. */
  silenceEndMs?: number
  /** Max utterance length before force-flush. Default 30 s. */
  maxUtteranceMs?: number
  /** Drop audio before this many ms of speech. Default 0 (off). */
  minSpeechMs?: number
  /**
   * Watchdog on STT + brain: it fires when this long passes without
   * progress (utterance start, then each reply chunk accepted by the
   * transport). The turn's AbortSignal fires, any late result is discarded
   * (no transcript, no audio, no further steps) and `processing` is released
   * so the caller's next utterance is not ignored. It does NOT cover audio
   * playing out: a long reply that plays normally is never cut by it (the
   * playback wait has its own bound, queued audio + grace). Default 120 s,
   * 0 disables.
   */
  turnTimeoutMs?: number
  /**
   * Seconds of caller audio transcribed for one utterance, with the provider
   * that produced the text, reported once per utterance for per-call billing.
   */
  onSttUsage?: (usage: { provider: string; seconds: number }) => void
  /**
   * Added by the kit (not in the studio pipeline): fired once per processed
   * utterance when its turn ends. `completed` is true when the reply was
   * fully produced and played; `interrupted` when a barge-in, a manual
   * `interrupt()` or a stalled transport cut it. Never fired for a closed
   * call or a turn abandoned by the watchdog.
   */
  onTurnEnd?: (info: { completed: boolean; interrupted: boolean }) => void
  /** Label of the streaming STT in logs and usage. Default `stream`. */
  sttStreamLabel?: string
  /** Label of the file STT fallback in logs and usage. Default `file`. */
  sttFileLabel?: string
  logPrefix?: string
}

export interface CallPipeline {
  /** Added by the kit: cut the running turn now (manual barge-in). No-op when idle. */
  interrupt: () => void
  /** Feed one inbound PCM frame (mono s16le at `sampleRate`). */
  pushFrame: (pcm: Int16Array) => void
  /** Force-flush a partial utterance (optional). */
  flush: () => Promise<void>
  /** Tear down; pending VAD timers are cleared. */
  close: () => void
  /** Latest user transcript (test observability). */
  lastUserTranscript: string | null
  lastAssistantText: string | null
}

// All tuning values come from defaults.ts (one file, each with its origin).
const V = VOICE_DEFAULTS.cascade
const DEFAULT_SILENCE_MS = V.vad.silenceEndMs.value
const DEFAULT_MAX_UTTERANCE_MS = V.vad.maxUtteranceMs.value
const DEFAULT_TURN_TIMEOUT_MS = V.brain.turnTimeoutMs.value
const RMS_SILENCE_THRESHOLD = V.vad.rmsSilenceThreshold.value
const DEFAULT_BARGE_IN_RMS = V.bargeIn.rms.value
// A queue at or under one frame counts as empty when detecting a restart.
const QUEUE_IDLE_MS = V.playback.queueIdleMs.value
// A short burst of caller-level energy (soft echo leak, cough) that is followed
// by this much quiet while the assistant is talking is dropped instead of piling up
// silence in the buffer.
const BLIP_QUIET_MS = V.vad.blipQuietMs.value
const DEFAULT_PRE_ROLL_MS = V.vad.preRollMs.value
// 300 ms: ~1 syllable pair; below it, coughs, door slams and the assistant's own
// echo leaking past the client AEC trigger spurious cuts. Above ~500 ms the
// caller notices the assistant talking over them. Vapi uses 200, LiveKit 500.
const DEFAULT_BARGE_IN_MS = V.bargeIn.minSpeechMs.value
// the assistant's echo reaches the mic ~100-300 ms after the first audio leaves.
const DEFAULT_BARGE_IN_GUARD_MS = V.bargeIn.guardMs.value
// A dip of up to 80 ms (stop consonants, a breath) does not break a run.
const BARGE_IN_GAP_MS = V.bargeIn.gapMs.value
// Extra time granted on top of the audio still queued before the transport
// is declared dead.
const PLAYBACK_SETTLE_GRACE_MS = V.playback.settleGraceMs.value
const BACKPRESSURE_GRACE_MS = V.playback.backpressureGraceMs.value
// Why an utterance was transcribed by the file fallback: no streaming session
// configured (`disabled`), session not ready when the utterance started or
// ended (`not_ready`), part of the speech never reached the stream or the
// stream heard audio the buffer no longer has so its final was discarded
// (`dirty`), no final in time or the socket dropped (`timeout`), the stream
// answered with blank text (`empty`).
type FileReason = "disabled" | "not_ready" | "dirty" | "timeout" | "empty"
type DirtyCause = "trimmed_speech" | "socket_dropped"

function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]!
    sum += v * v
  }
  return Math.sqrt(sum / pcm.length)
}

export function createCallPipeline(deps: CallPipelineDeps): CallPipeline {
  const sampleRate = deps.sampleRate ?? V.audio.inboundSampleRate.value
  const outboundSampleRate = deps.outboundSampleRate ?? V.audio.outboundSampleRate.value
  const silenceEndMs = deps.silenceEndMs ?? DEFAULT_SILENCE_MS
  const maxUtteranceMs = deps.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const preRollSamples = Math.floor(
    ((deps.preRollMs ?? DEFAULT_PRE_ROLL_MS) * sampleRate) / 1000
  )
  const bargeInEnabled = deps.bargeIn?.enabled ?? true
  const bargeInMinMs = deps.bargeIn?.minSpeechMs ?? DEFAULT_BARGE_IN_MS
  const bargeInGuardMs = deps.bargeIn?.guardMs ?? DEFAULT_BARGE_IN_GUARD_MS
  const bargeInRms = deps.bargeIn?.rms ?? DEFAULT_BARGE_IN_RMS
  const queueMaxMs = deps.outboundQueueMaxMs ?? 0
  const playback = deps.playback
  const sttStream = deps.sttStream
  const sttFinalTimeoutMs = deps.sttFinalTimeoutMs ?? V.stt.finalTimeoutMs.value
  const log = deps.logPrefix ?? "[call-pipeline]"
  const streamLabel = deps.sttStreamLabel ?? "stream"
  const fileLabel = deps.sttFileLabel ?? "file"
  const msOf = (samples: number) => Math.round((samples / sampleRate) * 1000)

  // Streaming STT state: audio is pushed only for an utterance the local RMS
  // VAD has opened (so TTS echo during a reply is not streamed), and a commit
  // promise is kept when the VAD ends the utterance while the pipeline is free.
  let streamOpen = false
  // A deferred utterance stops being pushed after its VAD end, so a long
  // reply does not stream minutes of silence; the caller speaking again
  // resumes it (see pushFrame), so only silence is ever held back.
  let streamMuted = false
  // Quiet samples held back since the stream was muted: the tail of the
  // buffer, replayed up to the pre-roll when the caller speaks again.
  let mutedSamples = 0
  // Some speech of the buffered utterance never reached the stream (socket
  // dropped mid-utterance, leading noise trimmed after it was streamed): its
  // transcript would not match the buffer, so the utterance is flushed from
  // the stream and transcribed from the PCM buffer by file STT instead.
  let streamDirty = false
  let streamDirtyCause: DirtyCause | null = null
  let pendingFinal: Promise<string | null> | null = null
  // Why the final requested at the VAD end was not taken (file STT will serve).
  let pendingWhy: FileReason | null = null
  const markDirty = (cause: DirtyCause) => {
    streamDirty = true
    streamDirtyCause ??= cause
  }

  let buffer: Int16Array[] = []
  let bufferSamples = 0
  let speechSamples = 0
  // Quiet samples received since the last loud frame (tail of the buffer).
  let quietTailSamples = 0
  let lastLoudAt = 0
  // Wall-clock instants of the utterance being captured, for the VAD log.
  let speechStartAt = 0
  let processing = false
  // An utterance ended while a turn was running: its audio stays buffered and
  // is processed the moment the turn settles (see processUtterance's finally).
  let utteranceDeferred = false
  // When the VAD ended the deferred utterance (and the last loud frame it
  // covered), so its timing logs measure from the real end of speech.
  let deferredEndAt = 0
  let deferredLastLoudAt = 0
  let closed = false
  let activeTurn: AbortController | undefined
  let utteranceSeq = 0
  const pending: Array<Promise<void>> = []

  // Barge-in state for the turn currently running.
  let turnAudioAt = 0 // first outbound audio of the active turn (0 = none yet)
  let guardFromAt = 0 // last time audio (re)started playing from an empty queue
  let bargeRunStart = 0 // start of the current run of caller speech (0 = none)
  let bargeLastLoudAt = 0
  let bargeTrigger: (() => void) | undefined
  // Aborts the per-turn barge-in signal (see CallPipelineDeps.onTurn);
  // distinct from the turn controller so the consumer can tell a real
  // caller interruption from a watchdog/hang-up abort.
  let bargeAbort: (() => void) | undefined
  let bargeRunPeak = 0 // peak frame RMS of the current run of caller speech
  // Caller-side audio levels over the turn, logged once when it ends so the
  // barge-in threshold can be calibrated on a real call.
  let turnPeakRms = 0
  let turnSoftFrames = 0 // VAD speech (>= 500) below the barge-in threshold
  let turnBargeFrames = 0 // frames at or above the barge-in threshold

  const drainBuffer = (): Int16Array => {
    // A deferred utterance keeps collecting quiet frames until its turn gets
    // its turn: only the end-of-speech silence is worth sending.
    let excess =
      quietTailSamples - Math.floor((silenceEndMs * sampleRate) / 1000)
    while (excess > 0 && buffer.length > 0) {
      const last = buffer[buffer.length - 1]!
      if (last.length <= excess) {
        buffer.pop()
        bufferSamples -= last.length
        excess -= last.length
      } else {
        buffer[buffer.length - 1] = last.subarray(0, last.length - excess)
        bufferSamples -= excess
        excess = 0
      }
    }
    quietTailSamples = 0
    const out = new Int16Array(bufferSamples)
    let off = 0
    for (const chunk of buffer) {
      out.set(chunk, off)
      off += chunk.length
    }
    buffer = []
    bufferSamples = 0
    speechSamples = 0
    speechStartAt = 0
    return out
  }

  // Before the first loud frame only the last `preRollSamples` are worth
  // keeping: the silence that piles up while the assistant speaks or the caller
  // listens would otherwise be uploaded to file STT for nothing.
  const trimLeadingSilence = () => {
    while (
      bufferSamples - buffer[0]!.length >= preRollSamples &&
      buffer.length > 1
    ) {
      bufferSamples -= buffer.shift()!.length
    }
  }

  // Stream the last `samples` of the buffer (held-back silence) to the stream.
  const pushTail = (samples: number) => {
    const tail: Int16Array[] = []
    for (let i = buffer.length - 1; i >= 0 && samples > 0; i--) {
      const chunk = buffer[i]!
      const part =
        chunk.length <= samples ? chunk : chunk.subarray(chunk.length - samples)
      tail.unshift(part)
      samples -= part.length
    }
    for (const chunk of tail) sttStream?.pushAudio(chunk)
  }

  // Final of the utterance being processed: the one requested at the VAD end,
  // or a commit now if the utterance was deferred behind a turn. Null (file STT)
  // when nothing was streamed or the streamed audio is incomplete.
  const takeStreamFinal = (): {
    final: Promise<string | null> | null
    why: FileReason | null
    dirtyCause: DirtyCause | null
  } => {
    const inFlight = pendingFinal
    const earlyWhy = pendingWhy
    const open = streamOpen
    const dirty = streamDirty
    const dirtyCause = streamDirtyCause
    pendingFinal = null
    pendingWhy = null
    streamOpen = false
    streamMuted = false
    mutedSamples = 0
    streamDirty = false
    streamDirtyCause = null
    if (inFlight) return { final: inFlight, why: null, dirtyCause: null }
    if (earlyWhy) return { final: null, why: earlyWhy, dirtyCause }
    if (!sttStream) return { final: null, why: "disabled", dirtyCause: null }
    if (!open) return { final: null, why: "not_ready", dirtyCause: null }
    if (dirty || !sttStream.isReady()) {
      if (sttStream.isReady()) sttStream.discard()
      return {
        final: null,
        why: dirty ? "dirty" : "not_ready",
        dirtyCause: dirty ? dirtyCause : null,
      }
    }
    return {
      final: sttStream.commit(sttFinalTimeoutMs),
      why: null,
      dirtyCause: null,
    }
  }

  async function processUtterance(endAt: number = Date.now()): Promise<void> {
    if (processing) {
      // Sequential by design (no overlapping STT/brain/TTS): keep the audio in
      // the buffer instead of dropping it, and say so once per busy period.
      if (!utteranceDeferred || deferredLastLoudAt !== lastLoudAt) {
        deferredEndAt = endAt
        deferredLastLoudAt = lastLoudAt
      }
      if (!utteranceDeferred) {
        utteranceDeferred = true
        console.warn(
          `${log} speech ended while a turn is running, queued for after it`,
          { bufferedMs: msOf(bufferSamples) }
        )
      }
      return
    }
    // A deferred utterance ended when the VAD said so, not when its turn got
    // its turn; fresh speech since then moves the end forward.
    const speechEndAt =
      utteranceDeferred && deferredLastLoudAt === lastLoudAt
        ? deferredEndAt
        : endAt
    processing = true
    utteranceDeferred = false
    const controller = new AbortController()
    const { signal } = controller
    const bargeController = new AbortController()
    bargeAbort = () => bargeController.abort()
    activeTurn = controller
    turnAudioAt = 0
    guardFromAt = 0
    bargeRunStart = 0
    bargeLastLoudAt = 0
    turnPeakRms = 0
    turnSoftFrames = 0
    turnBargeFrames = 0
    // A turn that was abandoned (watchdog), cut by the caller or whose call
    // closed must not advance: checked after every await below.
    const dead = () => signal.aborted || closed
    let watchdog: ReturnType<typeof setTimeout> | undefined
    // Set when the abort is deliberate (barge-in, stalled transport): not a
    // failure, so no "utterance failed" log and no apology.
    let voluntary = false
    let completed = false
    const startAt = speechStartAt
    const trailingMs = lastLoudAt === 0 ? 0 : speechEndAt - lastLoudAt
    const voluntaryAbort = new Promise<void>(resolve => {
      bargeTrigger = () => {
        voluntary = true
        resolve()
      }
    })
    const stallAbort = (why: string, extra: Record<string, unknown> = {}) => {
      if (dead()) return
      const purgedMs = playback?.queuedMs() ?? 0
      console.warn(
        `${log} playback stalled utt=${id} reason=${why} purged_ms=${Math.round(purgedMs)}`,
        extra
      )
      voluntary = true
      deps.transport.send({ type: "control", event: "interrupt" } as never)
      controller.abort()
    }
    // Inactivity watchdog: re-armed on every sign of progress, disarmed while
    // the transport is playing audio out (that wait has its own bound).
    let rejectWatchdog: (err: Error) => void = () => undefined
    const watchdogFired = new Promise<never>((_, reject) => {
      rejectWatchdog = reject
    })
    watchdogFired.catch(() => undefined)
    const disarmWatchdog = () => clearTimeout(watchdog)
    const armWatchdog = () => {
      disarmWatchdog()
      if (turnTimeoutMs <= 0 || dead()) return
      watchdog = setTimeout(() => {
        controller.abort()
        rejectWatchdog(new Error(`turn exceeded ${turnTimeoutMs}ms`))
      }, turnTimeoutMs)
    }
    const id = ++utteranceSeq
    try {
      const pcm = drainBuffer()
      if (pcm.length === 0) return
      const wavMs = msOf(pcm.length)
      const speechMs =
        startAt === 0 ? 0 : Math.max(0, speechEndAt - startAt - trailingMs)
      console.log(
        `${log} vad utterance utt=${id} start_at=${startAt} end_at=${speechEndAt} speech_ms=${speechMs} trailing_silence_ms=${trailingMs} buffered_ms=${wavMs} queued_ms=${Date.now() - speechEndAt}`
      )
      armWatchdog()
      const turn = (async () => {
        const sttStart = Date.now()
        let text = ""
        let provider = fileLabel
        let usedStream = false
        let whyFile: FileReason | null = null
        let dirtyCause: DirtyCause | null = null
        // A final requested when the VAD ended the utterance (before the turn
        // started) is already in flight; otherwise commit now. The PCM buffer
        // is still intact, so a miss falls back to file STT without losing it.
        const taken = takeStreamFinal()
        whyFile = taken.why
        dirtyCause = taken.dirtyCause
        if (taken.final) {
          const streamText = await taken.final.catch(() => null)
          if (streamText && streamText.trim()) {
            text = streamText.trim()
            provider = streamLabel
            usedStream = true
          } else {
            whyFile = streamText === null ? "timeout" : "empty"
          }
        }
        if (!text && !dead()) {
          text = (
            await deps.transcribe({ pcm16: pcm, sampleRate }, { signal })
          ).trim()
        }
        console.log(
          `${log} stt done utt=${id} stt_ms=${Date.now() - sttStart} wav_ms=${wavMs} chars=${text.length} stt_latency_ms=${Date.now() - speechEndAt} provider=${provider} fallback=${!usedStream && sttStream ? 1 : 0}${!usedStream ? ` reason=${whyFile ?? "disabled"}${dirtyCause ? ` dirty_cause=${dirtyCause}` : ""}` : ""}`
        )
        if (text) {
          try {
            deps.onSttUsage?.({ provider, seconds: wavMs / 1000 })
          } catch {
            // usage metering never affects the turn
          }
        }
        if (!text || dead()) return
        api.lastUserTranscript = text
        deps.onTranscript?.(text, "user")

        const dispatchAt = Date.now()
        console.log(
          `${log} brain dispatch utt=${id} at=${dispatchAt} since_speech_end_ms=${dispatchAt - speechEndAt}`
        )
        let reply = ""
        const returned = await deps.onTurn({
          text,
          utteranceId: id,
          signal,
          bargeInSignal: bargeController.signal,
          onChunk: async chunk => {
            if (dead() || !deps.transport.isOpen()) return
            armWatchdog()
            reply += chunk.toString()
            // Playback (re)starting from an empty queue gets a fresh echo
            // guard: the first audio of a turn, but also a sentence after a
            // filler or a tool wait.
            const restarting = playback
              ? playback.queuedMs() <= QUEUE_IDLE_MS
              : turnAudioAt === 0
            if (restarting) {
              guardFromAt = Date.now()
              bargeRunStart = 0
            }
            if (turnAudioAt === 0) {
              turnAudioAt = Date.now()
              console.log(
                `${log} outbound first audio utt=${id} queue_ms=${Math.round(playback?.queuedMs() ?? 0)}`
              )
            }
            await deps.transport.send({
              type: "audio",
              audio: chunk.toString("base64"),
              format: "pcm16",
              sampleRate: outboundSampleRate,
              channels: 1,
              sequenceNumber: 0,
              timestamp: Date.now(),
            } as never)
            if (playback && queueMaxMs > 0) {
              const queued = playback.queuedMs()
              if (queued > queueMaxMs) {
                disarmWatchdog()
                const r = await playback.waitBelow(queueMaxMs, {
                  signal,
                  timeoutMs: queued - queueMaxMs + BACKPRESSURE_GRACE_MS,
                })
                if (r === "timeout") stallAbort("backpressure-timeout")
                armWatchdog()
              }
            }
          },
        })
        disarmWatchdog()
        if (dead()) return
        const assistantText =
          typeof returned === "string" && returned.trim() ? returned : reply
        if (assistantText) {
          api.lastAssistantText = assistantText
          deps.onTranscript?.(assistantText, "assistant")
        }
        // The turn ends when the caller has heard it, not when the last byte
        // was queued: otherwise the next utterance (and barge-in) would run
        // against audio that is still playing.
        if (playback && turnAudioAt !== 0) {
          const queued = playback.queuedMs()
          if (queued > 0) {
            const r = await playback.waitBelow(0, {
              signal,
              timeoutMs: queued + PLAYBACK_SETTLE_GRACE_MS,
            })
            if (r === "timeout") stallAbort("settle-timeout")
          }
        }
        if (!dead() && !voluntary) completed = true
      })()
      turn.catch(() => undefined)
      const racers: Array<Promise<unknown>> = [
        turn,
        voluntaryAbort,
        watchdogFired,
      ]
      await Promise.race(racers)
    } catch (err) {
      // A hang-up or a deliberate abort is not an error.
      if (!closed && !voluntary) {
        console.error(`${log} utterance failed`, {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      console.log(
        `${log} caller audio utt=${id} peak_rms=${Math.round(turnPeakRms)} soft_frames=${turnSoftFrames} barge_frames=${turnBargeFrames} barge_rms=${bargeInRms} barge_in=${voluntary ? 1 : 0}`
      )
      clearTimeout(watchdog)
      if (!closed && !signal.aborted || voluntary) {
        try {
          deps.onTurnEnd?.({ completed, interrupted: voluntary })
        } catch {
          // an observer never affects the turn
        }
      }
      if (activeTurn === controller) activeTurn = undefined
      bargeTrigger = undefined
      bargeAbort = undefined
      turnAudioAt = 0
      guardFromAt = 0
      bargeRunStart = 0
      processing = false
      // Do not wait for the next inbound frame to notice the queued speech,
      // unless the caller is still talking: the VAD then ends the utterance
      // itself once the sentence is over (cutting it here would split it).
      if (
        utteranceDeferred &&
        !closed &&
        speechSamples > 0 &&
        Date.now() - lastLoudAt >= silenceEndMs
      ) {
        const next = processUtterance()
        pending.push(next)
        void next
      }
    }
  }

  // A burst of noise that was too short to be speech (cough, "mm", echo)
  // can still sit in the buffer, closed by 700 ms of silence and marked as
  // deferred. When the caller then really cuts in, keep only the cut-in (plus
  // pre-roll) as the new utterance, so it is not sent to STT as noise, silence
  // and the first 300 ms of the sentence. A genuine earlier sentence (at least
  // as long as the barge-in minimum) is kept: both go out together.
  const dropLeadingNoise = (runMs: number) => {
    const runSamples = Math.floor((runMs * sampleRate) / 1000)
    const minSamples = Math.floor((bargeInMinMs * sampleRate) / 1000)
    if (speechSamples - runSamples >= minSamples) return
    const keep = runSamples + preRollSamples
    while (buffer.length > 1 && bufferSamples - buffer[0]!.length >= keep) {
      const dropped = buffer.shift()!
      bufferSamples -= dropped.length
      // the stream already heard the dropped chunk. Silence does not change its
      // transcript; a loud chunk might, so only that one forces file STT.
      if (streamOpen && rms(dropped) >= RMS_SILENCE_THRESHOLD) {
        markDirty("trimmed_speech")
      }
    }
    speechSamples = Math.min(speechSamples, runSamples)
    speechStartAt = bargeRunStart
    utteranceDeferred = false
  }

  // Caller speech over a turn that already started talking. Returns true when
  // it fires (once per turn: `bargeTrigger` is consumed).
  const detectBargeIn = (level: number, now: number, frameMs: number) => {
    const loud = level >= bargeInRms
    if (
      !bargeInEnabled ||
      !activeTurn ||
      activeTurn.signal.aborted ||
      !bargeTrigger ||
      turnAudioAt === 0
    ) {
      return
    }
    if (loud) {
      // Speech inside the echo guard is never counted, it cannot start a run.
      if (now - frameMs < guardFromAt + bargeInGuardMs) return
      if (
        bargeRunStart === 0 ||
        now - bargeLastLoudAt > BARGE_IN_GAP_MS + frameMs
      ) {
        bargeRunStart = now - frameMs
        bargeRunPeak = 0
      }
      bargeRunPeak = Math.max(bargeRunPeak, level)
      bargeLastLoudAt = now
      const speechMs = now - bargeRunStart
      if (speechMs < bargeInMinMs) return
      const trigger = bargeTrigger
      bargeTrigger = undefined
      dropLeadingNoise(speechMs)
      const purgedMs = Math.round(playback?.queuedMs() ?? 0)
      console.log(
        `${log} barge-in triggered utt=${utteranceSeq} speech_ms=${speechMs} peak_rms=${Math.round(bargeRunPeak)} purged_ms=${purgedMs} since_audio_ms=${now - turnAudioAt}`
      )
      // Abort first so no late chunk is queued behind the purge. The
      // barge-in signal fires before the abort/purge so the turn can snapshot
      // the played text against the still-full queue.
      bargeAbort?.()
      activeTurn.abort()
      deps.transport.send({ type: "control", event: "interrupt" } as never)
      trigger()
    } else if (bargeRunStart !== 0 && now - bargeLastLoudAt > BARGE_IN_GAP_MS) {
      bargeRunStart = 0
    }
  }

  const api = {
    lastUserTranscript: null as string | null,
    lastAssistantText: null as string | null,

    interrupt(): void {
      if (closed || !activeTurn || activeTurn.signal.aborted) return
      const trigger = bargeTrigger
      bargeTrigger = undefined
      bargeAbort?.()
      activeTurn.abort()
      deps.transport.send({ type: "control", event: "interrupt" } as never)
      trigger?.()
    },

    pushFrame(pcm: Int16Array): void {
      if (closed || pcm.length === 0) return
      const frameMs = (pcm.length / sampleRate) * 1000
      const level = rms(pcm)
      const loud = level >= RMS_SILENCE_THRESHOLD
      const now = Date.now()
      // The local RMS VAD remains the source of truth for end of utterance.
      // Streaming starts on the first loud frame of an utterance and sends the
      // pre-roll buffered before it; only VAD-confirmed speech reaches the stream,
      // so the TTS echo during a reply is never streamed.
      const starting = loud && speechSamples === 0
      if (starting && sttStream?.isReady() && !streamOpen) {
        for (const chunk of buffer) sttStream.pushAudio(chunk)
        streamOpen = true
      }
      // The caller speaks again after the VAD end of an utterance deferred
      // behind a turn: resume streaming with the end of the held-back silence
      // as pre-roll. Only silence was skipped, which does not change the
      // transcript, so the stream still matches the buffer and serves the turn.
      if (loud && streamMuted) {
        streamMuted = false
        if (streamOpen && sttStream?.isReady()) {
          pushTail(Math.min(mutedSamples, preRollSamples))
        }
        mutedSamples = 0
      }
      buffer.push(pcm)
      bufferSamples += pcm.length
      if (streamOpen && sttStream) {
        if (streamMuted) {
          // A drop while held back loses what the stream heard of the utterance.
          if (!sttStream.isReady()) markDirty("socket_dropped")
          mutedSamples += pcm.length
        } else if (sttStream.isReady()) {
          sttStream.pushAudio(pcm)
        } else {
          markDirty("socket_dropped")
        }
      }
      if (processing) {
        turnPeakRms = Math.max(turnPeakRms, level)
        if (level >= bargeInRms) turnBargeFrames++
        else if (loud) turnSoftFrames++
      }
      if (loud) {
        lastLoudAt = now
        quietTailSamples = 0
        if (speechSamples === 0) speechStartAt = now - Math.round(frameMs)
        speechSamples += pcm.length
      } else {
        quietTailSamples += pcm.length
        if (speechSamples === 0) {
          trimLeadingSilence()
        } else if (
          processing &&
          turnAudioAt !== 0 &&
          speechSamples < Math.floor((bargeInMinMs * sampleRate) / 1000) &&
          now - lastLoudAt >= Math.min(BLIP_QUIET_MS, silenceEndMs)
        ) {
          // Too short to be speech and the assistant is talking: a soft echo leak or
          // a cough. Forget it, so the quiet of the whole reply is not kept,
          // and flush the stream so the echo cannot leak into the next utterance.
          speechSamples = 0
          speechStartAt = 0
          utteranceDeferred = false
          trimLeadingSilence()
          if (streamOpen) {
            if (sttStream?.isReady()) sttStream.discard()
            streamOpen = false
            streamMuted = false
            mutedSamples = 0
            streamDirty = false
            streamDirtyCause = null
          }
        }
      }
      detectBargeIn(level, now, frameMs)

      const bufferedMs = (bufferSamples / sampleRate) * 1000
      const silentMs = lastLoudAt === 0 ? 0 : now - lastLoudAt
      const hasSpeech = speechSamples > 0
      if (
        hasSpeech &&
        (silentMs >= silenceEndMs || bufferedMs >= maxUtteranceMs)
      ) {
        // Commit at the VAD end, before the turn starts, so the stream finishes
        // while the pipeline is still setting up. A deferred utterance (a turn
        // is running) commits when it is finally processed; until then its
        // trailing silence is not streamed (streamMuted) unless the caller
        // speaks again.
        if (!processing && streamOpen) {
          const early = takeStreamFinal()
          pendingFinal = early.final
          pendingWhy = early.final ? null : early.why
          if (early.dirtyCause) streamDirtyCause = early.dirtyCause
        } else if (processing) {
          streamMuted = true
        }
        const p = processUtterance(now)
        pending.push(p)
        void p
      }
    },

    async flush(): Promise<void> {
      if (bufferSamples > 0 && speechSamples > 0) {
        const p = processUtterance()
        pending.push(p)
        await p
      }
      await Promise.allSettled(pending)
    },

    close(): void {
      closed = true
      if (speechSamples > 0) {
        console.warn(`${log} call closed with untranscribed speech, dropped`, {
          bufferedMs: msOf(bufferSamples),
          queuedBehindTurn: utteranceDeferred,
        })
      }
      activeTurn?.abort()
      sttStream?.close()
      buffer = []
      bufferSamples = 0
    },
  } as CallPipeline
  return api
}
