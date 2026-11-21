/**
 * Guards on the brain of a cascade turn (AIP-VOICE, Engines): a bound on the time
 * to the first chunk and on the gap between two chunks, and cancellation of an
 * abandoned turn through the turn signal.
 *
 * The values come from the studio call brain (`calls/brain-turn.ts:19-20,58`,
 * a production incident where a brain went quiet for 50 s); the brain there is
 * an HTTP stream, here it is any `AsyncIterable<string>`.
 */
import { VOICE_DEFAULTS } from "../defaults.js"

export interface BrainGuardOptions {
  /** Max wait for the first chunk. */
  firstChunkMs?: number
  /** Max wait between two chunks once text has started. */
  idleMs?: number
}

export class BrainStalledError extends Error {
  constructor(readonly phase: "first-chunk" | "idle", readonly afterMs: number) {
    super(`brain stalled: no ${phase === "first-chunk" ? "first chunk" : "chunk"} for ${afterMs} ms`)
    this.name = "BrainStalledError"
  }
}

const B = VOICE_DEFAULTS.cascade.brain

/**
 * Iterate `source` and call `onDelta` per chunk. Rejects with
 * `BrainStalledError` when a bound is exceeded; resolves when the source ends
 * or `signal` aborts (a cut turn is not an error here).
 */
export async function consumeBrain(
  source: AsyncIterable<string>,
  onDelta: (delta: string) => void,
  opts: BrainGuardOptions & { signal?: AbortSignal } = {},
): Promise<string> {
  const firstChunkMs = opts.firstChunkMs ?? B.firstChunkMs.value
  const idleMs = opts.idleMs ?? B.idleMs.value
  const iterator = source[Symbol.asyncIterator]()
  let full = ""
  let started = false
  const { signal } = opts

  const aborted = new Promise<"aborted">(resolve => {
    if (signal?.aborted) return resolve("aborted")
    signal?.addEventListener("abort", () => resolve("aborted"), { once: true })
  })

  try {
    while (true) {
      const limit = started ? idleMs : firstChunkMs
      let timer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<"stalled">(resolve => {
        if (limit > 0) timer = setTimeout(() => resolve("stalled"), limit)
      })
      const next = iterator.next()
      next.catch(() => undefined)
      const r = await Promise.race([next, stalled, aborted])
      clearTimeout(timer)
      if (r === "aborted") return full
      if (r === "stalled") {
        throw new BrainStalledError(started ? "idle" : "first-chunk", limit)
      }
      if (r.done) return full
      if (r.value) {
        started = true
        full += r.value
        onDelta(r.value)
      }
    }
  } finally {
    // Ask the source to stop. An async generator blocked in an await only
    // runs its cleanup once that await settles, so a brain must also observe
    // the turn `signal` (CascadeBrainInput.signal) to stop work promptly.
    void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }
}
