/**
 * HTML bundles for the session-chat builtin widget — the thin bridge page
 * (`sessionChatEmbedHtml`) and the not-installed notice
 * (`SESSION_CHAT_FALLBACK_HTML`) served as the
 * `ui://agentproto_session_chat/view` resource by `registerMcpApps` (see
 * ../mcp-app-types.ts and runtime's mcp-apps-adapter.ts). Mounted via the
 * `agentproto_session_chat` tool defined in ./index.ts, AND bound to
 * `agent_start` (runtime agent-tools.ts `_meta.ui.resourceUri`) so a launch
 * card opens the chat of the session it just spawned.
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
 * Self-bootstrapping (same pattern as live-session/panel.ts): the static
 * ui:// resource is rendered ONCE at server-registration time with EMPTY
 * initData (mcp-apps-adapter.ts registerMcpApps), so the deep link can't
 * be baked in. The page resolves it at runtime, in priority order:
 *   1. `initData.url` when the html was rendered with a real tool output
 *      (tests, and any host that re-renders per call) — iframe is inline.
 *   2. The host's `ui/notifications/tool-result` push of the tool call that
 *      mounted the widget. An `agent_start` result IS the spawned session's
 *      descriptor (`{ id: "sess_…", … }`) → the widget calls
 *      `agentproto_session_chat({ sessionId })` over the bridge to turn that
 *      id into the deep link; an `agentproto_session_chat` result already
 *      carries `{ installed, url }` and mounts directly.
 *   3. Otherwise (opened bare from the catalog) `agentproto_session_chat({})`
 *      → the app's session picker.
 * Both orders of (2) vs. bridge init are handled: a result that lands
 * before `initBridge()` resolves is held and applied once it does.
 *
 * A persistent header with the deep link stays visible above the iframe, so
 * if the frame is refused (older daemon without the embed relaxation, or a
 * host whose own CSP blocks daemon frames) the user still has a one-click
 * path to the chat in a tab. When the app is NOT installed the page is a
 * small readable notice pointing at `agentproto app install` — the
 * fallback branch, never a vendored UI.
 */

import { panelBridgeScript } from "../panel-bridge.js"
import type { SessionChatOutput } from "./index.js"

/** Only `&` and `"` are significant inside a double-quoted attribute value. */
function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

export function sessionChatEmbedHtml(initData: Partial<SessionChatOutput>): string {
  const url = typeof initData.url === "string" && initData.url ? initData.url : null
  const notInstalled = initData.installed === false
  const link =
    url != null
      ? `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">open in a tab</a>`
      : notInstalled
        ? "app not installed"
        : "connecting…"
  const iframe =
    url != null
      // No inline src: the url mounts through the bridge script below, via
      // withEmbedToken(), so the frame never loads without the per-boot
      // embed proof — whichever render path (static resource or a host
      // re-render with a real initData) produced it.
      ? `<iframe id="chat" title="Session Chat"></iframe>`
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
#stage{height:calc(100% - 29px)}
#chat{border:0;display:block;width:100%;height:100%}
#notice{display:none;max-width:560px;margin:0 auto;padding:48px 24px;line-height:1.6}
#notice.show{display:block}
#notice h1{font-size:18px;margin-bottom:12px}
#notice code{background:#161b22;border:1px solid #30363d;border-radius:4px;padding:2px 6px;font-size:13px}
#notice p{margin:8px 0;color:#8b949e;font-size:13px}
</style>
</head>
<body>
<div id="bar">Session Chat &#183; <span id="link">${link}</span></div>
<div id="stage">${iframe}<div id="notice"${notInstalled ? ' class="show"' : ""}>
  <h1>Session Chat is not installed</h1>
  <p>This panel is a thin launcher for the <code>@agentik/session-chat</code> app &#8212;
  it does not bundle the chat UI itself.</p>
  <p>To use it, install the app into this daemon:</p>
  <p><code>agentproto app install @agentik/session-chat</code></p>
</div></div>
<script>
window.__APP_INIT__ = ${JSON.stringify(initData)};

${panelBridgeScript("agentproto-session-chat")}

// ── Session-chat launcher logic ──────────────────────────────────────────
var mountedUrl = (window.__APP_INIT__ && window.__APP_INIT__.url) || null;
var pinnedSessionId = null;   // session named by the host's tool-result push
var pendingUrl = null;        // url pushed by the host before the bridge was up
var pendingNotInstalled = false;
var bridged = false;

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function mount(url) {
  if (!url || url === mountedUrl) return;
  mountedUrl = url;
  var stage = document.getElementById('stage');
  var old = document.getElementById('chat');
  if (old) old.remove();
  document.getElementById('notice').className = '';
  var frame = document.createElement('iframe');
  frame.id = 'chat';
  frame.title = 'Session Chat';
  frame.src = withEmbedToken(url);
  stage.insertBefore(frame, stage.firstChild);
  document.getElementById('link').innerHTML =
    '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">open in a tab</a>';
}

function showNotInstalled() {
  var old = document.getElementById('chat');
  if (old) old.remove();
  mountedUrl = null;
  document.getElementById('notice').className = 'show';
  document.getElementById('link').textContent = 'app not installed';
}

// The body of an ext-apps tool-result notification, whichever wrapping
// shape the host uses (params IS the CallToolResult, or nests it under
// params.result). null for error results / non-JSON text.
function parseToolResultBody(params) {
  if (!params || typeof params !== 'object') return null;
  var res = (params.result && typeof params.result === 'object') ? params.result : params;
  if (res.isError) return null;
  var content = Array.isArray(res.content) ? res.content : [];
  var item = content[0];
  if (!item || item.type !== 'text' || typeof item.text !== 'string') return null;
  try { return JSON.parse(item.text); } catch (_) { return null; }
}

// INLINED COPY of live-session/logic.ts extractToolResultSessionId — keep
// in sync. \`sessionId\` (an agentproto_session_chat / live_session result)
// wins over \`id\` (an agent_start result: the spawned session descriptor).
function extractToolResultSessionId(params) {
  var body = parseToolResultBody(params);
  if (!body) return null;
  if (typeof body.sessionId === 'string' && body.sessionId) return body.sessionId;
  if (typeof body.id === 'string' && body.id) return body.id;
  return null;
}

// Turn a session id into the installed app's deep link over the bridge.
function resolveSession(sessionId) {
  return callTool('agentproto_session_chat', sessionId ? { sessionId: sessionId } : {})
    .then(function(out) {
      if (out && out.installed && typeof out.url === 'string' && out.url) mount(out.url);
      else showNotInstalled();
    })
    .catch(function(err) {
      document.getElementById('link').textContent = 'bridge error: ' + (err && err.message ? err.message : String(err));
    });
}

// A url baked at render time (a host that re-renders per call with a real
// initData) mounts on boot — through the embed token like every other
// mount, since the same opaque widget context frames it.
if (mountedUrl) {
  var frame = document.getElementById('chat');
  if (frame) frame.src = withEmbedToken(mountedUrl);
}

// The host pushes the triggering tool call's result (ext-apps
// ui/notifications/tool-result). For agent_start that result IS the spawned
// session's descriptor — pin the widget to THAT session.
onHostNotification(function(method, params) {
  if (method !== 'ui/notifications/tool-result') return;
  var body = parseToolResultBody(params);
  if (!body) return;
  if (typeof body.url === 'string' && body.url && body.installed !== false) {
    if (bridged) mount(body.url); else pendingUrl = body.url;
    return;
  }
  if (body.installed === false) {
    if (bridged) showNotInstalled(); else pendingNotInstalled = true;
    return;
  }
  var id = extractToolResultSessionId(params);
  if (!id || id === pinnedSessionId) return;
  pinnedSessionId = id;
  if (bridged) resolveSession(id);
});

initBridge().then(function() {
  bridged = true;
  if (pendingUrl) { mount(pendingUrl); pendingUrl = null; return; }
  if (pendingNotInstalled) { showNotInstalled(); return; }
  if (mountedUrl) return;                       // rendered with a real url
  var init = window.__APP_INIT__ || {};
  if (init.installed === false) { showNotInstalled(); return; }
  // No url baked in (static ui:// render): resolve over the bridge — the
  // pinned session when the host named one, else the app's picker.
  return resolveSession(pinnedSessionId);
}).catch(function(err) {
  document.getElementById('link').textContent = 'bridge error: ' + (err && err.message ? err.message : String(err));
});
</script>
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
