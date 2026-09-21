/**
 * Per-boot embed tokens for MCP-Apps widget panels (see registerMcpApps).
 *
 * A panel rendered by an MCP-Apps host (Claude Desktop, VS Code webview, …)
 * iframes the daemon's standalone app host — but the host's widget context
 * is a sandboxed (often opaque) origin that no frame-ancestors allowlist can
 * name. `vscode-webview:` is the exception, not the rule. The daemon
 * therefore needs an unforgeable proof that a frame request descends from a
 * legitimate host rendering of the panel's OWN resource:
 *
 *   1. registerMcpApps mints a per-boot random token and bakes it into the
 *      resource HTML in place of the panel's `__AGENPROTO_EMBED_TOKEN__`
 *      placeholder — only a caller that legitimately read the resource
 *      (MCP-authenticated) ever holds it;
 *   2. the panel appends it to the iframe URL it mounts (`?et=…`) —
 *      `GET /apps/:appId/ui` (see panel-bridge.ts `withEmbedToken`);
 *   3. handleAppUiPage drops the anti-framing headers when `et` validates,
 *      and applyCors grants the PNA preflight the same way;
 *   4. every browser-facing gate (`guardBrowserOrigin`, `authorizeMcp`,
 *      `checkSessionsToken` — see http-server.ts `embedTokenTrusted`) treats
 *      a valid `et` like an allowlisted `Origin`. That is what lets the
 *      widget's blob-frame path work: hosts whose widget CSP is `frame-src
 *      'self' blob: data:` (Claude Desktop, Codex) refuse a direct daemon
 *      iframe, so the panel fetches the chat html and re-mounts it as a
 *      `blob:` document — an opaque origin whose every daemon request
 *      (`/mcp`, `/sessions/*`, `tool-call`) carries `Origin: null` plus the
 *      token. The holder is by construction an MCP-authenticated host that
 *      already has `tools/call`, so no privilege is added — but a token
 *      leaked out of a widget IS an `/mcp` credential until the next daemon
 *      restart, which is why it never rides on the user-facing
 *      "open in a tab" link.
 *
 * A hostile web page can never obtain the token: it has no MCP access to
 * read the resource, and cannot read it out of the host's cross-origin
 * widget iframe. Tokens die with the daemon process, so one copied out of a
 * shared deep link expires on restart. The registry is module-level
 * (never persisted) and deliberately NOT scoped per app id: tokens are only
 * ever held by MCP-Apps hosts rendering this daemon's own panels, so any
 * registered token proves the same fact.
 */
import { randomBytes } from "node:crypto"

/** token -> minting app id. Per daemon boot, never persisted. */
const embedTokens = new Map<string, string>()

export function mintAppEmbedToken(appId: string): string {
  const token = randomBytes(24).toString("base64url")
  embedTokens.set(token, appId)
  return token
}

/** appId -> its boot-stable refresh token (see below). */
const stableTokens = new Map<string, string>()

/**
 * The boot-stable embed token for `appId`, minted on first call.
 *
 * Baking a token into the resource HTML (above) covers the render, but a
 * host that CACHES the rendered resource — Claude Desktop keeps a widget's
 * srcdoc per conversation — keeps replaying a token that died with the
 * daemon boot that minted it. Every daemon restart therefore turns those
 * widgets into a permanent 403 (`guardBrowserOrigin`: `Origin: null` + an
 * unknown `et`), visible to the user only as the launcher-card fallback
 * after the blob fetch and the direct frame both fail.
 *
 * The panel re-resolves its deep link over the bridge on every boot, so the
 * fix is to hand a LIVE token back with each tool result and let the panel
 * adopt it (see apps/src/session-chat/panel.ts `adoptEmbedToken`). That path
 * runs once per tool call, so it memoizes one token per app instead of
 * minting per call — an unbounded `embedTokens` would otherwise grow for the
 * daemon's lifetime. Reusing one token adds no exposure: `isValidAppEmbedToken`
 * is deliberately not app-scoped, so every live token already proves exactly
 * the same fact, and a baked one lives just as long.
 */
export function stableAppEmbedToken(appId: string): string {
  const existing = stableTokens.get(appId)
  if (existing) return existing
  const token = mintAppEmbedToken(appId)
  stableTokens.set(appId, token)
  return token
}

/** True when `token` was minted this boot by registerMcpApps. */
export function isValidAppEmbedToken(
  token: string | null | undefined,
): boolean {
  return typeof token === "string" && token.length > 0 && embedTokens.has(token)
}
