/**
 * Rate-limited failure logging for reconnect loops.
 *
 * A standing reconnect loop (the outbound tunnel, a pairing rendezvous) whose
 * peer is permanently gone re-dials on backoff forever. Logging every single
 * failure buries the daemon log — a single dead pairing produced ~85% of one
 * 2.9MB never-rotated `~/.agentproto/daemon.log`, and the tunnel reconnect
 * spam another chunk. This gate logs the FIRST failure per key immediately,
 * then at most one line per `windowMs`, and when it does emit again it carries
 * the count of failures it swallowed in between. A successful connect resets
 * the key so the next outage logs promptly again.
 *
 * Deliberately dependency-free: a per-key `{ lastLoggedAt, suppressed }` map.
 * `now` is injectable so tests can advance the clock without real timers. This
 * only changes logging cadence — reconnect timing/backoff is untouched.
 */
export interface ReconnectLogGate {
  /**
   * Record a failure for `key`. Returns the line to log now — the given
   * `message`, with a `(N failures suppressed)` suffix when repeats were
   * swallowed since the last emit — or `null` to stay quiet this time.
   */
  onFailure(key: string, message: string): string | null
  /** Reset suppression for `key` after a successful connect. */
  onSuccess(key: string): void
}

export function createReconnectLogGate(
  opts: { windowMs?: number; now?: () => number } = {},
): ReconnectLogGate {
  const windowMs = opts.windowMs ?? 60_000
  const now = opts.now ?? Date.now
  const state = new Map<string, { lastLoggedAt: number; suppressed: number }>()
  return {
    onFailure(key, message) {
      const ts = now()
      const prev = state.get(key)
      if (prev && ts - prev.lastLoggedAt < windowMs) {
        prev.suppressed += 1
        return null
      }
      const suffix =
        prev && prev.suppressed > 0
          ? ` (${prev.suppressed} failure${prev.suppressed === 1 ? "" : "s"} suppressed)`
          : ""
      state.set(key, { lastLoggedAt: ts, suppressed: 0 })
      return `${message}${suffix}`
    },
    onSuccess(key) {
      state.delete(key)
    },
  }
}
