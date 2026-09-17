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
 *      and applyCors grants the PNA preflight the same way.
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

/** True when `token` was minted this boot by registerMcpApps. */
export function isValidAppEmbedToken(
  token: string | null | undefined,
): boolean {
  return typeof token === "string" && token.length > 0 && embedTokens.has(token)
}
