/**
 * Best-effort, per-provider "live remaining quota" — the real remaining
 * headroom a provider still reports for a rolling window (Anthropic's unified
 * 5h/7d rate-limit budget), enriched onto the local spend rollup.
 *
 * Two layers, deliberately separated by testability:
 *
 *  1. PURE + fully unit-tested: {@link parseAnthropicRateLimitHeaders} turns a
 *     response's rate-limit headers into `{ "5h"?, "7d"? }` RemainingQuota
 *     entries. It NEVER fabricates — a missing/unparseable remaining OR reset
 *     omits that window entirely (a RemainingQuota with no real `resetsAt`
 *     would be a lie), matching the rollup's "undefined when unknown, never a
 *     $0 stand-in" discipline.
 *
 *  2. IMPURE + best-effort: {@link AnthropicRemainingQuotaReader} does its OWN
 *     short-timeout fetch to obtain those headers, because adapters spawn child
 *     CLIs and there is no in-process Anthropic response to hook. Every failure
 *     mode — wrong endpoint, no resolvable token, timeout, network error, a
 *     throwing store — collapses to the last-seen value from
 *     {@link readProfileQuota} or `undefined`. The whole `readRemainingQuota`
 *     body is wrapped so it can NEVER throw and NEVER block the rollup.
 */

import { resolveClaudeCodeOauthToken } from "./claude-code-oauth-source.js"
import {
  readProfileQuota,
  recordProfileQuota,
  type QuotaStoreOptions,
  type StoredProfileQuota,
} from "./remaining-quota-store.js"

/** A provider-reported remaining budget for one rolling window. `basis` is
 *  always `"provider"` — this is the real bill's headroom, NOT the local spend
 *  estimate (which is `basis: "local-estimate"`). */
export interface RemainingQuota {
  window: string
  remaining: number
  resetsAt: string
  basis: "provider"
}

/** The minimal auth-profile projection a reader needs — a `profileRef` to key
 *  the store, the billing `endpoint` (only `"anthropic"` is handled today),
 *  the `method`, and an optional self-refreshing `source` (e.g.
 *  `"claude-code-oauth"`). Deliberately decoupled from `@agentproto/auth`'s
 *  full `AuthProfile`. */
export interface QuotaReadableProfile {
  profileRef: string
  endpoint: string
  method: "oauth-bearer" | "api-key"
  source?: string
}

/** Reads the live remaining quota for a profile+window, or `undefined` when it
 *  can't (unsupported endpoint, no live value, no stored fallback). MUST NOT
 *  throw. */
export interface RemainingQuotaReader {
  readRemainingQuota(
    profile: QuotaReadableProfile,
    window: string,
  ): Promise<RemainingQuota | undefined>
}

/** Both windows keyed by their label — the parse result and the stored shape. */
type WindowQuotas = { "5h"?: RemainingQuota; "7d"?: RemainingQuota }

/** Read a header case-insensitively from either a `Headers` or a plain record
 *  (adapters/tests hand us both). */
function headerGet(
  headers: Headers | Record<string, string | undefined>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }
  const direct = headers[name]
  if (direct !== undefined) return direct
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

/** Parse a remaining-count header. Integer count only; empty/garbage →
 *  undefined (that window is then omitted, never fabricated). */
function parseRemaining(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

/** Normalize a reset header — unix-epoch SECONDS (possibly fractional) OR an
 *  ISO-8601 instant — to an ISO string. Unparseable → undefined. */
function parseResetToIso(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  // Purely numeric ⇒ unix epoch seconds (Anthropic's documented form).
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const secs = Number(trimmed)
    if (!Number.isFinite(secs)) return undefined
    const date = new Date(secs * 1000)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  // Otherwise try to parse it as an ISO instant.
  const ms = Date.parse(trimmed)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

/**
 * PURE: extract the unified 5h/7d remaining budgets from a response's
 * rate-limit headers. Reads `anthropic-ratelimit-unified-<w>-remaining` +
 * `-<w>-reset` for `<w> ∈ {5h, 7d}`. A window is emitted ONLY when both its
 * remaining and its reset parse — otherwise it's omitted (never fabricated).
 */
export function parseAnthropicRateLimitHeaders(
  headers: Headers | Record<string, string | undefined>,
): WindowQuotas {
  const result: WindowQuotas = {}
  for (const label of ["5h", "7d"] as const) {
    const remaining = parseRemaining(
      headerGet(headers, `anthropic-ratelimit-unified-${label}-remaining`),
    )
    if (remaining === undefined) continue
    const resetsAt = parseResetToIso(
      headerGet(headers, `anthropic-ratelimit-unified-${label}-reset`),
    )
    if (resetsAt === undefined) continue
    result[label] = { window: label, remaining, resetsAt, basis: "provider" }
  }
  return result
}

/** Pick the requested window out of a `{ "5h"?, "7d"? }` map. */
function pickWindow(windows: WindowQuotas, window: string): RemainingQuota | undefined {
  if (window === "5h") return windows["5h"]
  if (window === "7d") return windows["7d"]
  return undefined
}

/** Injectable config for {@link AnthropicRemainingQuotaReader}. Everything has
 *  a real default so the wired surfaces just `new AnthropicRemainingQuotaReader()`;
 *  tests inject a fake `fetchImpl`/`resolveToken` and a temp store `dir`. */
export interface AnthropicReaderConfig {
  /** Fetch used for the live header probe. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Endpoint probed for rate-limit headers. Defaults to the Anthropic
   *  messages endpoint. Injectable so an unknown endpoint can't wedge it and
   *  so tests never touch the network. */
  endpointUrl?: string
  /** Abort the live fetch after this many ms (default 2500). */
  timeoutMs?: number
  /** Model id sent in the minimal probe request. */
  model?: string
  /** Resolve a bearer for `oauth-bearer` + `source: "claude-code-oauth"`.
   *  Defaults to {@link resolveClaudeCodeOauthToken}. */
  resolveToken?: (source: string) => Promise<string>
  /** Store options (temp `dir` for tests). */
  store?: QuotaStoreOptions
  /** Stamp for `fetchedAt`. Injected so tests are deterministic; defaults to
   *  the wall clock. */
  now?: () => Date
}

const DEFAULT_ENDPOINT_URL = "https://api.anthropic.com/v1/messages"
const DEFAULT_TIMEOUT_MS = 2500
const DEFAULT_MODEL = "claude-haiku-4-5-20251001"
const ANTHROPIC_VERSION = "2023-06-01"
/** Beta header Claude Code's OAuth bearer requires on the messages endpoint. */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"

/**
 * Anthropic reader. Handles ONLY `endpoint === "anthropic"`. The load-bearing,
 * tested parts are the parse (above) and the store round-trip; the live fetch
 * is an optional best-effort layer that resolves a Claude Code OAuth bearer,
 * probes the messages endpoint for its rate-limit headers under a short
 * timeout, persists whatever it parses, and — on ANY failure — falls back to
 * the last-seen store value (or undefined). It never throws and never blocks.
 */
export class AnthropicRemainingQuotaReader implements RemainingQuotaReader {
  private readonly fetchImpl: typeof fetch
  private readonly endpointUrl: string
  private readonly timeoutMs: number
  private readonly model: string
  private readonly resolveToken: (source: string) => Promise<string>
  private readonly store?: QuotaStoreOptions
  private readonly now: () => Date

  constructor(config?: AnthropicReaderConfig) {
    this.fetchImpl = config?.fetchImpl ?? fetch
    this.endpointUrl = config?.endpointUrl ?? DEFAULT_ENDPOINT_URL
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.model = config?.model ?? DEFAULT_MODEL
    this.resolveToken = config?.resolveToken ?? resolveClaudeCodeOauthToken
    this.store = config?.store
    this.now = config?.now ?? (() => new Date())
  }

  async readRemainingQuota(
    profile: QuotaReadableProfile,
    window: string,
  ): Promise<RemainingQuota | undefined> {
    try {
      // Only Anthropic exposes these headers; anything else (e.g. gemini) is a
      // clean undefined — never a wedged fetch against a foreign endpoint.
      if (profile.endpoint !== "anthropic") return undefined

      // Best-effort live probe → parse → persist. Any failure yields undefined
      // headers and we fall through to the store below.
      const headers = await this.fetchHeaders(profile).catch(() => undefined)
      if (headers) {
        const parsed = parseAnthropicRateLimitHeaders(headers)
        await this.persist(profile.profileRef, parsed).catch(() => {})
        const live = pickWindow(parsed, window)
        if (live) return live
      }

      // Fallback: last-seen value from the store.
      const stored = await readProfileQuota(profile.profileRef, this.store).catch(
        () => undefined,
      )
      return stored ? pickWindow(stored.windows, window) : undefined
    } catch {
      // Belt-and-suspenders: the reader must NEVER throw into the rollup.
      return undefined
    }
  }

  /** Resolve a bearer and probe the endpoint for rate-limit headers under a
   *  short abort timeout. Returns undefined when no safe credential is
   *  available (so an api-key profile with no in-process secret simply falls
   *  back to the store rather than firing an unauthenticated request). */
  private async fetchHeaders(
    profile: QuotaReadableProfile,
  ): Promise<Headers | undefined> {
    // Only the self-refreshing Claude Code OAuth source yields a bearer we can
    // resolve in-process. Everything else → no live probe (store fallback).
    if (profile.method !== "oauth-bearer" || profile.source !== "claude-code-oauth") {
      return undefined
    }
    const token = await this.resolveToken(profile.source).catch(() => undefined)
    if (!token) return undefined

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(this.endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": ANTHROPIC_OAUTH_BETA,
          authorization: `Bearer ${token}`,
        },
        // Minimal probe — the rate-limit headers ride on the response
        // regardless of the body's outcome; we only read `res.headers`.
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "." }],
        }),
        signal: controller.signal,
      })
      return res.headers
    } finally {
      clearTimeout(timer)
    }
  }

  /** Merge the freshly-parsed windows over any stored ones (a probe that only
   *  returned 5h must not wipe a previously-seen 7d) and persist. No-op when
   *  the parse yielded nothing. */
  private async persist(profileRef: string, windows: WindowQuotas): Promise<void> {
    if (!windows["5h"] && !windows["7d"]) return
    const existing = await readProfileQuota(profileRef, this.store).catch(
      () => undefined,
    )
    const merged: StoredProfileQuota = {
      profileRef,
      windows: { ...(existing?.windows ?? {}), ...windows },
      fetchedAt: this.now().toISOString(),
    }
    await recordProfileQuota(merged, this.store)
  }
}
