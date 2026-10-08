/**
 * Event-loop starvation guard for the liveness sweep.
 *
 * The sweep orphans a run whose lease heartbeat is older than the TTL, but the
 * heartbeat is itself a timer in this process. If the loop was hogged (long
 * synchronous work), the sweep tick fires late and finds heartbeats that are
 * stale only because their renewals never got a turn, so orphaning on that
 * tick would kill healthy runs. A tick that fires much later than scheduled
 * is therefore skipped: the overdue renewals run first, and the next tick
 * judges fresh leases.
 */
export interface LivenessTickGuard {
  /** Call at the top of every tick. `true` ⇒ the loop was starved, skip it. */
  shouldSkip(): boolean
}

export function createLivenessTickGuard(
  intervalMs: number,
  graceMs: number,
  now: () => number = Date.now,
): LivenessTickGuard {
  let last = now()
  return {
    shouldSkip() {
      const t = now()
      const late = t - last - intervalMs
      last = t
      return late > graceMs
    },
  }
}
