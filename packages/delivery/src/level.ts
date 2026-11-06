import type { Envelope, Level, Tier } from "./types.js"

// `steer` is the top tier of the shared vocabulary. The follow and sentinel
// producers only deliver `next-turn` or `fyi`, so an applied level 3 reaches
// them as a wake (`next-turn`): never downgraded to `fyi`, never dropped.
const TIER: Record<Level, Tier> = {
  3: "steer",
  2: "next-turn",
  1: "fyi",
  0: "drop",
}

export function levelToTier(level: Level): Tier {
  return TIER[level]
}

/** `level = floor ? 3 : min(classifierResult ?? levelHint ?? 2, cap)`.
 *  `terminal` is deliberately absent: it ends a subscription and never sets level. */
export function computeLevel(
  env: Pick<Envelope, "floor" | "levelHint">,
  classifierResult: Level | undefined,
  cap: Level,
): Level {
  if (env.floor !== undefined) return 3
  return Math.min(classifierResult ?? env.levelHint ?? 2, cap) as Level
}
