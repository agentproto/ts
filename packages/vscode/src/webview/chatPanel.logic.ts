/**
 * Pure helpers for the session-chat webview panel — no vscode import so
 * they're unit-testable under plain vitest.
 */

import { chatPanelUrl } from "../commands/sessionView.logic.js"

export { chatPanelUrl }

/**
 * The daemon origin a webview CSP must allow as `frame-src` for the chat
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
 * The outer webview document: a full-viewport iframe of the session-chat
 * standalone url. CSP is deliberately tight — `default-src 'none'` and a
 * `frame-src` of exactly the daemon origin (never hardcoded) — and there is
 * no script: session-chat talks REST/SSE to the daemon itself, no McpApp
 * bridge involved.
 */
export function buildChatPanelHtml(url: string, frameOrigin: string | null): string {
  // No script in the outer document, but 'unsafe-inline' on style keeps the
  // inline <style> legal under the meta CSP.
  const frameSrc = frameOrigin ?? "*"
  const csp = [`default-src 'none'`, `frame-src ${frameSrc}`, `style-src 'unsafe-inline'`].join("; ")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Session Chat</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
    #chat { border: 0; display: block; width: 100%; height: 100vh; }
  </style>
</head>
<body>
  <iframe id="chat" title="Session Chat" src="${escapeAttr(url)}"></iframe>
</body>
</html>`
}

/** Only `&` and `"` are significant inside a double-quoted attribute value. */
function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}
