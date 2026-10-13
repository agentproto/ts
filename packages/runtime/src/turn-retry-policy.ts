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
   *  - `upstream-5xx` — HTTP 5xx / "overloaded" / "bad gateway" / "endpoint unavailable" …;
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
  /** Ordered fallback models. When a retry fires for a class in `rotateOn`,
   *  the session is switched (live, before the continuation prompt) to the
   *  first target that is not cooling down and passes the eligibility checks.
   *  v1 switches the model on the session's CURRENT profile only: a target
   *  naming a different `profileRef` is skipped. Absent ⇒ never rotate. */
  rotate?: TurnRetryRotateTarget[]
  /** Classes that rotate (must be a subset of what `on` retries). Default
   *  `rate-limit` + `no-output-stall`; add `upstream-5xx` to rotate on those too. */
  rotateOn?: TurnRetryClass[]
  /** How long a rate-limited model is skipped, daemon-wide, when the error
   *  carries no retry-after hint (ms). Default {@link TURN_ROTATE_DEFAULTS}. */
  cooldownMs?: number
}

/** One fallback target of `turnRetry.rotate`. */
export interface TurnRetryRotateTarget {
  model: string
  /** Billing profile the target must run under. v1: must equal the session's
   *  current profile (or be omitted = "the current profile"). */
  profileRef?: string
}

export const TURN_RETRY_DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 5_000,
  factor: 2,
  maxDelayMs: 60_000,
} as const

export const TURN_ROTATE_DEFAULTS = {
  rotateOn: ["rate-limit", "no-output-stall"] as TurnRetryClass[],
  cooldownMs: 10 * 60_000,
} as const

/** OpenCode free-tier ids: `…-free`, or `big-pickle`, with or without the
 *  `opencode/` / `opencode-go/` route prefix. */
export function isOpencodeFreeModel(model: string): boolean {
  const id = (model.split("@")[0] ?? model).split("/").pop()?.toLowerCase() ?? ""
  return id === "big-pickle" || id.endsWith("-free")
}

/** The "free stays free" spawn-time check: a free current model may only
 *  rotate to free ids. Returns an error message, or undefined when fine. */
export function validateTurnRetryRotate(
  rotate: readonly TurnRetryRotateTarget[] | undefined,
  currentModel: string | undefined,
): string | undefined {
  if (!rotate?.length || !currentModel || !isOpencodeFreeModel(currentModel)) return undefined
  const paid = rotate.filter(t => !isOpencodeFreeModel(t.model)).map(t => t.model)
  if (paid.length === 0) return undefined
  return (
    `turnRetry.rotate: "${currentModel}" is an OpenCode free model, so it may only rotate to free ids ` +
    `(ending in "-free", or "big-pickle") — never onto a paid model. Remove: ${paid.join(", ")}.`
  )
}

/** Input shape (agent_start / user preset): only `on` is required; the
 *  numeric knobs default to {@link TURN_RETRY_DEFAULTS}. */
export const turnRetryInputSchema = z.object({
  on: z.array(z.enum(TURN_RETRY_CLASSES)).min(1),
  maxRetries: z.number().int().positive().optional(),
  baseDelayMs: z.number().int().nonnegative().optional(),
  factor: z.number().min(1).optional(),
  maxDelayMs: z.number().int().nonnegative().optional(),
  retryAfterToolCalls: z.boolean().optional(),
  rotate: z
    .array(z.object({ model: z.string().min(1), profileRef: z.string().min(1).optional() }))
    .max(16)
    .optional(),
  rotateOn: z.array(z.enum(TURN_RETRY_CLASSES)).min(1).optional(),
  cooldownMs: z.number().int().positive().optional(),
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
    ...(input.rotate?.length
      ? {
          rotate: input.rotate.map(t => ({ model: t.model, ...(t.profileRef ? { profileRef: t.profileRef } : {}) })),
          rotateOn: [...new Set(input.rotateOn ?? TURN_ROTATE_DEFAULTS.rotateOn)],
        }
      : {}),
    ...(input.cooldownMs !== undefined ? { cooldownMs: input.cooldownMs } : {}),
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
