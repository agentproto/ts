/**
 * `turnRetry` spawn option — the policy SHAPE only (zod schema, type,
 * defaults, tolerant parser). Kept free of any `sessions.ts` import so the
 * descriptor, the `agent_start` schema, the HTTP body parser, and the user
 * preset store can all share it without an import cycle. The behaviour lives
 * in `turn-retry.ts`.
 *
 * OFF by default for interactive supervisor sessions and ON by default for
 * executor / sandbox spawns: a spawn without `turnRetry` gets the DEFAULT
 * policy below (see {@link defaultTurnRetryForSpawn}), while a supervisor
 * turn that fails on a 429/5xx, or stalls silently while the provider
 * retries internally, just stops. DISTINCT from `restartPolicy`,
 * which revives a DEAD process; `turnRetry` re-prompts a LIVE session whose
 * last turn failed for a transient provider reason.
 */

import { z } from "zod"
import { inModelList, resolveModelList } from "@agentproto/model-catalog/lists"
import { DEFAULT_ROTATION_LIST_ID, getModelListSource } from "./model-list-store.js"
import { checkModelPolicy, type ModelPolicy } from "./model-policy.js"

/** Turn-failure classes `turnRetry.on` can opt into. */
export const TURN_RETRY_CLASSES = ["rate-limit", "upstream-5xx", "no-output-stall"] as const
export type TurnRetryClass = (typeof TURN_RETRY_CLASSES)[number]

/** What a matching failure does. `retry` (the default) re-prompts the same
 *  live session after backoff; `migrate` moves a SANDBOX session to a fresh
 *  box (new IP) and re-prompts it there — see `turn-retry.ts`. */
export const TURN_RETRY_ACTIONS = ["retry", "migrate"] as const
export type TurnRetryAction = (typeof TURN_RETRY_ACTIONS)[number]

export interface TurnRetryPolicy {
  /** Which transient failure classes trigger a retry:
   *  - `rate-limit` — HTTP 429 / "rate limit" / "too many requests";
   *  - `upstream-5xx` — HTTP 5xx / "overloaded" / "bad gateway" / "endpoint unavailable" …;
   *  - `no-output-stall` — the stall watchdog flagged a turn that produced
   *    nothing since its prompt (`NO_OUTPUT_STALL_TURN_ERROR`, the opencode
   *    silent-429 loop). That turn is still running, so the retry interrupts
   *    it before re-prompting. */
  on: TurnRetryClass[]
  /** What a matching failure does: `retry` re-prompts the same live session
   *  after backoff; `migrate` moves a sandbox session to a fresh box (new IP)
   *  and re-prompts it there. Default `retry` — fully backward compatible. */
  action: TurnRetryAction
  /** Consecutive retries allowed without a clean turn in between. */
  maxRetries: number
  /** Box migrations allowed without a clean turn in between (action `migrate`
   *  only). Independent of `maxRetries`: once the cap is spent the failure
   *  falls back to a normal retry / give-up. Non-negative — `0` means the
   *  migrate action never migrates. Default {@link TURN_MIGRATE_DEFAULTS}. */
  maxMigrations: number
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

export const TURN_MIGRATE_DEFAULTS = {
  maxMigrations: 2,
} as const

export const TURN_ROTATE_DEFAULTS = {
  rotateOn: ["rate-limit", "no-output-stall"] as TurnRetryClass[],
  cooldownMs: 10 * 60_000,
} as const

/** Failure classes the DEFAULT always-on policy covers (executor / sandbox
 *  spawns that gave no explicit `turnRetry`). */
export const TURN_RETRY_DEFAULT_ON: TurnRetryClass[] = ["rate-limit", "upstream-5xx", "no-output-stall"]

/** Consecutive retries the default policy allows. */
export const TURN_RETRY_DEFAULT_MAX_RETRIES = 6

/** The same bare key used to drop the current model from the default list:
 *  `@route` stripped, last `/` segment, lowercased. */
function bareKey(model: string): string {
  return (model.split("@")[0] ?? model).split("/").pop()?.toLowerCase() ?? ""
}

/** The default rotate targets: the curated `default-rotation` list minus the
 *  current model (by bare key), filtered by the session policy, in list order. */
function defaultRotateTargets(currentModel: string, policy: ModelPolicy | undefined): TurnRetryRotateTarget[] {
  const key = bareKey(currentModel)
  const source = getModelListSource()
  return resolveModelList(DEFAULT_ROTATION_LIST_ID, source)
    .filter(id => bareKey(id) !== key)
    .filter(id => checkModelPolicy(id, policy, source).ok)
    .map(model => ({ model }))
}

/** Build the turnRetry INPUT a spawn with no explicit `turnRetry` (explicit
 *  or via a preset) receives when the default is ON, i.e. for an executor
 *  role or a `sandbox` spawn. When the current model is itself in the
 *  `default-rotation` model list, the default also ROTATES on every covered
 *  class (rate limits and 5xx alike) onto the other members of that list the
 *  session policy allows; any other model gets no rotate list. */
export function defaultTurnRetryForSpawn(
  currentModel?: string,
  policy?: ModelPolicy,
): Exclude<TurnRetryInput, null> {
  const base: Exclude<TurnRetryInput, null> = {
    on: [...TURN_RETRY_DEFAULT_ON],
    maxRetries: TURN_RETRY_DEFAULT_MAX_RETRIES,
  }
  if (!currentModel || !inModelList(currentModel, DEFAULT_ROTATION_LIST_ID, getModelListSource())) {
    return base
  }
  const rotate = defaultRotateTargets(currentModel, policy)
  if (rotate.length === 0) return base
  return { ...base, rotate, rotateOn: [...TURN_RETRY_DEFAULT_ON] }
}

/** Spawn-time check: every rotate target must pass the session's model
 *  policy, if any. Returns an error message, or undefined when fine. */
export function validateTurnRetryRotate(
  rotate: readonly TurnRetryRotateTarget[] | undefined,
  policy: ModelPolicy | undefined,
): string | undefined {
  if (!rotate?.length || !policy) return undefined
  const source = getModelListSource()
  const refused = rotate
    .map(t => ({ model: t.model, verdict: checkModelPolicy(t.model, policy, source) }))
    .filter(t => !t.verdict.ok)
  if (refused.length === 0) return undefined
  return (
    `turnRetry.rotate: targets refused by the session model policy. ` +
    refused.map(t => (t.verdict.ok ? "" : `${t.model} (${t.verdict.reason})`)).join("; ")
  )
}

/** Input shape (agent_start / user preset): only `on` is required; the
 *  numeric knobs default to {@link TURN_RETRY_DEFAULTS}, `action` to `retry`
 *  and `maxMigrations` to {@link TURN_MIGRATE_DEFAULTS}. Opt-OUT stays an
 *  explicit choice: `null`, or an object whose `on` list is empty, resolves
 *  to a session that never retries (the spawn-time default is skipped for
 *  an explicit `turnRetry`, even a disabling one). */
export const turnRetryObjectSchema = z.object({
  on: z.array(z.enum(TURN_RETRY_CLASSES)),
  action: z.enum(TURN_RETRY_ACTIONS).optional(),
  maxRetries: z.number().int().positive().optional(),
  baseDelayMs: z.number().int().nonnegative().optional(),
  factor: z.number().min(1).optional(),
  maxDelayMs: z.number().int().nonnegative().optional(),
  maxMigrations: z.number().int().nonnegative().optional(),
  retryAfterToolCalls: z.boolean().optional(),
  rotate: z
    .array(z.object({ model: z.string().min(1), profileRef: z.string().min(1).optional() }))
    .max(16)
    .optional(),
  rotateOn: z.array(z.enum(TURN_RETRY_CLASSES)).min(1).optional(),
  cooldownMs: z.number().int().positive().optional(),
})

export const turnRetryInputSchema = z.union([turnRetryObjectSchema, z.null()])

export type TurnRetryPolicyInput = z.infer<typeof turnRetryObjectSchema>
export type TurnRetryInput = TurnRetryPolicyInput | null

/** Fill defaults and dedupe `on`. `maxDelayMs` is raised to `baseDelayMs`
 *  when given lower, so the curve is never inverted. An empty `on` resolves
 *  to a policy that matches nothing — the explicit "never retry" shape. */
export function resolveTurnRetryPolicy(input: TurnRetryPolicyInput): TurnRetryPolicy {
  const baseDelayMs = input.baseDelayMs ?? TURN_RETRY_DEFAULTS.baseDelayMs
  return {
    on: [...new Set(input.on)],
    action: input.action ?? "retry",
    maxRetries: input.maxRetries ?? TURN_RETRY_DEFAULTS.maxRetries,
    baseDelayMs,
    factor: input.factor ?? TURN_RETRY_DEFAULTS.factor,
    maxDelayMs: Math.max(input.maxDelayMs ?? TURN_RETRY_DEFAULTS.maxDelayMs, baseDelayMs),
    maxMigrations: input.maxMigrations ?? TURN_MIGRATE_DEFAULTS.maxMigrations,
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
 *  (`"rate-limit,upstream-5xx"`), `"all"` for every class, or `"off"` for an
 *  explicit opt-out (a policy that matches nothing). Returns `undefined` for
 *  anything else that does not validate (never a partial policy). */
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
    } else if (trimmed === "off") {
      value = { on: [] }
    } else {
      value = { on: trimmed.split(",").map(s => s.trim()).filter(Boolean) }
    }
  } else if (raw === null) {
    value = { on: [] }
  }
  const parsed = turnRetryObjectSchema.safeParse(value)
  return parsed.success ? resolveTurnRetryPolicy(parsed.data) : undefined
}
