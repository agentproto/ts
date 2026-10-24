import { z } from "zod"
import { buildQuotaStatus, remainingPctFromCounts } from "../build.js"
import { defineQuotaReader } from "../registry.js"
import type { QuotaCredits, QuotaProfile, QuotaReadContext, QuotaReader, QuotaStatus, QuotaWindow } from "../types.js"

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
const DEFAULT_TIMEOUT_MS = 4000

const OPENROUTER_KEY_SCHEMA = z
  .object({
    data: z
      .object({
        limit: z.number().nullable().optional(),
        limit_remaining: z.number().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough()

export interface OpenRouterQuotaReaderOptions {
  baseUrl?: string
  timeoutMs?: number
}

/** GET `${baseUrl}/key` and parse the body, never throwing. */
async function getKeyJson(
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
    const res = await (ctx.fetchImpl ?? fetch)(`${baseUrl}/key`, {
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
 * OpenRouter quota reader: `GET /key` exposes the key's USD cap and remaining
 * headroom. The whole read is wrapped so it never throws; an uncapped key
 * (`limit_remaining` null/absent) yields no window and no credits.
 */
export function createOpenRouterQuotaReader(opts?: OpenRouterQuotaReaderOptions): QuotaReader {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return defineQuotaReader({
    id: "openrouter-key",
    supports: (profile: QuotaProfile): boolean =>
      profile.endpoint === "openrouter" && profile.method === "api-key",
    read: async (
      profile: QuotaProfile,
      ctx: QuotaReadContext,
    ): Promise<QuotaStatus | undefined> => {
      try {
        if (!profile.credentialRef) return undefined
        if (!ctx.resolveCredential) return undefined
        const secret = await ctx.resolveCredential(profile.credentialRef).catch(() => undefined)
        if (!secret) return undefined

        const body = await getKeyJson(baseUrl, secret, ctx, timeoutMs)
        if (body === undefined) return undefined
        const parsed = OPENROUTER_KEY_SCHEMA.safeParse(body)
        if (!parsed.success) return undefined

        const { limit, limit_remaining } = parsed.data.data
        const windows: QuotaWindow[] = []
        if (
          typeof limit === "number" &&
          Number.isFinite(limit) &&
          typeof limit_remaining === "number" &&
          Number.isFinite(limit_remaining)
        ) {
          const remainingPct = remainingPctFromCounts(limit_remaining, limit)
          if (remainingPct !== undefined) {
            windows.push({
              id: "key_limit",
              remainingPct,
              remaining: limit_remaining,
              limit,
              unit: "USD",
            })
          }
        }
        let credits: QuotaCredits | undefined
        if (typeof limit_remaining === "number" && Number.isFinite(limit_remaining)) {
          credits = { balanceUsd: limit_remaining, currency: "USD" }
        }

        return buildQuotaStatus({
          profileRef: profile.profileRef,
          basis: "provider",
          source: "openrouter:/key",
          now: ctx.now,
          windows,
          ...(credits !== undefined ? { credits } : {}),
        })
      } catch {
        return undefined
      }
    },
  })
}
