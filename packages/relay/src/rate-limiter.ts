/**
 * Global (not per-caller) in-memory sliding-window rate limiter for
 * POST /relay/inbound. Global rather than per-IP on purpose: this relay
 * has exactly one legitimate caller by design (whoever holds the
 * bearer token), and keying by a client-supplied/proxy-supplied IP
 * (e.g. X-Forwarded-For behind a tunnel) would let a caller grow an
 * unbounded map of fake keys — a memory-exhaustion vector worse than
 * the abuse it would prevent.
 */

export interface RateLimiter {
  /** Returns true if the call is allowed under the current window. */
  allow(): boolean
}

export interface RateLimiterOptions {
  /** Max calls allowed per window. */
  max: number
  /** Window size in milliseconds. */
  windowMs: number
  /** Injectable clock — tests pass a fake one. Defaults to Date.now. */
  now?: () => number
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { max, windowMs } = opts
  const now = opts.now ?? Date.now
  const timestamps: number[] = []

  return {
    allow(): boolean {
      const t = now()
      const cutoff = t - windowMs
      while (timestamps.length > 0 && (timestamps[0] as number) <= cutoff) {
        timestamps.shift()
      }
      if (timestamps.length >= max) return false
      timestamps.push(t)
      return true
    },
  }
}
