/**
 * The Telegram-identity-bound exchange for AIP-53 link tokens.
 *
 * `app_link_mint` (app-tools.ts) hands out a `"link"` token that proves
 * nothing about WHO opens it — it only commits, in advance, to the exact
 * `telegramUserId` that is allowed to. `authorizeAppLink` is the one place
 * that turns that promise into an actual grant: it verifies the opener's
 * Telegram Mini App `initData` against the daemon's own stored bot token
 * (`telegram-bot-creds.ts`), checks the signed `user.id` against the link's
 * claim, and — only on a match — mints the short-lived `"session"` token
 * that `dispatchAllowlistedAppTool`'s scoped mode and the tunnel gate's
 * read-route bypass actually accept.
 *
 * Threat model this closes: a link token FORWARDED or stolen off the
 * device it was sent to (screenshotted, copy-pasted into another chat,
 * intercepted mid-transit) is useless without also controlling the
 * Telegram account named in it — Telegram's own signature is what makes
 * `user.id` unforgeable here, not anything this daemon invents. What it
 * does NOT close: a compromised bot token lets an attacker forge
 * `initData` for ANY user id; a session token already issued stays valid
 * until its own (short) expiry even if the link token that produced it is
 * later revoked; and nothing here authenticates Telegram's OWN
 * infrastructure beyond trusting its documented signing scheme.
 */

import { createHash } from "node:crypto"
import {
  verifyAppLinkToken,
  mintAppLinkSessionToken,
  type VerifiedAppLinkToken,
} from "./app-link-token.js"
import { validateTelegramInitData } from "./telegram-init-data.js"
import type { TelegramBotCredsStore } from "./telegram-bot-creds.js"

const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = 300
const DEFAULT_SESSION_TTL_MS = 30 * 60_000
/** Hard cap on `sessionTtlMs` — it's only ever set by the privileged
 *  `app_link_mint`, but an unbounded value there would still mean a typo'd
 *  or deliberately huge TTL mints a session token valid far longer than a
 *  Telegram link-auth flow should ever need. */
const MAX_SESSION_TTL_MS = 24 * 60 * 60_000

export interface AppLinkAuthAuditEntry {
  ok: boolean
  route: string
  appId: string
  sessionId?: string
  telegramUserId?: string
  reason?: string
  ip?: string
}

export type AppLinkAuthLogger = (entry: AppLinkAuthAuditEntry) => void

/** Default logger — one structured line per attempt, success or failure.
 *  Never includes the token itself. */
export function defaultAppLinkAuthLogger(entry: AppLinkAuthAuditEntry): void {
  console.error(
    `app-link-auth: ${entry.ok ? "ok" : "denied"} route=${entry.route} appId=${entry.appId} ` +
      `sessionId=${entry.sessionId ?? "(none)"} telegramUserId=${entry.telegramUserId ?? "(none)"} ` +
      `ip=${entry.ip ?? "(unknown)"}${entry.reason ? ` reason=${entry.reason}` : ""}`,
  )
}

export interface AuthorizeAppLinkInput {
  linkToken: string
  initData: string
  telegramCreds: TelegramBotCredsStore
  /** Bot alias the link was minted against. Defaults to `"default"` — the
   *  same default `telegram_bot_token_set`/`_status` use. */
  botAlias?: string
  ip?: string
  userAgent?: string
  log?: AppLinkAuthLogger
  /** Test seam only. */
  keyPath?: string
}

export type AuthorizeAppLinkResult =
  | { ok: true; sessionToken: string; exp: number; appId: string; sessionId: string; telegramUserId: string }
  | { ok: false; status: 400 | 401 | 403; error: string }

function sessionTtlMsFromClaim(claims: VerifiedAppLinkToken["claims"]): number {
  const raw = claims.sessionTtlMs
  if (!raw) return DEFAULT_SESSION_TTL_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_TTL_MS
  return Math.min(parsed, MAX_SESSION_TTL_MS)
}

/**
 * Exchange a Telegram-gated `"link"` token + the opener's `initData` for a
 * `"session"` token scoped to exactly the link's `(appId, sessionId,
 * telegramUserId)`. Fail-closed at every step; every outcome (success AND
 * failure) is audited via `log`. The link token is REUSABLE until its own
 * `exp`: a Telegram button sits in a chat for days, and a second tap, a
 * webview reload or the UI's silent re-auth must all work. Single use would
 * add nothing: every exchange needs fresh `initData` (max age
 * `DEFAULT_INIT_DATA_MAX_AGE_SECONDS`) signed with the stored bot token for
 * exactly the link's `telegramUserId`, so a leaked link token alone is
 * useless.
 */
export async function authorizeAppLink(input: AuthorizeAppLinkInput): Promise<AuthorizeAppLinkResult> {
  const log = input.log ?? defaultAppLinkAuthLogger

  const verified = verifyAppLinkToken(input.linkToken, input.keyPath)
  if (!verified.ok) {
    log({ ok: false, route: "link-auth", appId: "(unknown)", reason: `link token: ${verified.error}`, ...(input.ip ? { ip: input.ip } : {}) })
    return { ok: false, status: 401, error: `invalid link token: ${verified.error}` }
  }
  const { payload } = verified
  const claimTelegramUserId = payload.claims.telegramUserId
  const sessionId = payload.claims.sessionId
  if (!payload.pendingTelegramAuth || !claimTelegramUserId || !sessionId) {
    log({ ok: false, route: "link-auth", appId: payload.appId, reason: "link token is not Telegram-gated", ...(input.ip ? { ip: input.ip } : {}) })
    return { ok: false, status: 400, error: "this link token does not require Telegram authorization" }
  }

  const botAlias = input.botAlias ?? payload.claims.botAlias ?? "default"
  const creds = await input.telegramCreds.read(botAlias)
  const validated = validateTelegramInitData(input.initData, creds?.token, {
    maxAgeSeconds: DEFAULT_INIT_DATA_MAX_AGE_SECONDS,
  })
  if (!validated.ok) {
    log({ ok: false, route: "link-auth", appId: payload.appId, sessionId, reason: `initData: ${validated.error}`, ...(input.ip ? { ip: input.ip } : {}) })
    return { ok: false, status: 401, error: `telegram authorization failed: ${validated.error}` }
  }

  if (String(validated.user.id) !== claimTelegramUserId) {
    log({
      ok: false,
      route: "link-auth",
      appId: payload.appId,
      sessionId,
      telegramUserId: String(validated.user.id),
      reason: `user mismatch: link token requires telegramUserId=${claimTelegramUserId}`,
      ...(input.ip ? { ip: input.ip } : {}),
    })
    return { ok: false, status: 403, error: "this Telegram account is not authorized for this link" }
  }

  const { token: sessionToken, exp } = mintAppLinkSessionToken({
    appId: payload.appId,
    claims: {
      sessionId,
      telegramUserId: claimTelegramUserId,
      ...(input.ip ? { authIp: input.ip } : {}),
      ...(input.userAgent ? { authUaHash: createHash("sha256").update(input.userAgent).digest("hex").slice(0, 16) } : {}),
    },
    ttlMs: sessionTtlMsFromClaim(payload.claims),
    ...(input.keyPath ? { keyPath: input.keyPath } : {}),
  })
  log({ ok: true, route: "link-auth", appId: payload.appId, sessionId, telegramUserId: claimTelegramUserId, ...(input.ip ? { ip: input.ip } : {}) })
  return { ok: true, sessionToken, exp, appId: payload.appId, sessionId, telegramUserId: claimTelegramUserId }
}
