/**
 * Server-side estimate of a client's playback queue.
 *
 * A host sends the reply audio faster than real time while the client plays it
 * at 1x. Without this view the cascade thinks a turn is over as soon as the
 * last chunk is sent, so for the seconds the client is still talking the caller
 * cannot cut the assistant off, and the next utterance overlaps its voice.
 * The clock adds each sent chunk's duration to a play-out end time and resets
 * when the client flushes its queue on an interrupt. Pass it as
 * `CascadeOptions.playback`.
 */
import type { CascadeOptions } from "./cascade/start-cascade.js"

export type PlaybackView = NonNullable<CascadeOptions["playback"]>

export interface PlaybackClock extends PlaybackView {
  /** One chunk of `ms` of audio was handed to the client. */
  sent(ms: number): void
  /** The client dropped its queue (interrupt). */
  reset(): void
}

const POLL_MS = 20

export function createPlaybackClock(now: () => number = Date.now): PlaybackClock {
  let endAt = 0
  const queuedMs = () => Math.max(0, endAt - now())
  return {
    queuedMs,
    sent(ms) {
      if (!(ms > 0)) return
      endAt = Math.max(endAt, now()) + ms
    },
    reset() {
      endAt = 0
    },
    waitBelow(ms, opts) {
      return new Promise(resolve => {
        const startedAt = now()
        let timer: ReturnType<typeof setTimeout> | undefined
        const onAbort = () => done("aborted")
        const done = (r: "ready" | "aborted" | "timeout") => {
          if (timer) clearTimeout(timer)
          opts?.signal?.removeEventListener("abort", onAbort)
          resolve(r)
        }
        if (opts?.signal?.aborted) return resolve("aborted")
        opts?.signal?.addEventListener("abort", onAbort, { once: true })
        const tick = () => {
          if (queuedMs() <= ms) return done("ready")
          if (opts?.timeoutMs !== undefined && now() - startedAt >= opts.timeoutMs) {
            return done("timeout")
          }
          timer = setTimeout(tick, Math.min(POLL_MS, Math.max(1, queuedMs() - ms)))
        }
        tick()
      })
    },
  }
}
