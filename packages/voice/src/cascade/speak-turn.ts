/**
 * One reply turn of the cascade: brain text deltas to TTS audio.
 *
 * Ported from agentik-studio `projects/simone/apps/voice/src/calls/stream-turn.ts`
 * (PRs #1114, #1226). Kept: per-sentence TTS, the continuous-stream mode with
 * its fallback to per-sentence TTS, the brain-failure apology (the text is
 * the product's), characters-sent metering. Removed on purpose, they stay in
 * the product: tool-wait filler phrases, the played-text snapshot from TTS
 * alignment, and the interrupted-context hand-back.
 */
import { VOICE_DEFAULTS } from "../defaults.js"
import { SentencePipeliner } from "./sentence-pipeliner.js"

/**
 * One continuous TTS socket for a reply turn (ElevenLabs WS `stream-input`).
 * The turn pushes the brain's text deltas straight into it; the server chunks
 * with `chunk_length_schedule` and PCM surfaces through the opener's
 * `onChunk`. Declared structurally so the call pipeline can be tested with a
 * fake; `startCascade` adapts an AIP-VOICE `TtsStream` to it.
 */
export interface CallTtsStreamHandle {
  /** Resolves on WS open; rejects on handshake error or timeout. */
  ready: Promise<void>
  /** Resolves when the socket closed (end, abort or failure). */
  closed: Promise<void>
  pushText: (delta: string) => void
  /** End of turn: EOS + await the server close (audio drained). */
  end: () => Promise<void>
  abort: () => void
  hadAudio: () => boolean
  /** Handshakes seen (>1 means the socket reconnected mid-turn). */
  connectCount: () => number
}

export interface CallTtsStreamOpener {
  open: (input: {
    onChunk: (chunk: Buffer) => void | Promise<void>
    signal?: AbortSignal
  }) => CallTtsStreamHandle
  /** Max wait for the WS handshake before falling back. Default 1500 ms. */
  openTimeoutMs?: number
  /**
   * Max silence from a socket that has enough unvoiced text to speak before
   * the turn falls back to the HTTP path. Default 2500 ms.
   */
  stallTimeoutMs?: number
  /**
   * After the end-of-turn EOS: max time without a new audio chunk before the
   * drain is abandoned and the turn falls back. Default 3000 ms.
   */
  drainIdleTimeoutMs?: number
}

const C = VOICE_DEFAULTS.tts.continuous
// The vendor only generates once its buffer reaches its chunk schedule, so a
// short push is legitimately silent. The stall watchdog arms only once more
// text than the relevant threshold has been pushed without any audio coming
// back.
const WS_FIRST_AUDIO_ARM_CHARS = C.firstAudioArmChars.value
const WS_MID_TURN_ARM_CHARS = C.midTurnArmChars.value

// The vendor audio lags the pushed text, so the text already voiced is
// estimated from the audio delivered (the replay boundary): pcm16 24 kHz mono
// at a deliberately slow rate, so the estimate falls short of the truth and a
// fallback repeats a little rather than dropping text.
const WS_AUDIO_BYTES_PER_SECOND = C.audioBytesPerSecond.value
const WS_SLOW_SPEECH_CHARS_PER_SECOND = C.slowSpeechCharsPerSecond.value

/**
 * Where to resume per-sentence TTS when the WS died after speaking: the start
 * of the sentence containing the estimated voiced position. Errs on the side
 * of repeating a sentence start rather than dropping text.
 */
function replayBoundary(text: string, spokenUpTo: number): number {
  const head = text.slice(0, spokenUpTo)
  let boundary = 0
  for (const m of head.matchAll(/[.!?\u2026]+["')\]\u00bb]*\s+|\n+/g)) {
    boundary = (m.index ?? 0) + m[0].length
  }
  return boundary
}

export interface CallStreamTurnDeps {
  /**
   * Characters sent to TTS during this turn (WS + HTTP, apology included),
   * reported once when the turn ends, for per-call billing.
   */
  onTtsChars?: (chars: number) => void
  brain: (input: {
    text: string
    onDelta: (delta: string) => void
    signal?: AbortSignal
  }) => Promise<string | void>
  tts: (input: {
    text: string
    onChunk: (chunk: Buffer) => void | Promise<void>
    signal?: AbortSignal
  }) => Promise<void>
  minSentenceLength?: number
  /** See `SentencePipelinerOptions.firstClauseMinLength`. */
  firstClauseMinLength?: number
  /**
   * Continuous TTS mode: one WS per turn, fed the brain's raw deltas (the
   * server chunks via `chunk_length_schedule`). When unset, or when the WS
   * does not open before `openTimeoutMs`, or when it dies before producing
   * any audio, the turn falls back to the per-sentence `tts` path above.
   * The mode is chosen per turn; the failure/abort behavior is
   * identical in both modes.
   */
  ttsStream?: CallTtsStreamOpener
  logPrefix?: string
  /**
   * Spoken (via `deps.tts`) when `brain` throws - stalled, timed out or
   * failed - so the caller hears an apology instead of silence. Without it
   * the error propagates unchanged.
   */
  failureText?: string
}

export interface CallStreamTurnInput {
  text: string
  /** Awaited by the TTS writer: a pending promise is back-pressure. */
  onChunk: (chunk: Buffer) => void | Promise<void>
  /** Pipeline utterance counter, only used to correlate log lines. */
  utteranceId?: number
  /** Abandoned turn: cancels brain/tts work, no apology. */
  signal?: AbortSignal
}

interface TtsMeter {
  wsChars: number
  wsPushes: number
  wsEos: number
  httpChars: number
  httpCalls: number
}

export async function streamTurnWithSentences(
  deps: CallStreamTurnDeps,
  input: CallStreamTurnInput
): Promise<string> {
  const meter: TtsMeter = {
    wsChars: 0,
    wsPushes: 0,
    wsEos: 0,
    httpChars: 0,
    httpCalls: 0,
  }
  try {
    return await runStreamTurn(deps, input, meter)
  } finally {
    try {
      deps.onTtsChars?.(meter.wsChars + meter.httpChars)
    } catch {
      // usage metering never affects the turn
    }
    const mode = deps.ttsStream ? "ws-continuous" : "http-sentence"
    console.log(
      `${deps.logPrefix ?? "[call-session]"} tts chars utt=${input.utteranceId ?? 0} mode=${mode} ws_chars=${meter.wsChars} ws_pushes=${meter.wsPushes} ws_eos=${meter.wsEos} http_chars=${meter.httpChars} http_calls=${meter.httpCalls} aborted=${input.signal?.aborted ? 1 : 0}`
    )
  }
}

async function runStreamTurn(
  deps: CallStreamTurnDeps,
  input: CallStreamTurnInput,
  meter: TtsMeter
): Promise<string> {
  const logPrefix = deps.logPrefix ?? "[call-session]"
  // Text accumulated for the turn (deltas + non-streamed reply): the return
  // value.
  let full = ""
  // ── Continuous (WS) TTS mode ────────────────────────────────────────
  // `wsFailed` flips once the WS is abandoned (never opened, error, closed
  // unexpectedly, or mute past a bounded wait). After that every delta goes
  // through the sentence pipeliner/HTTP path and the text the WS did not
  // voice is replayed (all of it if nothing was heard yet, otherwise from the
  // sentence the last audio belonged to; see `replayBoundary`).
  const wsEnabled = deps.ttsStream !== undefined
  const wsOpenTimeoutMs = deps.ttsStream?.openTimeoutMs ?? C.openTimeoutMs.value
  const wsStallTimeoutMs = deps.ttsStream?.stallTimeoutMs ?? C.stallTimeoutMs.value
  const wsDrainIdleTimeoutMs = deps.ttsStream?.drainIdleTimeoutMs ?? C.drainIdleTimeoutMs.value
  const utteranceId = input.utteranceId ?? 0
  let wsStream: CallTtsStreamHandle | null = null
  let wsReady = false
  let wsFailed = false
  let wsEnding = false
  let wsPushedAny = false
  let wsOpenAt = 0
  let wsFirstChunkAt = 0
  let wsPushChain: Promise<void> = Promise.resolve()
  // Replay source for a fallback: every text routed to the WS (deltas, the
  // non-streamed reply, the apology), in order.
  let wsText = ""
  // Chars handed to the socket, how many had been when the last audio chunk
  // reached the caller (the stall watchdog baseline), and the audio delivered.
  let wsSentLen = 0
  let wsLenAtLastAudio = 0
  let wsAudioBytes = 0
  let wsFinishing = false
  let wsOpenTimer: ReturnType<typeof setTimeout> | undefined
  let wsStallTimer: ReturnType<typeof setTimeout> | undefined
  let wsOnActivity: (() => void) | undefined

  const clearWsTimers = () => {
    clearTimeout(wsOpenTimer)
    clearTimeout(wsStallTimer)
    wsStallTimer = undefined
  }

  const fallbackToHttp = (why: string) => {
    if (!wsEnabled || wsFailed) return
    // A cut-off turn is not a fallback case: nothing more will be spoken.
    if (input.signal?.aborted) return
    wsFailed = true
    clearWsTimers()
    const heard = wsStream?.hadAudio() ?? false
    const voicedEstimate = Math.min(
      wsLenAtLastAudio,
      Math.floor(
        (wsAudioBytes / WS_AUDIO_BYTES_PER_SECOND) *
          WS_SLOW_SPEECH_CHARS_PER_SECOND
      )
    )
    const from = heard ? replayBoundary(wsText, voicedEstimate) : 0
    console.log(
      `${logPrefix} tts mode=ws-continuous fallback=http-sentence utt=${utteranceId} reason=${why} heard=${heard ? 1 : 0} replay_from=${from}`
    )
    // abort() also drops audio still queued inside the stream, so the HTTP
    // replay never overlaps WS audio.
    try {
      wsStream?.abort()
    } catch {
      /* ignore */
    }
    const rest = wsText.slice(from)
    if (rest) pipeliner.push(rest)
  }

  /** Arm the mute watchdog once enough text is waiting on audio. */
  const armStall = () => {
    if (wsStallTimer || wsFailed || wsEnding || wsFinishing || !wsStream) return
    const waiting = wsSentLen - wsLenAtLastAudio
    const armAt = wsStream.hadAudio()
      ? WS_MID_TURN_ARM_CHARS
      : WS_FIRST_AUDIO_ARM_CHARS
    if (waiting < armAt) return
    wsStallTimer = setTimeout(() => {
      wsStallTimer = undefined
      fallbackToHttp(`stalled-no-audio-${wsStallTimeoutMs}ms`)
    }, wsStallTimeoutMs)
  }

  if (wsEnabled && deps.ttsStream) {
    wsOpenAt = Date.now()
    try {
      wsStream = deps.ttsStream.open({
        onChunk: chunk => {
          wsLenAtLastAudio = wsSentLen
          wsAudioBytes += chunk.length
          clearTimeout(wsStallTimer)
          wsStallTimer = undefined
          wsOnActivity?.()
          if (wsFirstChunkAt === 0) {
            wsFirstChunkAt = Date.now()
            console.log(
              `${logPrefix} tts-stream first audio utt=${utteranceId} ttfb_ms=${wsFirstChunkAt - wsOpenAt}`
            )
          }
          return input.onChunk(chunk)
        },
        ...(input.signal ? { signal: input.signal } : {}),
      })
    } catch (err) {
      wsFailed = true
      console.warn(`${logPrefix} tts-stream open threw`, {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    if (wsStream) {
      const stream = wsStream
      wsOpenTimer = setTimeout(() => {
        if (!wsReady && !wsFailed) fallbackToHttp("open-timeout")
      }, wsOpenTimeoutMs)
      stream.ready
        .then(() => {
          wsReady = true
          clearTimeout(wsOpenTimer)
          console.log(
            `${logPrefix} tts-stream ready utt=${utteranceId} open_ms=${Date.now() - wsOpenAt}`
          )
        })
        .catch(err => {
          clearTimeout(wsOpenTimer)
          fallbackToHttp(
            `open-failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      stream.closed.then(() => {
        if (wsEnding) return
        fallbackToHttp(
          stream.hadAudio() ? "closed-mid-turn" : "closed-before-audio"
        )
      })
    }
  }

  /** Queue a delta to the WS, in order. */
  const pushToWs = (delta: string) => {
    if (!delta) return
    wsPushChain = wsPushChain
      .then(async () => {
        if (input.signal?.aborted || wsFailed || !wsStream) return
        if (!wsPushedAny) {
          wsPushedAny = true
          console.log(
            `${logPrefix} tts-stream first token pushed utt=${utteranceId} ms=${Date.now() - wsOpenAt}`
          )
        }
        wsSentLen += delta.length
        meter.wsChars += delta.length
        meter.wsPushes++
        wsStream.pushText(delta)
        armStall()
      })
      .catch(err => {
        // A throwing push must neither reject the chain nor fail the turn.
        fallbackToHttp(
          `push-failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  /** Send EOS and wait for the socket to drain, bounded by an idle timeout. */
  const drainWs = (stream: CallTtsStreamHandle) =>
    new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (ok: boolean) => {
        clearTimeout(timer)
        wsOnActivity = undefined
        resolve(ok)
      }
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish(false), wsDrainIdleTimeoutMs)
      }
      wsOnActivity = arm
      arm()
      meter.wsEos++
      stream.end().then(
        () => finish(true),
        () => finish(false)
      )
    })

  /**
   * Drain the WS at end of turn. Returns true when the WS voiced the turn;
   * false when it was abandoned and the text went to the HTTP pipeliner (the
   * caller must then flush it).
   */
  const finishWs = async (): Promise<boolean> => {
    if (!wsEnabled || wsFailed || !wsStream) return false
    const stream = wsStream
    wsFinishing = true
    clearTimeout(wsStallTimer)
    wsStallTimer = undefined
    await wsPushChain
    if (wsFailed) return false
    wsEnding = true
    const drained = await drainWs(stream)
    clearWsTimers()
    if (input.signal?.aborted) return true
    if (!drained) fallbackToHttp(`drain-timeout-${wsDrainIdleTimeoutMs}ms`)
    else if (!stream.hadAudio() && wsText.trim())
      fallbackToHttp("ended-without-audio")
    if (wsFailed) return false
    console.log(
      `${logPrefix} tts mode=ws-continuous utt=${utteranceId} reconnects=${Math.max(0, stream.connectCount() - 1)} audio=${stream.hadAudio() ? 1 : 0}`
    )
    return true
  }

  const abandonWs = () => {
    clearWsTimers()
    try {
      wsStream?.abort()
    } catch {
      /* ignore */
    }
  }

  let sentenceSeq = 0
  const pipeliner = new SentencePipeliner({
    onSentence: async sentence => {
      if (input.signal?.aborted) return
      const n = ++sentenceSeq
      const ttsStart = Date.now()
      let sawChunk = false
      try {
        meter.httpChars += sentence.length
        meter.httpCalls++
        await deps.tts({
          text: sentence,
          onChunk: chunk => {
            if (!sawChunk) {
              sawChunk = true
              console.log(
                `${logPrefix} tts first chunk utt=${input.utteranceId ?? 0} sentence=${n} ttfb_ms=${Date.now() - ttsStart} chars=${sentence.length}`
              )
            }
            return input.onChunk(chunk)
          },
          signal: input.signal,
        })
      } catch (err) {
        // A cut-off turn (barge-in, hang-up) aborts its own TTS on purpose.
        if (!input.signal?.aborted) throw err
      }
    },
    ...(deps.minSentenceLength !== undefined
      ? { minLength: deps.minSentenceLength }
      : {}),
    ...(deps.firstClauseMinLength !== undefined
      ? { firstClauseMinLength: deps.firstClauseMinLength }
      : {}),
    ...(deps.logPrefix ? { logPrefix: deps.logPrefix } : {}),
  })

  let sawDelta = false

  let reply: string | void = undefined
  let brainFailure: { err: unknown } | undefined
  if (wsEnabled) {
    console.log(`${logPrefix} tts mode=ws-continuous utt=${utteranceId}`)
  } else {
    console.log(`${logPrefix} tts mode=http-sentence utt=${utteranceId}`)
  }
  try {
    reply = await deps.brain({
      text: input.text,
      signal: input.signal,
      onDelta: delta => {
        if (!delta) return
        if (!sawDelta) sawDelta = true
        full += delta
        if (wsEnabled && !wsFailed) {
          wsText += delta
          pushToWs(delta)
        } else pipeliner.push(delta)
      },
    })
  } catch (err) {
    if (deps.failureText === undefined || input.signal?.aborted) {
      abandonWs()
      throw err
    }
    brainFailure = { err }
  } finally {
  }

  // A turn that "completed" with no text at all (api deferred it because the
  // user's lock was busy, aborted server-side, empty model output) is dead
  // air for the caller: treat it like a failure and apologise.
  if (
    !brainFailure &&
    deps.failureText !== undefined &&
    !input.signal?.aborted &&
    !sawDelta &&
    !(typeof reply === "string" && reply.trim())
  ) {
    brainFailure = { err: new Error("brain turn returned no text") }
  }

  if (brainFailure) {
    const prefix = deps.logPrefix ?? "[call-session]"
    const err = brainFailure.err
    console.error(`${prefix} brain turn failed`, {
      err: err instanceof Error ? err.message : String(err),
    })
    const failureText = deps.failureText as string
    if (wsEnabled && !wsFailed && wsStream) {
      // The apology goes through the same continuous socket when it is still
      // up. It joins `wsText`, so a fallback during the drain replays it too.
      const apology = wsText ? ` ${failureText}` : failureText
      wsText += apology
      pushToWs(apology)
      if (!(await finishWs())) {
        await pipeliner.flush().catch(() => undefined)
      }
    } else {
      await pipeliner.flush().catch(() => undefined)
      meter.httpChars += failureText.length
      meter.httpCalls++
      await deps
        .tts({
          text: failureText,
          onChunk: input.onChunk,
          signal: input.signal,
        })
        .catch(ttsErr => {
          console.warn(`${prefix} failure tts failed`, {
            err: ttsErr instanceof Error ? ttsErr.message : String(ttsErr),
          })
        })
    }
    return full ? `${full} ${failureText}` : failureText
  }

  if (!sawDelta && reply) {
    full = reply
    if (wsEnabled && !wsFailed) {
      wsText += reply
      pushToWs(reply)
    } else pipeliner.push(reply)
  }

  const usedWs = await finishWs()
  if (!usedWs) await pipeliner.flush()
  return full
}
