/**
 * HTTP-level predicates over an AIP-53 link-SESSION token (app-link-token.ts),
 * used by http-server.ts to narrowly widen two gates for a Telegram-
 * authorized link WITHOUT touching their general-purpose logic:
 *
 *   - `tunnelBearerAllowed`'s top-level tunnel-auth gate, for exactly
 *     `POST /apps/:appId/tool-call` (that one appId) and the four
 *     session-chat read routes (`GET /sessions/:id`, `/events`,
 *     `/events/stream`, `/capabilities`, that one sessionId);
 *   - the same tool-call route's `guardBrowserOrigin`/`authorize` pair,
 *     which run AFTER `tunnelBearerAllowed` on that one route.
 *
 * Deliberately narrow: a link-session token is single-app/single-session by
 * construction (its claims). Over plain HTTP it only reads; anything it can
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
  sessionId: string
  telegramUserId?: string
}

function resolveSessionAuth(req: IncomingMessage, keyPath: string | undefined): AppLinkSessionAuth | undefined {
  const token = extractAppLinkBearer(req)
  if (!token) return undefined
  const verified = verifyAppLinkSessionToken(token, keyPath)
  if (!verified.ok) return undefined
  const { appId, claims } = verified.payload
  const sessionId = claims.sessionId
  if (!sessionId) return undefined
  return {
    appId,
    sessionId,
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
 *  `/sessions/:id/capabilities`: the exact four GET routes session-chat
 *  reads for one session. Every other `/sessions/*` route (pty, kill, chat,
 *  prompt, the plain `/stream` line-tail, …) is deliberately excluded: the
 *  HTTP side of a link-session token reads one session, nothing else; its
 *  writes go only through the app's tool-call route and `ui.toolScope`. */
const SESSION_READ_RE = /^\/sessions\/([^/]+)(?:\/events\/stream|\/events|\/capabilities)?$/

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
  return auth && auth.sessionId === rawSessionId ? auth : undefined
}

/** One structured audit line per scoped request that actually reached a
 *  handler — distinct from `app-link-auth.ts`'s mint/authorize audit
 *  trail, which covers the link-auth exchange itself. */
export function logAppLinkAccess(entry: { route: string; auth: AppLinkSessionAuth; ip?: string }): void {
  console.error(
    `app-link-gate: access route=${entry.route} appId=${entry.auth.appId} sessionId=${entry.auth.sessionId} ` +
      `telegramUserId=${entry.auth.telegramUserId ?? "(none)"} ip=${entry.ip ?? "(unknown)"}`,
  )
}

/** True when EITHER predicate above grants `req` — the single check
 *  `tunnelBearerAllowed` needs; it doesn't care which route matched, only
 *  whether this request is one of the two shapes a link-session token can
 *  ever widen. Audits every grant (success only — a non-match is silent,
 *  same as every other `tunnelBearerAllowed` branch). */
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
