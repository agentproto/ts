/**
 * Detect a harness's NATIVE context compaction from its usage frames.
 *
 * Claude Code (and Codex) compact their own context when the window fills,
 * without a `/compact` prompt: the daemon's "no checkpoint, no compaction"
 * gate in `runAgentTurn` never sees it, and no harness event announces it.
 * What it does leave is a sharp drop of tokens-in-context between two usage
 * frames. This module only compares two samples; the runtime decides which
 * frames are samples and which drops it caused itself.
 *
 * Calibrated on 7 days of real claude-code transcripts (987 sessions): every
 * native compaction fell to at most 0.17 of the previous reading, from at
 * least ~41k tokens, while the largest drop that was not a compaction kept
 * 0.75 of it. The defaults sit between the two.
 */

/** One accepted usage reading: tokens in context, and the window when known. */
export interface UsageSample {
  used: number
  size?: number
}

export interface NativeCompactionVerdict {
  usedBefore: number
  usedAfter: number
  /** `usedAfter / usedBefore`. */
  ratio: number
}

export const NATIVE_COMPACTION_DEFAULTS: Readonly<{ minBefore: number; maxRatio: number; minDrop: number }> = Object.freeze({
  /** A reading under this is too small for a compaction to be worth reporting. */
  minBefore: 30_000,
  /** The new reading keeps at most this share of the previous one. */
  maxRatio: 0.5,
  /** And is at least this many tokens lower. */
  minDrop: 20_000,
})

/**
 * The drop from `prev` to `next` when it looks like a native compaction,
 * otherwise undefined: no previous sample, a window change (`size` known on
 * both and different, e.g. a model switch), a previous reading under
 * `minBefore`, a drop under `minDrop` or a ratio above `maxRatio`.
 */
export function detectNativeCompaction(
  prev: UsageSample | undefined,
  next: UsageSample,
  opts?: Partial<typeof NATIVE_COMPACTION_DEFAULTS>,
): NativeCompactionVerdict | undefined {
  if (!prev) return undefined
  const { minBefore, maxRatio, minDrop } = { ...NATIVE_COMPACTION_DEFAULTS, ...opts }
  if (prev.size !== undefined && next.size !== undefined && prev.size !== next.size) return undefined
  if (prev.used < minBefore) return undefined
  if (prev.used - next.used < minDrop) return undefined
  const ratio = next.used / prev.used
  if (ratio > maxRatio) return undefined
  return { usedBefore: prev.used, usedAfter: next.used, ratio }
}

/** A checkpoint written for the session at most this long before a native
 *  drop marks the compaction as guarded: the work survived it. */
export const NATIVE_COMPACTION_GUARD_WINDOW_MS = 120_000
