/**
 * Depth — how hard to dig. Named profiles map to the concrete knobs every
 * adapter honors (per-slice cap + pagination depth + engagement fan-out +
 * pacing), so the host says "deep" instead of tuning four numbers.
 *
 * `limit` is the per-slice soft cap (CaptureOptions.limit); the rest are
 * adapter-construction knobs (e.g. XAdapterOptions). resolveDepth() lets the
 * host pass a name, a partial override, or nothing (→ standard).
 */

export interface DepthSettings {
  /** Per-slice soft cap on records (pagination target). */
  readonly limit: number
  /** Max pages an adapter will follow the cursor through, per slice. */
  readonly maxPages: number
  /** Posts to fan out for engagement-received (the heavy slice). */
  readonly fanout: number
  /** Pace between paginated calls (ms) — politeness + anti-throttle. */
  readonly throttleMs: number
}

export type DepthName = "quick" | "standard" | "deep" | "exhaustive"

export const DEPTH_PROFILES: Record<DepthName, DepthSettings> = {
  quick: { limit: 50, maxPages: 2, fanout: 2, throttleMs: 800 },
  standard: { limit: 200, maxPages: 10, fanout: 5, throttleMs: 1200 },
  deep: { limit: 1000, maxPages: 40, fanout: 15, throttleMs: 1500 },
  exhaustive: { limit: 5000, maxPages: 200, fanout: 40, throttleMs: 2200 },
}

export function isDepthName(v: string): v is DepthName {
  return v in DEPTH_PROFILES
}

/** Resolve a depth spec to concrete settings. Name | partial override | default. */
export function resolveDepth(
  spec?: DepthName | Partial<DepthSettings>
): DepthSettings {
  if (!spec) return DEPTH_PROFILES.standard
  if (typeof spec === "string")
    return DEPTH_PROFILES[spec] ?? DEPTH_PROFILES.standard
  return { ...DEPTH_PROFILES.standard, ...spec }
}
