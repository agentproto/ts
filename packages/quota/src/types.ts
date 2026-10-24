import { z } from "zod"

/**
 * Where a quota figure came from. `provider` is a documented provider
 * surface; `observed` is derived from this host's own traffic; `estimated`
 * is a local computation; `probe` is an undocumented surface reached through
 * a connector and MUST NOT be emitted by core readers.
 */
export const QUOTA_BASES = ["provider", "probe", "observed", "estimated"] as const
export type QuotaBasis = (typeof QUOTA_BASES)[number]

const isoTimestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "expected an ISO-8601 timestamp",
})

export const quotaWindowSchema = z.object({
  /** Open string: "5h", "7d", "month", "minute", "day", "primary", "key_limit", ... */
  id: z.string().min(1),
  /** 0-100. Required: a window that cannot state it is not emitted. */
  remainingPct: z.number().min(0).max(100),
  used: z.number().optional(),
  limit: z.number().optional(),
  remaining: z.number().optional(),
  unit: z.string().optional(),
  resetsAt: isoTimestamp.optional(),
})
export type QuotaWindow = z.infer<typeof quotaWindowSchema>

export const quotaCreditsSchema = z.object({
  balanceUsd: z.number().optional(),
  unlimited: z.boolean().optional(),
  currency: z.string().min(1),
})
export type QuotaCredits = z.infer<typeof quotaCreditsSchema>

export const quotaStatusSchema = z.object({
  profileRef: z.string().min(1),
  asOf: isoTimestamp,
  basis: z.enum(QUOTA_BASES),
  source: z.string().optional(),
  windows: z.array(quotaWindowSchema),
  credits: quotaCreditsSchema.optional(),
})
export type QuotaStatus = z.infer<typeof quotaStatusSchema>

/** The minimal auth-profile projection a reader needs. */
export interface QuotaProfile {
  profileRef: string
  endpoint: string
  method: "oauth-bearer" | "api-key"
  credentialRef?: string
}

export interface QuotaReadContext {
  signal?: AbortSignal
  /** Resolve a profile's opaque credentialRef to a bearer secret. */
  resolveCredential?(ref: string): Promise<string | undefined>
  fetchImpl?: typeof fetch
  now?: () => Date
}

/**
 * Reads quota for a profile. MUST NOT throw: any failure or unknown value
 * resolves to `undefined`. Never fabricates a figure.
 */
export interface QuotaReader {
  readonly id: string
  supports(profile: QuotaProfile): boolean
  read(profile: QuotaProfile, ctx: QuotaReadContext): Promise<QuotaStatus | undefined>
}
