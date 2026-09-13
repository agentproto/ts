/**
 * Pure helpers for the "path 2" HTTP-iframe webview panel — no vscode import
 * so they're unit-testable under plain vitest.
 *
 * {@link buildIframePanelHtml} is the generic builder shared by every path-2
 * panel: session-chat's own panel (chatPanel.ts, via the {@link
 * buildChatPanelHtml} thin wrapper below) and the generic per-installed-app
 * panel (appIframePanel.ts), which passes the app's own label as the title.
 * Session-chat was the first, and only, consumer of this shape, so the
 * generic builder still lives next to session-chat's thin wrapper rather
 * than forking into a new file. The `agentproto.appPanelMode` setting and
 * the path-1-vs-path-2 routing decision ARE app-specific, though, and live
 * in commands/apps.logic.ts (`resolveAppPanelRoute`) instead.
 */

import { chatPanelUrl } from "../commands/sessionView.logic.js"

export { chatPanelUrl }

/**
 * The daemon origin a webview CSP must allow as `frame-src` for the panel's
 * iframe. Never hardcode an origin — derive it from the configured daemon
 * url. Returns `null` when the url doesn't parse (caller falls back to
 * `frame-src *`, degraded but functional).
 */
export function daemonOrigin(daemonUrl: string): string | null {
  try {
    return new URL(daemonUrl).origin
  } catch {
    return null
  }
}

/**
 * The outer webview document for a path-2 panel: a full-viewport iframe of
 * an HTTP url the daemon serves directly. CSP is deliberately tight —
 * `default-src 'none'` and a `frame-src` of exactly the daemon origin (never
 * hardcoded) — and there is no script: the embedded app talks REST/SSE to
 * the daemon itself, no McpApp bridge involved (that's path 1, appPanel.ts).
 */
export function buildIframePanelHtml(url: string, frameOrigin: string | null, title: string): string {
  // No script in the outer document, but 'unsafe-inline' on style keeps the
  // inline <style> legal under the meta CSP.
  const frameSrc = frameOrigin ?? "*"
  const csp = [`default-src 'none'`, `frame-src ${frameSrc}`, `style-src 'unsafe-inline'`].join("; ")
  const safeTitle = escapeHtml(title)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${safeTitle}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
    #app { border: 0; display: block; width: 100%; height: 100vh; }
  </style>
</head>
<body>
  <iframe id="app" title="${safeTitle}" src="${escapeAttr(url)}"></iframe>
</body>
</html>`
}

/** Thin wrapper kept for session-chat's own call site (chatPanel.ts), fixing
 *  the title generic app panels otherwise pass in. */
export function buildChatPanelHtml(url: string, frameOrigin: string | null): string {
  return buildIframePanelHtml(url, frameOrigin, "Session Chat")
}

/** Only `&` and `"` are significant inside a double-quoted attribute value. */
function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

/** Title goes into both a `<title>` text node and a `title="…"` attribute,
 *  so escape the full set (`&<>"`), not just the attribute-significant two. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
