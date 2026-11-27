/**
 * The cascade brain contract is `AsyncIterable<string>`; many brain calls push
 * deltas through a callback and resolve at the end (an SSE turn stream, an SDK
 * `onText`). This turns one into the other, keeping order and surfacing a
 * failure.
 *
 * `run` starts when iteration starts. If it resolves with a non-empty string
 * and never pushed a delta (a provider that answered in one block), that
 * string is yielded as the single chunk so the reply is still spoken.
 */
export function deltasToIterable(
  run: (onDelta: (delta: string) => void) => Promise<unknown>,
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const queue: string[] = []
      let done = false
      let error: unknown
      let wake: (() => void) | undefined
      const notify = () => {
        wake?.()
        wake = undefined
      }
      let streamed = false
      let cancelled = false
      run(delta => {
        // An empty delta carries no text: it must not count as "streamed", or a
        // provider that sends an empty first chunk and then the full text in
        // the final value would lose its reply.
        if (cancelled || !delta) return
        streamed = true
        queue.push(delta)
        notify()
      })
        .then(final => {
          if (!streamed && typeof final === "string" && final.trim()) queue.push(final)
        })
        .catch(err => {
          error = err ?? new Error("brain failed")
        })
        .finally(() => {
          done = true
          notify()
        })
      return {
        // Stops queueing and ends the iteration (a barge-in or a stall calls it).
        // `run` itself keeps going unless it observes its own cancellation signal.
        async return(): Promise<IteratorResult<string>> {
          cancelled = true
          queue.length = 0
          done = true
          notify()
          return { value: undefined, done: true }
        },
        async next(): Promise<IteratorResult<string>> {
          for (;;) {
            if (queue.length > 0) return { value: queue.shift() as string, done: false }
            if (done) {
              if (error !== undefined) throw error
              return { value: undefined, done: true }
            }
            await new Promise<void>(resolve => {
              wake = resolve
            })
          }
        },
      }
    },
  }
}
