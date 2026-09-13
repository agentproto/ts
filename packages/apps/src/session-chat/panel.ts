/**
 * HTML bundles for the session-chat builtin widget — the thin bridge page
 * (`sessionChatEmbedHtml`) and the not-installed notice
 * (`SESSION_CHAT_FALLBACK_HTML`) served as the
 * `ui://agentproto_session_chat/view` resource by `registerMcpApps` (see
 * ../mcp-app-types.ts and runtime's mcp-apps-adapter.ts). Mounted via the
 * `agentproto_session_chat` tool defined in ./index.ts.
 *
 * Deliberately NOT a chat UI reimplementation: the real chat lives in the
 * installed `@agentik/session-chat` app, served by the daemon's standalone
 * app host at `GET /apps/@agentik/session-chat/ui`. When the app is
 * installed, this page is a full-viewport iframe of that URL deep-linked
 * with `?session=<id>&embed=1` — the exact spelling the daemon's standalone
 * route relaxes its `frame-ancestors 'none'` for (see runtime
 * http-server.ts handleAppUiPage) and the VS Code chat-panel webview
 * already uses. No second chat bundle exists anywhere in agentproto/ts.
 *
 * A persistent header with the deep link stays visible above the iframe, so
 * if the frame is refused (older daemon without the embed relaxation, or a
 * host whose own CSP blocks daemon frames) the user still has a one-click
 * path to the chat in a tab. When the app is NOT installed the page is a
 * small readable notice pointing at `agentproto app install` — the
 * fallback branch, never a vendored UI.
 */

import type { SessionChatOutput } from "./index.js"

/** Only `&` and `"` are significant inside a double-quoted attribute value. */
function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

export function sessionChatEmbedHtml(initData: SessionChatOutput): string {
  const url = initData.url
  const link =
    url != null
      ? `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">open in a tab</a>`
      : "app not installed"
  const iframe =
    url != null
      ? `<iframe id="chat" title="Session Chat" src="${escapeAttr(url)}"></iframe>`
      : ""
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Session Chat</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;overflow:hidden}
#bar{padding:6px 12px;font-size:12px;color:#8b949e;background:#161b22;border-bottom:1px solid #30363d}
#bar a{color:#58a6ff}
#chat{border:0;display:block;width:100%;height:calc(100% - 29px)}
</style>
</head>
<body>
<div id="bar">Session Chat &#183; ${link}</div>
${iframe}
</body>
</html>`
}

export const SESSION_CHAT_FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Session Chat — not installed</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3}
#wrap{max-width:560px;margin:0 auto;padding:48px 24px;line-height:1.6}
h1{font-size:18px;margin-bottom:12px}
code{background:#161b22;border:1px solid #30363d;border-radius:4px;padding:2px 6px;font-size:13px}
p{margin:8px 0;color:#8b949e;font-size:13px}
</style>
</head>
<body>
<div id="wrap">
  <h1>Session Chat is not installed</h1>
  <p>This panel is a thin launcher for the <code>@agentik/session-chat</code> app &#8212;
  it does not bundle the chat UI itself.</p>
  <p>To use it, install the app into this daemon:</p>
  <p><code>agentproto app install @agentik/session-chat</code></p>
  <p>Once installed, call <code>agentproto_session_chat</code> again (optionally with a
  <code>sessionId</code>) and the panel will embed the app's chat UI deep-linked to that
  session.</p>
</div>
</body>
</html>`
