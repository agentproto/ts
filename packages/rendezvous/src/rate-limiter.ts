/**
 * Per-IP sliding-window rate limiter for rendezvous token attempts.
 *
 * Unlike `@agentproto/relay`'s global limiter (one legitimate caller by
 * design), the broker is public: any IP may present a token, and a flood from
 * one source must not starve others. So we key by remote IP.
 *
 * The map is the obvious memory-exhaustion vector a per-key limiter introduces
 * — an attacker rotating source IPs (or spoofing `X-Forwarded-For`, which we do
 * NOT trust here: the key is always the real socket address) could grow it
 * unbounded. Two guards: (1) each key's timestamp list is pruned to the window
 * on every touch, and (2) the number of distinct keys is capped; once the cap
 * is hit, fully-drained keys are swept, and if still full new keys are refused
 * (fail-closed — a refused attempt is `allow() === false`, which the server
 * treats as rate-limited). The cap is generous enough that legitimate traffic
 * never reaches it.
 */

export interface RateLimiter {
  /** Returns true if an attempt from `key` is allowed under its window. */
  allow(key: string): boolean
}

export interface RateLimiterOptions {
  /** Max attempts allowed per key per window. */
  max: number
  /** Window size in milliseconds. */
  windowMs: number
  /** Max distinct keys tracked at once — bounds memory. Default 10_000. */
  maxKeys?: number
  /** Injectable clock — tests pass a fake one. Defaults to Date.now. */
  now?: () => number
}

const DEFAULT_MAX_KEYS = 10_000

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { max, windowMs } = opts
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS
  const now = opts.now ?? Date.now
  const buckets = new Map<string, number[]>()

  const prune = (timestamps: number[], cutoff: number): number[] => {
    while (timestamps.length > 0 && (timestamps[0] as number) <= cutoff) {
      timestamps.shift()
    }
    return timestamps
  }

  return {
    allow(key: string): boolean {
      const t = now()
      const cutoff = t - windowMs

      let timestamps = buckets.get(key)
      if (!timestamps) {
        // New key. Enforce the cap before inserting so the map can't grow
        // without bound. First try sweeping keys whose windows have fully
        // drained; only if that doesn't free a slot do we fail closed.
        if (buckets.size >= maxKeys) {
          for (const [k, ts] of buckets) {
            if (prune(ts, cutoff).length === 0) buckets.delete(k)
          }
          if (buckets.size >= maxKeys) return false
        }
        timestamps = []
        buckets.set(key, timestamps)
      } else {
        prune(timestamps, cutoff)
        if (timestamps.length === 0) {
          // Keep the map tidy: an idle key holds an empty array; drop it and
          // re-create so long-lived idle keys don't accumulate.
          buckets.delete(key)
          timestamps = []
          buckets.set(key, timestamps)
        }
      }

      if (timestamps.length >= max) return false
      timestamps.push(t)
      return true
    },
  }
}
