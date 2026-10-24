import type { QuotaBasis, QuotaCredits, QuotaStatus, QuotaWindow } from "./types.js"
import { quotaWindowSchema } from "./types.js"

/** remainingPct from a used percentage, or undefined when it is not a finite 0-100 number. */
export function remainingPctFromUsed(usedPct: number | null | undefined): number | undefined {
  if (usedPct === null || usedPct === undefined || !Number.isFinite(usedPct)) return undefined
  if (usedPct < 0 || usedPct > 100) return undefined
  return 100 - usedPct
}

/** remainingPct from remaining/limit counts, or undefined when limit is not a positive finite number. */
export function remainingPctFromCounts(
  remaining: number | null | undefined,
  limit: number | null | undefined,
): number | undefined {
  if (remaining === null || remaining === undefined || limit === null || limit === undefined) {
    return undefined
  }
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return undefined
  if (remaining < 0 || remaining > limit) return undefined
  return (remaining / limit) * 100
}

export interface BuildQuotaStatusInput {
  profileRef: string
  basis: QuotaBasis
  source?: string
  now?: () => Date
  /** Candidate windows; any that fail validation are dropped, never repaired. */
  windows?: readonly unknown[]
  credits?: QuotaCredits
}

/**
 * Assemble a QuotaStatus. Invalid windows are omitted. Returns `undefined`
 * when there is nothing to report (no valid window and no credits).
 */
export function buildQuotaStatus(input: BuildQuotaStatusInput): QuotaStatus | undefined {
  const windows: QuotaWindow[] = []
  for (const candidate of input.windows ?? []) {
    const parsed = quotaWindowSchema.safeParse(candidate)
    if (parsed.success) windows.push(parsed.data)
  }
  if (windows.length === 0 && input.credits === undefined) return undefined
  return {
    profileRef: input.profileRef,
    asOf: (input.now ?? (() => new Date()))().toISOString(),
    basis: input.basis,
    ...(input.source !== undefined ? { source: input.source } : {}),
    windows,
    ...(input.credits !== undefined ? { credits: input.credits } : {}),
  }
}
