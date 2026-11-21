// @ts-nocheck
// Ported from agentik-studio projects/simone/apps/voice/test/calls/pipeline-test-kit.ts
// The expect blocks are unchanged from the studio original; only imports (and,
// where noted in the PR, injected provider labels) differ. Type checking is off
// for this file because the studio does not type-check its test files.
import { vi } from "vitest"
import type { CallPipeline } from "../../cascade/pipeline.js"

export const SR = 16_000
const OUT_SR = 24_000

export function loudFrame(ms: number): Int16Array {
  const n = Math.floor((SR * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor(Math.sin((2 * Math.PI * 440 * i) / SR) * 8000)
  }
  return out
}

export function quietFrame(ms: number): Int16Array {
  return new Int16Array(Math.floor((SR * ms) / 1000))
}

/** Feed `ms` of loud or quiet audio in 20 ms frames, advancing the fake clock. */
export async function feed(
  pipeline: CallPipeline,
  kind: "loud" | "quiet",
  ms: number
): Promise<void> {
  for (let t = 0; t < ms; t += 20) {
    await vi.advanceTimersByTimeAsync(20)
    pipeline.pushFrame(kind === "loud" ? loudFrame(20) : quietFrame(20))
  }
}

/** pcm16 24 kHz mono bytes lasting `ms`. */
export function ttsChunk(ms: number): Buffer {
  return Buffer.alloc(Math.round((OUT_SR * ms) / 1000) * 2)
}

function audioMs(msg: { audio: string; sampleRate: number }): number {
  const bytes = Buffer.from(msg.audio, "base64").length
  return (bytes / 2 / msg.sampleRate) * 1000
}

type WaitResult = "ready" | "aborted" | "timeout" | "closed"

/**
 * A transport whose outbound queue is a plain counter of milliseconds, with
 * the same observable surface as WebRtcVoiceTransport (`send`, `isOpen`,
 * `outboundQueuedMs`, `waitOutboundBelow`).
 */
export function makeOutbound() {
  let queued = 0
  let open = true
  const waiters: Array<{ ms: number; resolve: (r: WaitResult) => void }> = []
  const purged: number[] = []
  const audioSent: number[] = []
  const controls: string[] = []

  const notify = () => {
    for (const w of [...waiters]) {
      if (queued <= w.ms) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve("ready")
      }
    }
  }

  const transport = {
    isOpen: () => open,
    send: vi.fn((msg: Record<string, unknown>) => {
      if (msg.type === "audio") {
        const ms = audioMs(msg as never)
        queued += ms
        audioSent.push(ms)
      } else if (msg.type === "control") {
        controls.push(String(msg.event))
        if (msg.event === "interrupt") {
          purged.push(queued)
          queued = 0
          notify()
        }
      }
    }),
  }

  const playback = {
    queuedMs: () => queued,
    waitBelow: vi.fn(
      (
        ms: number,
        opts?: { signal?: AbortSignal; timeoutMs?: number }
      ): Promise<WaitResult> =>
        new Promise(resolve => {
          if (queued <= ms) return resolve("ready")
          if (opts?.signal?.aborted) return resolve("aborted")
          const waiter = { ms, resolve }
          waiters.push(waiter)
          opts?.signal?.addEventListener(
            "abort",
            () => {
              const i = waiters.indexOf(waiter)
              if (i >= 0) waiters.splice(i, 1)
              resolve("aborted")
            },
            { once: true }
          )
          if (opts?.timeoutMs !== undefined) {
            setTimeout(() => {
              const i = waiters.indexOf(waiter)
              if (i >= 0) {
                waiters.splice(i, 1)
                resolve("timeout")
              }
            }, opts.timeoutMs)
          }
        })
    ),
  }

  return {
    transport,
    playback,
    purged,
    audioSent,
    controls,
    queued: () => queued,
    drain(ms: number) {
      queued = Math.max(0, queued - ms)
      notify()
    },
    setOpen(v: boolean) {
      open = v
    },
  }
}

export function abortError(): Error {
  const err = new Error("This operation was aborted")
  err.name = "AbortError"
  return err
}

/** Resolves when `signal` aborts, rejecting like a cancelled fetch. */
export function hangUntilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(abortError())
    signal?.addEventListener("abort", () => reject(abortError()), {
      once: true,
    })
  })
}
