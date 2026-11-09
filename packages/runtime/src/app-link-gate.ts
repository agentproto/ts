/**
 * HTTP-level predicates over an AIP-53 link-SESSION token (app-link-token.ts),
 * used by http-server.ts to narrowly widen two gates for a Telegram-
 * authorized link WITHOUT touching their general-purpose logic:
 *
 *   - `tunnelBearerAllowed`'s top-level tunnel-auth gate, for exactly
 *     `POST /apps/:appId/tool-call` (that one appId) and the read routes of
 *     the token's own session (`GET /sessions/:id`, `/events`,
 *     `/events/stream`, `/capabilities`, `/screencast`, `/screencast.jpg`,
 *     `/screencast.mjpg`, that one sessionId, only when the token carries
 *     a `sessionId` claim; `/screencast.jpg` of that id is a Bureau screenshot
 *     of the session's own newest open tab, fetched as that session, no
 *     recording),
 *     plus the three screencast spellings (and only those) of the browser
 *     session named by a `browserSessionId` claim (kept for chrome-live ids,
 *     a retired path), plus the two approval routes (`GET /approvals/:id`,
 *     `POST /approvals/:id/decision/telegram`, `appLinkApprovalRequest`),
 *     whose handler (`approvals/http.ts`) then enforces the `approvalId`
 *     claim and the owner-only `approvals.humanTelegramIds` list;
 *   - the same tool-call route's `guardBrowserOrigin`/`authorize` pair,
 *     which run AFTER `tunnelBearerAllowed` on that one route.
 *
 * Deliberately narrow: a link-session token is single-app by construction and
 * single-session when it carries a `sessionId` claim (a link about an
 * approval or a dossier carries none and reads no session over HTTP). Over plain HTTP it only reads, with one
 * exception: a token whose `approvalId` claim names an approval may decide
 * that one approval (`approvals/http.ts` checks the claim and the owner-only
 * `approvals.humanTelegramIds` list). Anything else it can
 * change goes through the app's tool-call route, limited to the app's own
 * `ui.toolScope` (claim-pinned arguments, plus the daemon's per-tool
 * ownership checks, e.g. `permissions_respond`). So these predicates don't
 * need their own allowlist beyond "does this token's own claim match what
 * the URL names" — `dispatchAllowlistedAppTool`'s scoped mode is the
 * actual tool-level enforcement; this file only decides whether a given
 * HTTP request gets as far as calling it.
 *
 * `keyPath` is a test seam only (default `undefined` → the real daemon's
 * persisted signing key, `app-link-token.ts`'s `defaultAppLinkKeyPath()`) —
 * a production caller never passes one.
 */

import type { IncomingMessage } from "node:http"
import { verifyAppLinkSessionToken, extractAppLinkBearer } from "./app-link-token.js"
import { resolvePublicBase } from "./public-origins.js"

export interface AppLinkSessionAuth {
  appId: string
  /** Absent for a link that is not about a session. */
  sessionId?: string
  telegramUserId?: string
  /** The token's claims minus the daemon's audit stamps: what a scoped
   *  tool call may pin as `$link.<name>`. */
  claims: Record<string, string>
}

function resolveSessionAuth(req: IncomingMessage, keyPath: string | undefined): AppLinkSessionAuth | undefined {
  const token = extractAppLinkBearer(req)
  if (!token) return undefined
  const verified = verifyAppLinkSessionToken(token, keyPath)
  if (!verified.ok) return undefined
  const { appId, claims } = verified.payload
  const sessionId = claims.sessionId
  const { authIp: _authIp, authUaHash: _authUaHash, ...scopeClaims } = claims
  return {
    appId,
    ...(sessionId ? { sessionId } : {}),
    claims: scopeClaims,
    ...(claims.telegramUserId ? { telegramUserId: claims.telegramUserId } : {}),
  }
}

/** A valid link-session token scoped to exactly `appId`'s own tool-call
 *  route — used both by `tunnelBearerAllowed` and by the tool-call route's
 *  own browser/bearer gates. */
export function appLinkToolCallAuth(
  req: IncomingMessage,
  appId: string,
  keyPath?: string,
): AppLinkSessionAuth | undefined {
  const auth = resolveSessionAuth(req, keyPath)
  return auth && auth.appId === appId ? auth : undefined
}

/** `/sessions/:id`, `/sessions/:id/events`, `/sessions/:id/events/stream`,
 *  `/sessions/:id/capabilities`: the four GET routes session-chat reads for
 *  one session, plus `/sessions/:id/screencast` and its `.jpg`/`.mjpg`
 *  spellings (the live frames of the session's own browser tab). Every other `/sessions/*` route (pty, kill, chat,
 *  prompt, the plain `/stream` line-tail, …) is deliberately excluded: the
 *  HTTP side of a link-session token reads one session, nothing else; its
 *  writes go only through the app's tool-call route and `ui.toolScope`. */
const SESSION_READ_RE = /^\/sessions\/([^/]+)(?:\/events\/stream|\/events|\/capabilities|\/screencast(?:\.jpg|\.mjpg)?)?$/

/** The three screencast spellings, the only `/sessions/:id` reads a
 *  `browserSessionId` claim unlocks. */
const SCREENCAST_PATH_RE = /^\/sessions\/[^/]+\/screencast(?:\.jpg|\.mjpg)?$/

export function appLinkSessionReadAuth(
  req: IncomingMessage,
  path: string,
  method: string,
  keyPath?: string,
): AppLinkSessionAuth | undefined {
  if (method !== "GET") return undefined
  const match = SESSION_READ_RE.exec(path)
  const rawSessionId = match?.[1]
  if (!rawSessionId) return undefined
  const auth = resolveSessionAuth(req, keyPath)
  if (!auth) return undefined
  if (auth.sessionId !== undefined && auth.sessionId === rawSessionId) return auth
  if (SCREENCAST_PATH_RE.test(path) && auth.claims.browserSessionId === rawSessionId) return auth
  return undefined
}

/** The two approval routes a link can reach: read one approval, decide it
 *  through the `telegram` channel. Nothing else under `/approvals` (list,
 *  create, wait, consume, the `web_click` decide, another method). */
const APPROVAL_READ_RE = /^\/approvals\/([^/]+)$/
const APPROVAL_DECIDE_RE = /^\/approvals\/([^/]+)\/decision\/telegram$/

export interface AppLinkApprovalRequest {
  action: "read" | "decide"
  /** The decoded `:id` of the route, which is what the handler acts on. */
  approvalId: string
  auth: AppLinkSessionAuth
}

/** Per-request memo: the tunnel gate and the approvals handler must see the
 *  SAME verdict. Re-verifying in the handler could flip a token that
 *  expired in between to "not a link", and the handler would then serve the
 *  request as the operator. */
const approvalRequestMemo = new WeakMap<IncomingMessage, AppLinkApprovalRequest | null>()

/**
 * A valid link-session token on one of the two approval routes, whatever
 * its claims: the tunnel gate admits it so the handler can refuse it with a
 * stable 403 and an audit line, and the handler serves the request in link
 * mode (never as the operator). Whether it may actually read or decide is
 * {@link appLinkApprovalRefusal}'s call. `undefined` for any other route or
 * method, or without a verifiable token.
 */
export function appLinkApprovalRequest(
  req: IncomingMessage,
  path: string,
  method: string,
  keyPath?: string,
): AppLinkApprovalRequest | undefined {
  const match =
    method === "GET" ? APPROVAL_READ_RE.exec(path) : method === "POST" ? APPROVAL_DECIDE_RE.exec(path) : null
  if (!match?.[1]) return undefined
  const memo = approvalRequestMemo.get(req)
  if (memo !== undefined) return memo ?? undefined
  let approvalId: string
  try {
    approvalId = decodeURIComponent(match[1])
  } catch {
    approvalRequestMemo.set(req, null)
    return undefined
  }
  const auth = resolveSessionAuth(req, keyPath)
  const result: AppLinkApprovalRequest | null = auth
    ? { action: method === "GET" ? "read" : "decide", approvalId, auth }
    : null
  approvalRequestMemo.set(req, result)
  return result ?? undefined
}

export type AppLinkApprovalRefusal = "claim_mismatch" | "no_telegram_identity" | "not_allowlisted"

/** Why a link may not touch this approval, or `undefined` when it may: its
 *  `approvalId` claim names exactly the route's id, it carries a verified
 *  `telegramUserId`, and that id is in `approvals.humanTelegramIds` (an
 *  empty list refuses everyone). */
export function appLinkApprovalRefusal(
  request: AppLinkApprovalRequest,
  humanTelegramIds: readonly string[],
): AppLinkApprovalRefusal | undefined {
  if (request.auth.claims.approvalId === undefined || request.auth.claims.approvalId !== request.approvalId) {
    return "claim_mismatch"
  }
  const telegramUserId = request.auth.telegramUserId
  if (!telegramUserId) return "no_telegram_identity"
  if (!humanTelegramIds.includes(telegramUserId)) return "not_allowlisted"
  return undefined
}

/** One audit line per approval-link request that reached the handler.
 *  Never the token, never the approval's preview or payload. The id is
 *  printed only when it is a plain token (it comes from the URL). */
export function logAppLinkApprovalAccess(entry: {
  request: AppLinkApprovalRequest
  allowed: boolean
  reason?: string
  ip?: string
}): void {
  const { request } = entry
  const approvalId = /^[A-Za-z0-9_.-]{1,128}$/.test(request.approvalId) ? request.approvalId : "(unprintable)"
  console.error(
    `approval-link: ${request.action} ${entry.allowed ? "allowed" : "denied"} approvalId=${approvalId} ` +
      `telegramUserId=${request.auth.telegramUserId ?? "(none)"} appId=${request.auth.appId} ` +
      `ip=${entry.ip ?? "(unknown)"}${entry.reason ? ` reason=${entry.reason}` : ""}`,
  )
}

/** One structured audit line per scoped request that actually reached a
 *  handler — distinct from `app-link-auth.ts`'s mint/authorize audit
 *  trail, which covers the link-auth exchange itself. */
export function logAppLinkAccess(entry: { route: string; auth: AppLinkSessionAuth; ip?: string }): void {
  console.error(
    `app-link-gate: access route=${entry.route} appId=${entry.auth.appId} sessionId=${entry.auth.sessionId ?? "(none)"} ` +
      `telegramUserId=${entry.auth.telegramUserId ?? "(none)"} ip=${entry.ip ?? "(unknown)"}`,
  )
}

/** True when any predicate above grants `req`: the single check
 *  `tunnelBearerAllowed` needs; it doesn't care which route matched, only
 *  whether this request is one of the shapes a link-session token can ever
 *  widen. Audits every tool-call and session-read grant (success only: a
 *  non-match is silent, same as every other `tunnelBearerAllowed` branch);
 *  the approvals handler audits the approval routes itself. */
export function appLinkTunnelBypass(req: IncomingMessage, path: string, method: string, keyPath?: string): boolean {
  const ip = req.socket.remoteAddress ?? undefined
  const toolCallMatch = /^\/apps\/(.+)\/tool-call$/.exec(path)
  if (toolCallMatch && method === "POST" && toolCallMatch[1]) {
    const auth = appLinkToolCallAuth(req, decodeURIComponent(toolCallMatch[1]), keyPath)
    if (auth) {
      logAppLinkAccess({ route: "tunnel:tool-call", auth, ...(ip ? { ip } : {}) })
      return true
    }
  }
  const readAuth = appLinkSessionReadAuth(req, path, method, keyPath)
  if (readAuth) {
    logAppLinkAccess({ route: `tunnel:${path}`, auth: readAuth, ...(ip ? { ip } : {}) })
    return true
  }
  // Audited by the approvals handler, allowed or denied (`approval-link:`).
  if (appLinkApprovalRequest(req, path, method, keyPath)) return true
  return false
}

/** True when the request carries an `Origin` that is the origin it was
 *  reached at (`resolvePublicBase`: scheme + host + port, host
 *  case-insensitive). `POST /apps/:appId/link-auth` uses it to skip the
 *  `daemon.allowedOrigins` refusal for the page the link opened: that route
 *  is gated by the link token plus Telegram `initData`, not by the origin,
 *  and a tunnel hostname is not known ahead of time. Absent or cross-origin
 *  returns false (the caller keeps the normal guard). */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== "string" || origin.length === 0) return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  return parsed.origin === new URL(resolvePublicBase(req.headers).origin).origin
}
