/**
 * ClockPort — abstracted time source.
 *
 * Tests need deterministic timestamps; production wants Date.now(). Every fold /
 * expiry / rate lookup takes a clock so the same code is testable + real.
 */

export interface ClockPort {
  /** Wall-clock now. */
  now(): Date
  /** Current ms since epoch. Equivalent to `now().getTime()`. */
  nowMs(): number
}

/** Real-time implementation. Hosts wire this in. */
export const systemClock: ClockPort = {
  now: () => new Date(),
  nowMs: () => Date.now(),
}
