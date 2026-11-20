/**
 * The streaming STT session the cascade pipeline drives, and its adapter over
 * an AIP-75 `SttStream`.
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
  const stream = await provider.openStream({
    sampleRate: opts.sampleRate,
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  return wrapSttStream(stream, opts)
}

export function wrapSttStream(
  stream: SttStream,
  opts: Pick<StreamingSttSessionOptions, "sampleRate" | "finalTimeoutMs">,
): SttSession {
  let ready = true
  let seq = 0
  // Finals still owed to a discarded utterance: their text is dropped.
  let ignoreFinals = 0
  let waiter: ((text: string | null) => void) | undefined

  const settle = (text: string | null) => {
    const w = waiter
    waiter = undefined
    w?.(text)
  }

  stream.on("final", (t: SttTranscript) => {
    if (ignoreFinals > 0) {
      ignoreFinals--
      return
    }
    settle(t.text)
  })
  stream.on("error", () => {
    ready = false
    settle(null)
  })
  stream.on("closed", () => {
    ready = false
    settle(null)
  })

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
      return new Promise<string | null>(resolve => {
        const timer = setTimeout(() => settle(null), timeoutMs)
        waiter = text => {
          clearTimeout(timer)
          resolve(text)
        }
        stream.commit()
      })
    },
    discard() {
      if (!ready) return
      ignoreFinals++
      stream.commit()
    },
    close() {
      ready = false
      settle(null)
      void stream.close().catch(() => undefined)
    },
  }
}
