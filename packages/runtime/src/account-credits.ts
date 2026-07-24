/**
 * Best-effort, per-provider "remaining account credits" — the real prepaid USD
 * balance a provider still reports for the key backing an auth profile, enriched
 * onto the local spend rollup. The sibling of `remaining-quota.ts`: that reads a
 * rolling rate-limit budget (Anthropic), this reads a prepaid dollar balance
 * (OpenRouter, Moonshot).
 *
 * One layer, deliberately non-fatal and side-effect-free on the hot path:
 *
 *   {@link ProviderAccountCreditsReader} dispatches on `profile.endpoint` to a
 *   per-provider fetcher that issues a single, non-billable GET against the
 *   provider's *balance* endpoint (never an inference/completions endpoint —
 *   these reads must have zero side effects and cost nothing) and zod-parses the
 *   response. Every failure mode — unsupported endpoint, no resolvable
 *   credential, oauth-bearer with no api key, non-2xx, timeout, network error, a
 *   throwing store, an unparseable body — collapses to `undefined`. The whole
 *   `readAccountCredits` body is wrapped so it can NEVER throw and NEVER block
 *   the rollup.
 *
 * DISCIPLINE — mirrors the rollup's "undefined when unknown, never a $0
 * stand-in" rule: a missing/null/unparseable balance yields `undefined`, never a
 * fabricated `0`. A *real* reported balance of `0` (a genuinely empty wallet) is
 * a real number and is kept. Provider JSON crosses the type boundary exactly
 * once, through a zod `safeParse` — there are no `any`/`unknown`/`as` casts.
 */

import { z } from "zod"

/** A provider-reported prepaid account balance. `basis` is always `"provider"`
 *  — this is the real wallet, NOT a local spend estimate. */
export interface AccountCredits {
  balanceUsd: number
  basis: "provider"
  /** Which provider endpoint the balance came from, e.g. `"openrouter:/key"`,
   *  `"moonshot:/balance"`. */
  source?: string
  /** ISO timestamp the balance was read. */
  asOf?: string
}

/** The minimal auth-profile projection a credits reader needs — deliberately
 *  decoupled from `@agentproto/auth`'s full `AuthProfile`. A `profileRef` for
 *  logging, the billing `endpoint` (only `"openrouter"`/`"moonshot"` are handled
 *  today), the `method` (only `"api-key"` carries a balance-readable secret),
 *  and the `credentialRef` handle resolved to a bearer at read time. */
export interface CreditReadableProfile {
  profileRef: string
  endpoint: string
  method: "oauth-bearer" | "api-key"
  credentialRef?: string
}

/** Injectable read context. Everything a fetcher needs to make one safe GET,
 *  wired for production and overridable in tests. */
export interface CreditReadCtx {
  /** Resolve a profile's opaque `credentialRef` to its bearer secret, or
   *  `undefined` when it can't be resolved. */
  resolveCredential(ref: string): Promise<string | undefined>
  /** Fetch used for the balance GET. Injectable so tests never touch the
   *  network. */
  fetchImpl: typeof fetch
  /** Abort the fetch after this many ms (default 4000). */
  timeoutMs?: number
  /** Stamp for `asOf`. Injected for deterministic tests; defaults to the wall
   *  clock. */
  now?: () => Date
  /** Per-provider base-URL overrides for tests; default to the real hosts. */
  baseUrls?: { openrouter?: string; moonshot?: string }
}

/** Reads the live account credits for a profile, or `undefined` when it can't
 *  (unsupported endpoint, no credential, non-2xx, unparseable). MUST NOT
 *  throw. */
export interface AccountCreditsReader {
  readAccountCredits(
    profile: CreditReadableProfile,
    ctx: CreditReadCtx,
  ): Promise<AccountCredits | undefined>
}

const DEFAULT_TIMEOUT_MS = 4000
const OPENROUTER_BASE = "https://openrouter.ai/api/v1"
const MOONSHOT_BASE = "https://api.moonshot.ai"

/** A per-provider balance fetcher. Given a profile and context, returns the
 *  mapped {@link AccountCredits} or `undefined`. Must be side-effect-free (a
 *  plain GET on a balance endpoint) and never throw beyond what the reader's
 *  outer try/catch catches. */
type CreditFetcher = (
  profile: CreditReadableProfile,
  ctx: CreditReadCtx,
) => Promise<AccountCredits | undefined>

/** Resolve the bearer secret for a profile's `credentialRef`, gating on
 *  `method === "api-key"` — the balance endpoints take the normal inference
 *  key, so an oauth-bearer profile (no api key) yields `undefined` and no
 *  fetch. */
async function resolveApiKey(
  profile: CreditReadableProfile,
  ctx: CreditReadCtx,
): Promise<string | undefined> {
  if (profile.method !== "api-key") return undefined
  if (!profile.credentialRef) return undefined
  const secret = await ctx.resolveCredential(profile.credentialRef).catch(() => undefined)
  return secret || undefined
}

/** A GET under a short abort timeout with a bearer. Returns the parsed JSON as
 *  `unknown` (the single type boundary, handed straight to a zod schema) or
 *  `undefined` on any non-2xx / network / abort failure. */
async function getJson(
  url: string,
  bearer: string,
  ctx: CreditReadCtx,
): Promise<unknown | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await ctx.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** OpenRouter `GET /key` — the credit-limit endpoint. `data.limit_remaining` is
 *  the remaining USD headroom, or `null` for a cap-less key (→ undefined, never
 *  fabricated). Absent field also → undefined. */
const OPENROUTER_KEY_SCHEMA = z
  .object({
    data: z
      .object({ limit_remaining: z.number().nullable().optional() })
      .passthrough(),
  })
  .passthrough()

const fetchOpenRouter: CreditFetcher = async (profile, ctx) => {
  const bearer = await resolveApiKey(profile, ctx)
  if (!bearer) return undefined
  const base = ctx.baseUrls?.openrouter ?? OPENROUTER_BASE
  const body = await getJson(`${base}/key`, bearer, ctx)
  if (body === undefined) return undefined
  const parsed = OPENROUTER_KEY_SCHEMA.safeParse(body)
  if (!parsed.success) return undefined
  const remaining = parsed.data.data.limit_remaining
  // null = cap-less key (no meaningful balance), absent = undefined — never a
  // fabricated 0. Only a finite number is a real balance.
  if (remaining === null || remaining === undefined) return undefined
  if (!Number.isFinite(remaining)) return undefined
  return {
    balanceUsd: remaining,
    basis: "provider",
    source: "openrouter:/key",
    asOf: (ctx.now ?? (() => new Date()))().toISOString(),
  }
}

/** Moonshot `GET /v1/users/me/balance`. `data.available_balance` is the
 *  spendable USD balance — a real number kept INCLUDING when `≤ 0` (a genuinely
 *  empty wallet); only a missing/unparseable value → undefined. */
const MOONSHOT_BALANCE_SCHEMA = z
  .object({
    data: z
      .object({ available_balance: z.number() })
      .passthrough(),
  })
  .passthrough()

const fetchMoonshot: CreditFetcher = async (profile, ctx) => {
  const bearer = await resolveApiKey(profile, ctx)
  if (!bearer) return undefined
  const base = ctx.baseUrls?.moonshot ?? MOONSHOT_BASE
  const body = await getJson(`${base}/v1/users/me/balance`, bearer, ctx)
  if (body === undefined) return undefined
  const parsed = MOONSHOT_BALANCE_SCHEMA.safeParse(body)
  if (!parsed.success) return undefined
  const balance = parsed.data.data.available_balance
  if (!Number.isFinite(balance)) return undefined
  return {
    balanceUsd: balance,
    basis: "provider",
    source: "moonshot:/balance",
    asOf: (ctx.now ?? (() => new Date()))().toISOString(),
  }
}

/**
 * Provider account-credits reader. Dispatches on `profile.endpoint` via an
 * internal map with entries ONLY for `"openrouter"` and `"moonshot"`; every
 * other endpoint (anthropic, openai, google, xai, …) short-circuits to
 * `undefined` with no fetch. The whole body is wrapped in a belt-and-suspenders
 * try/catch so it can NEVER throw into the rollup.
 */
export class ProviderAccountCreditsReader implements AccountCreditsReader {
  private readonly fetchers: Record<string, CreditFetcher> = {
    openrouter: fetchOpenRouter,
    moonshot: fetchMoonshot,
  }

  async readAccountCredits(
    profile: CreditReadableProfile,
    ctx: CreditReadCtx,
  ): Promise<AccountCredits | undefined> {
    try {
      const fetcher = this.fetchers[profile.endpoint]
      if (!fetcher) return undefined
      return await fetcher(profile, ctx)
    } catch {
      // Belt-and-suspenders: the reader must NEVER throw into the rollup.
      return undefined
    }
  }
}
