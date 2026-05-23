/**
 * ClockPort — abstracted time source.
 *
 * Tests need deterministic timestamps; production wants Date.now().
 * Every component that emits `*_at` fields or temporal scores takes
 * a ClockPort so the same code is testable + real.
 */

export interface ClockPort {
  /** Wall-clock now. */
  now(): Date

  /** Current ms since epoch. Equivalent to `now().getTime()`. */
  nowMs(): number
}

/** Real-time implementation. The local CLI host wires this in. */
export const systemClock: ClockPort = {
  now: () => new Date(),
  nowMs: () => Date.now(),
}
