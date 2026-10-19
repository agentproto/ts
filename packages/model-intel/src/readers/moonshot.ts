import { z } from "zod"
import { buildQuotaStatus } from "../build.js"
import { defineQuotaReader } from "../registry.js"
import type { QuotaProfile, QuotaReadContext, QuotaReader, QuotaStatus } from "../types.js"

const DEFAULT_BASE_URL = "https://api.moonshot.ai"
const DEFAULT_TIMEOUT_MS = 4000

const MOONSHOT_BALANCE_SCHEMA = z
  .object({
    data: z
      .object({
        available_balance: z.number(),
      })
      .passthrough(),
  })
  .passthrough()

export interface MoonshotQuotaReaderOptions {
  baseUrl?: string
  timeoutMs?: number
}

/** GET `${baseUrl}/v1/users/me/balance` and parse the body, never throwing. */
async function getBalanceJson(
  baseUrl: string,
  secret: string,
  ctx: QuotaReadContext,
  timeoutMs: number,
): Promise<unknown | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  ctx.signal?.addEventListener("abort", onAbort)
  try {
    const res = await (ctx.fetchImpl ?? fetch)(`${baseUrl}/v1/users/me/balance`, {
      method: "GET",
      headers: { authorization: `Bearer ${secret}` },
      signal: controller.signal,
    })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Moonshot balance reader: `GET /v1/users/me/balance` exposes the account's
 * available USD balance, but no cap, so it is reported as credits-only (no
 * window). The whole read never throws; a balance of 0 or below is real data
 * and is kept as is.
 */
export function createMoonshotQuotaReader(opts?: MoonshotQuotaReaderOptions): QuotaReader {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return defineQuotaReader({
    id: "moonshot-balance",
    supports: (profile: QuotaProfile): boolean =>
      profile.endpoint === "moonshot" && profile.method === "api-key",
    read: async (
      profile: QuotaProfile,
      ctx: QuotaReadContext,
    ): Promise<QuotaStatus | undefined> => {
      try {
        if (!profile.credentialRef) return undefined
        if (!ctx.resolveCredential) return undefined
        const secret = await ctx.resolveCredential(profile.credentialRef).catch(() => undefined)
        if (!secret) return undefined

        const body = await getBalanceJson(baseUrl, secret, ctx, timeoutMs)
        if (body === undefined) return undefined
        const parsed = MOONSHOT_BALANCE_SCHEMA.safeParse(body)
        if (!parsed.success) return undefined

        const balance = parsed.data.data.available_balance
        if (!Number.isFinite(balance)) return undefined

        return buildQuotaStatus({
          profileRef: profile.profileRef,
          basis: "provider",
          source: "moonshot:/users/me/balance",
          now: ctx.now,
          windows: [],
          credits: { balanceUsd: balance, currency: "USD" },
        })
      } catch {
        return undefined
      }
    },
  })
}
