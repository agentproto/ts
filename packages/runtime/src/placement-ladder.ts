/**
 * Placement ladder (`agent_start.placement`): an ordered list of rungs, each a
 * sandbox (plus optional model / access / preflight / turnRetry overrides). The
 * spawn tries rung 1; when the box cannot be placed there, it moves to rung 2,
 * and so on. Whatever rung the session starts on, a mid-run failure is
 * `turnRetry`'s job, never the ladder's.
 *
 * The criteria are typed, never a provider message match: a rung is skipped on
 * a failed preflight, a typed boot failure (capacity, overflow refused, egress
 * pool exhausted) or a boot-phase code listed in {@link LADDER_ADVANCE_CODES}.
 */

import { z } from "zod"
import { sandboxSpecWithReuseSchema } from "./sandbox-spec-schema.js"
import { turnRetryInputSchema, type TurnRetryInput } from "./turn-retry-policy.js"

export const MAX_PLACEMENT_RUNGS = 8

const accessSchema = z
  .object({
    profileRef: z.string().min(1).optional(),
    profileRefs: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()

export const placementRungSchema = z
  .object({
    sandbox: z.union([z.string().min(1), sandboxSpecWithReuseSchema]),
    model: z.string().min(1).optional(),
    access: accessSchema.optional(),
    preflight: z.array(z.string().min(1)).optional(),
    turnRetry: turnRetryInputSchema.optional(),
  })
  .strict()

export const placementInputSchema = z
  .object({
    ladder: z.array(placementRungSchema).min(1).max(MAX_PLACEMENT_RUNGS),
  })
  .strict()

export type PlacementRung = z.infer<typeof placementRungSchema>
export type PlacementInput = z.infer<typeof placementInputSchema>

export interface PlacementAttempt {
  /** 0-based index into the ladder. */
  rung: number
  provider: string
  model?: string
  outcome: "ok" | "failed"
  /** Typed reason a failed rung was skipped: the failure code, or the more
   *  specific `errorClass` it carried (e.g. `sandbox_overflow_refused`). */
  errorClass?: string
  egressIp?: string
  durationMs: number
}

/** What the descriptor records once a ladder spawn settles. */
export interface SessionPlacement {
  /** The rung the session runs on (0-based). */
  rung: number
  /** The ladder as requested, so a restart or migration can re-place. */
  ladder: PlacementRung[]
  attempts: PlacementAttempt[]
}

/** Boot-phase failures that mean "this rung cannot host the session", all
 *  raised before the agent started. Anything else (a bad cwd, an unknown
 *  probe, a killed placeholder, a policy refusal) would fail the same way on
 *  every rung, or is a decision to stop, so it ends the walk. */
export const LADDER_ADVANCE_CODES: ReadonlySet<string> = new Set([
  "sandbox_preflight_failed",
  "sandbox_boot_failed",
  "sandbox_provider_not_found",
  "sandbox_proxy_failed",
  "sandbox_workspace_setup_failed",
  "sandbox_app_serve_failed",
  "sandbox_overflow_refused",
  "sandbox_egress_pool_exhausted",
  "device_offline",
])

export interface LadderFailure {
  code: string
  message: string
  details?: Record<string, unknown>
}

export function isLadderAdvanceFailure(failure: Pick<LadderFailure, "code">): boolean {
  return LADDER_ADVANCE_CODES.has(failure.code)
}

/** A `sandbox_*` error code carried by a thrown provider error (capacity,
 *  overflow refused, egress pool exhausted, ...). Structural, so it works for
 *  errors from a duplicate install or a mock. */
const TYPED_BOOT_ERROR_CODE = /^sandbox_[a-z0-9_]+$/

export function bootErrorClass(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === "string" && TYPED_BOOT_ERROR_CODE.test(code) ? code : undefined
}

export function failureErrorClass(failure: LadderFailure): string {
  const cls = failure.details?.errorClass
  return typeof cls === "string" && cls.length > 0 ? cls : failure.code
}

export function rungProviderLabel(rung: PlacementRung): string {
  return typeof rung.sandbox === "string" ? rung.sandbox : rung.sandbox.provider
}

/** `reuse` reconnects to an existing box, which is not a placement choice. */
export function placementRungProblem(rung: PlacementRung, index: number): string | undefined {
  if (typeof rung.sandbox !== "string" && rung.sandbox.reuse !== undefined) {
    return `placement.ladder[${index}].sandbox.reuse is not allowed: a rung boots a fresh box`
  }
  return undefined
}

/** The ladder with every axis a rung omits filled from the spawn's own
 *  top-level value, so a rung is self-contained: what the descriptor records
 *  and what a later restart or migration replays. */
export function resolveLadder(
  ladder: readonly PlacementRung[],
  inherited: Partial<Pick<PlacementRung, "model" | "access" | "preflight" | "turnRetry">>,
): PlacementRung[] {
  return ladder.map(rung => ({
    ...rung,
    ...(rung.model === undefined && inherited.model !== undefined ? { model: inherited.model } : {}),
    ...(rung.access === undefined && inherited.access !== undefined ? { access: inherited.access } : {}),
    ...(rung.preflight === undefined && inherited.preflight !== undefined ? { preflight: inherited.preflight } : {}),
    ...(rung.turnRetry === undefined && inherited.turnRetry !== undefined ? { turnRetry: inherited.turnRetry } : {}),
  }))
}

export interface PlacementOverrides {
  sandbox: PlacementRung["sandbox"]
  model?: string
  access?: { profileRef?: string; profileRefs?: string[] }
  preflight?: string[]
  turnRetry?: TurnRetryInput
}

/** The spawn-input axes a rung overrides; omitted axes inherit the caller's. */
export function rungOverrides(rung: PlacementRung): PlacementOverrides {
  return {
    sandbox: rung.sandbox,
    ...(rung.model !== undefined ? { model: rung.model } : {}),
    ...(rung.access !== undefined ? { access: rung.access } : {}),
    ...(rung.preflight !== undefined ? { preflight: rung.preflight } : {}),
    ...(rung.turnRetry !== undefined ? { turnRetry: rung.turnRetry } : {}),
  }
}

export type LadderStep<T> = { ok: true; value: T } | ({ ok: false } & LadderFailure)

export type LadderWalk<T> =
  | { ok: true; rung: number; value: T; attempts: PlacementAttempt[] }
  | {
      ok: false
      /** True when every rung was tried and skipped; false when the walk
       *  stopped on a failure that is not a placement problem. */
      exhausted: boolean
      failure: LadderFailure
      attempts: PlacementAttempt[]
    }

/**
 * Walk the rungs in order. `run` attempts one rung and reports success or a
 * typed failure; a failure advances only when {@link isLadderAdvanceFailure}.
 * `run` is never called again after it succeeded, so nothing here can move a
 * session whose agent already started.
 */
export async function walkPlacementLadder<T>(
  ladder: readonly PlacementRung[],
  run: (rung: PlacementRung, index: number) => Promise<LadderStep<T>>,
  now: () => number = Date.now,
): Promise<LadderWalk<T>> {
  const attempts: PlacementAttempt[] = []
  let last: LadderFailure | undefined
  for (let index = 0; index < ladder.length; index++) {
    const rung = ladder[index]!
    const startedAt = now()
    const step = await run(rung, index)
    const base = {
      rung: index,
      provider: rungProviderLabel(rung),
      ...(rung.model !== undefined ? { model: rung.model } : {}),
      durationMs: Math.max(0, now() - startedAt),
    }
    if (step.ok) {
      attempts.push({ ...base, outcome: "ok" })
      return { ok: true, rung: index, value: step.value, attempts }
    }
    const failure: LadderFailure = {
      code: step.code,
      message: step.message,
      ...(step.details !== undefined ? { details: step.details } : {}),
    }
    const egressIp = failure.details?.egressIp
    attempts.push({
      ...base,
      outcome: "failed",
      errorClass: failureErrorClass(failure),
      ...(typeof egressIp === "string" && egressIp.length > 0 ? { egressIp } : {}),
    })
    last = failure
    if (!isLadderAdvanceFailure(failure)) return { ok: false, exhausted: false, failure, attempts }
  }
  return {
    ok: false,
    exhausted: true,
    failure: last ?? { code: "placement_invalid", message: "placement.ladder is empty" },
    attempts,
  }
}

export function formatPlacementAttempts(attempts: readonly PlacementAttempt[]): string {
  return attempts
    .map(a => {
      const model = a.model ? ` ${a.model}` : ""
      const why = a.outcome === "failed" ? ` ${a.errorClass ?? "failed"}${a.egressIp ? ` (egress ${a.egressIp})` : ""}` : ""
      return `#${a.rung + 1} ${a.provider}${model}: ${a.outcome}${why}`
    })
    .join("; ")
}
