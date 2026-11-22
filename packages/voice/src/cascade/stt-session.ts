/**
 * The streaming STT session the cascade pipeline drives, and its adapter over
 * an AIP-VOICE `SttStream`.
 *
 * The session shape is the one the studio pipeline already used
 * (`calls/stt-stream.ts` `SttSession`): audio goes in as the caller speaks,
 * `commit()` asks for a final bounded by a timeout and resolves `null` when
 * the stream is not ready, timed out or errored (the pipeline then falls back
 * to file transcription with the PCM it kept), `discard()` flushes an
 * utterance that was noise or echo.
 *
 * Vendor specifics of the studio implementation (a socket recycle after
 * silent timeouts, a keepalive frame) belong to the provider packages.
 */
import type {
  AudioFrame,
  SttProvider,
  SttStream,
  SttTranscript,
} from "../types.js"

/** Final transcript metadata, for observability only. */
export interface SttFinal {
  text: string
  provider: string
  /** Wall-clock instant the transcript arrived. */
  at: number
}

export interface SttSession {
  /** Stream one PCM frame (mono s16le) as the caller speaks. No-op when not ready. */
  pushAudio: (pcm: Int16Array) => void
  /** End of the open utterance: a final, or null (not ready, timed out, errored). */
  commit: (timeoutMs?: number) => Promise<string | null>
  /** The open utterance was noise or echo: flush it and ignore its transcript. */
  discard: () => void
  isReady: () => boolean
  close: () => void
  /** Called on every accepted final (observability only). */
  onFinal?: (cb: (final: SttFinal) => void) => void
  /** Called once when the session becomes usable. */
  onReady?: (cb: () => void) => void
  /** Called when the session drops or fails. */
  onError?: (cb: (err: Error) => void) => void
}

export interface StreamingSttSessionOptions {
  sampleRate: number
  language?: string
  signal?: AbortSignal
  /** Default bound of `commit()`. */
  finalTimeoutMs: number
}

/** Open a provider stream and wrap it as an `SttSession`. */
export async function openSttSession(
  provider: SttProvider,
  opts: StreamingSttSessionOptions,
): Promise<SttSession> {
  const open = () =>
    provider.openStream({
      sampleRate: opts.sampleRate,
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  // The first open throws to the caller (it decides on file fallback); later
  // reopens are best effort and never throw.
  return reconnectingSttSession(open, opts)
}

/** Consecutive failed reopens after which the session stays down (file fallback). */
const MAX_REOPEN_FAILURES = 3
/** Pause between two reopen attempts after a failure, multiplied by the failure count. */
const REOPEN_BACKOFF_MS = 1000

/**
 * An `SttSession` that reopens its provider stream when the current one drops
 * (idle timeout, socket recycle, error), so the next turn is still transcribed
 * in real time instead of falling back to file transcription. While a reopen
 * is in flight, or once it has failed `MAX_REOPEN_FAILURES` times in a row,
 * `isReady()` is false and the pipeline uses file transcription as before.
 */
export async function reconnectingSttSession(
  open: () => Promise<SttStream>,
  opts: Pick<StreamingSttSessionOptions, "sampleRate" | "finalTimeoutMs" | "signal">,
): Promise<SttSession> {
  let closedByCaller = false
  let reopening = false
  let failures = 0
  let retryAt = 0
  let current: SttSession

  const wrap = (stream: SttStream): SttSession => {
    const session: SttSession = wrapSttStream(stream, opts, () => {
      // Only the live session's drop triggers a reopen (not a stale one).
      if (session === current) reopen()
    })
    return session
  }

  const reopen = () => {
    if (closedByCaller || reopening || opts.signal?.aborted) return
    if (failures >= MAX_REOPEN_FAILURES || Date.now() < retryAt) return
    reopening = true
    void open().then(
      stream => {
        reopening = false
        if (closedByCaller) {
          void stream.close().catch(() => undefined)
          return
        }
        failures = 0
        current = wrap(stream)
      },
      () => {
        reopening = false
        failures++
        retryAt = Date.now() + REOPEN_BACKOFF_MS * failures
      },
    )
  }

  current = wrap(await open())

  return {
    isReady: () => {
      if (current.isReady()) return true
      reopen() // retry after a backed-off failure
      return false
    },
    pushAudio: pcm => current.pushAudio(pcm),
    commit: timeoutMs => current.commit(timeoutMs),
    discard: () => current.discard(),
    close() {
      closedByCaller = true
      current.close()
    },
  }
}

export function wrapSttStream(
  stream: SttStream,
  opts: Pick<StreamingSttSessionOptions, "sampleRate" | "finalTimeoutMs">,
  /** Called once when the stream drops (closed or error) without `close()`. */
  onDown?: () => void,
): SttSession {
  let ready = true
  let seq = 0
  // Finals still owed to a discarded utterance: their text is dropped. Each
  // debt expires after the final-wait bound, so a vendor that never answers a
  // discard cannot swallow the next genuine final.
  let ignoreUntil: number[] = []
  // One pending commit at a time; a later commit supersedes (and null-settles)
  // the earlier one, and a timer only settles the commit that armed it.
  let waiter: ((text: string | null) => void) | undefined

  const settle = (text: string | null) => {
    const w = waiter
    waiter = undefined
    w?.(text)
  }

  stream.on("final", (t: SttTranscript) => {
    const now = Date.now()
    ignoreUntil = ignoreUntil.filter(until => until > now)
    if (ignoreUntil.length > 0) {
      ignoreUntil.shift()
      return
    }
    settle(t.text)
  })
  const down = () => {
    const wasReady = ready
    ready = false
    ignoreUntil = []
    settle(null)
    if (wasReady) onDown?.()
  }
  stream.on("error", down)
  stream.on("closed", down)

  return {
    isReady: () => ready,
    pushAudio(pcm) {
      if (!ready || pcm.length === 0) return
      const frame: AudioFrame = {
        pcm16: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
        sampleRate: opts.sampleRate,
        sequenceNumber: seq++,
      }
      stream.pushAudio(frame)
    },
    commit(timeoutMs = opts.finalTimeoutMs) {
      if (!ready) return Promise.resolve(null)
      settle(null) // supersede a pending commit: its caller falls back
      return new Promise<string | null>(resolve => {
        const mine = (text: string | null) => {
          clearTimeout(timer)
          resolve(text)
        }
        const timer = setTimeout(() => {
          if (waiter === mine) settle(null)
        }, timeoutMs)
        waiter = mine
        stream.commit()
      })
    },
    discard() {
      if (!ready) return
      ignoreUntil.push(Date.now() + opts.finalTimeoutMs)
      stream.commit()
    },
    close() {
      ready = false
      ignoreUntil = []
      settle(null)
      void stream.close().catch(() => undefined)
    },
  }
}
