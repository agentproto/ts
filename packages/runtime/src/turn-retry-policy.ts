/**
 * `turnRetry` spawn option — the policy SHAPE only (zod schema, type,
 * defaults, tolerant parser). Kept free of any `sessions.ts` import so the
 * descriptor, the `agent_start` schema, the HTTP body parser, and the user
 * preset store can all share it without an import cycle. The behaviour lives
 * in `turn-retry.ts`.
 *
 * Opt-in and off by default: a session without `turnRetry` behaves exactly as
 * before (a turn that fails on a 429/5xx, or stalls silently while the
 * provider retries internally, just stops). DISTINCT from `restartPolicy`,
 * which revives a DEAD process; `turnRetry` re-prompts a LIVE session whose
 * last turn failed for a transient provider reason.
 */

import { z } from "zod"

/** Turn-failure classes `turnRetry.on` can opt into. */
export const TURN_RETRY_CLASSES = ["rate-limit", "upstream-5xx", "no-output-stall"] as const
export type TurnRetryClass = (typeof TURN_RETRY_CLASSES)[number]

export interface TurnRetryPolicy {
  /** Which transient failure classes trigger a retry:
   *  - `rate-limit` — HTTP 429 / "rate limit" / "too many requests";
   *  - `upstream-5xx` — HTTP 5xx / "overloaded" / "bad gateway" …;
   *  - `no-output-stall` — the stall watchdog flagged a turn that produced
   *    nothing since its prompt (`NO_OUTPUT_STALL_TURN_ERROR`, the opencode
   *    silent-429 loop). That turn is still running, so the retry interrupts
   *    it before re-prompting. */
  on: TurnRetryClass[]
  /** Consecutive retries allowed without a clean turn in between. */
  maxRetries: number
  /** First retry's backoff delay (ms), before `factor` compounds it. */
  baseDelayMs: number
  /** Exponential backoff multiplier per consecutive retry. */
  factor: number
  /** Backoff ceiling (ms). Also caps a provider `retry-after` hint. */
  maxDelayMs: number
  /** Retry even when the failed turn already made a tool call that may have
   *  side effects (anything outside a small read-only allowlist). Default
   *  false: such a turn is NOT retried, because the continuation could
   *  repeat a write/exec the agent already did. */
  retryAfterToolCalls?: boolean
}

export const TURN_RETRY_DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 5_000,
  factor: 2,
  maxDelayMs: 60_000,
} as const

/** Input shape (agent_start / user preset): only `on` is required; the
 *  numeric knobs default to {@link TURN_RETRY_DEFAULTS}. */
export const turnRetryInputSchema = z.object({
  on: z.array(z.enum(TURN_RETRY_CLASSES)).min(1),
  maxRetries: z.number().int().positive().optional(),
  baseDelayMs: z.number().int().nonnegative().optional(),
  factor: z.number().min(1).optional(),
  maxDelayMs: z.number().int().nonnegative().optional(),
  retryAfterToolCalls: z.boolean().optional(),
})

export type TurnRetryInput = z.infer<typeof turnRetryInputSchema>

/** Fill defaults and dedupe `on`. `maxDelayMs` is raised to `baseDelayMs`
 *  when given lower, so the curve is never inverted. */
export function resolveTurnRetryPolicy(input: TurnRetryInput): TurnRetryPolicy {
  const baseDelayMs = input.baseDelayMs ?? TURN_RETRY_DEFAULTS.baseDelayMs
  return {
    on: [...new Set(input.on)],
    maxRetries: input.maxRetries ?? TURN_RETRY_DEFAULTS.maxRetries,
    baseDelayMs,
    factor: input.factor ?? TURN_RETRY_DEFAULTS.factor,
    maxDelayMs: Math.max(input.maxDelayMs ?? TURN_RETRY_DEFAULTS.maxDelayMs, baseDelayMs),
    ...(input.retryAfterToolCalls ? { retryAfterToolCalls: true } : {}),
  }
}

/** Tolerant parser for the HTTP body / CLI: accepts the object, a
 *  JSON-stringified object, or a shorthand string — a comma list of classes
 *  (`"rate-limit,upstream-5xx"`) or `"all"` for every class. Returns
 *  `undefined` for anything that does not validate (never a partial policy). */
export function parseTurnRetryPolicy(raw: unknown): TurnRetryPolicy | undefined {
  let value: unknown = raw
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed.startsWith("{")) {
      try {
        value = JSON.parse(trimmed)
      } catch {
        return undefined
      }
    } else if (trimmed === "all") {
      value = { on: [...TURN_RETRY_CLASSES] }
    } else {
      value = { on: trimmed.split(",").map(s => s.trim()).filter(Boolean) }
    }
  }
  const parsed = turnRetryInputSchema.safeParse(value)
  return parsed.success ? resolveTurnRetryPolicy(parsed.data) : undefined
}
