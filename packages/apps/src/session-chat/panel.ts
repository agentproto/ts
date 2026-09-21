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
 * Mount order (see `mount()` below):
 *   1. Blob pass-through, when a per-boot embed token is baked in (i.e. an
 *      MCP-Apps host rendered this resource): fetch the chat html with the
 *      token, rewrite it (./blob-embed.ts `transformChatHtmlForBlob`) and
 *      mount it as a `blob:` document. Claude Desktop / Codex widget frames
 *      run `frame-src 'self' blob: data:` and do not merge our declared
 *      `csp.frameDomains`, so a direct daemon iframe is refused host-side —
 *      `blob:` is the pass-through. The blob document must post a boot ack
 *      within a settle window (`armBlobBootProbe`); a missing ack (host CSP
 *      killed its inline scripts, or refused the blob frame) tears it down
 *      and falls through to 2.
 *   2. Direct-src iframe of the deep link (VS Code HTTP-iframe panels, a
 *      standalone tab — no token, and their origin already passes the
 *      daemon's checks; or the blob path's fallback). If the host refuses
 *      the frame, `armBlockProbe` removes it and the launcher card becomes
 *      the interactive surface.
 *
 * A persistent header with the deep link stays visible above the iframe, so
 * if the frame is refused (older daemon without the embed relaxation, or a
 * host whose own CSP blocks daemon frames) the user still has a one-click
 * path to the chat in a tab. When the app is NOT installed the page is a
 * small readable notice pointing at `agentproto app install` — the
 * fallback branch, never a vendored UI.
 */

import { panelBridgeScript } from "../panel-bridge.js"
import { BLOB_BOOT_MESSAGE_TYPE, blobEmbedScript } from "./blob-embed.js"
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
#mode{color:#6e7681}
#stage{position:relative;height:calc(100% - 29px)}
#chat{position:absolute;inset:0;z-index:2;border:0;display:block;width:100%;height:100%}
#card{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:24px}
#card h2{font-size:15px;font-weight:600}
#card .sid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#8b949e;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:2px 8px}
#card p{font-size:12px;color:#8b949e;max-width:420px;line-height:1.5}
#card a{display:inline-block;margin-top:2px;border:1px solid #30363d;background:#161b22;color:#58a6ff;font-size:13px;padding:7px 14px;border-radius:6px;text-decoration:none}
#card a:hover{border-color:#58a6ff}
#notice{display:none;max-width:560px;margin:0 auto;padding:48px 24px;line-height:1.6}
#notice.show{display:block}
#notice h1{font-size:18px;margin-bottom:12px}
#notice code{background:#161b22;border:1px solid #30363d;border-radius:4px;padding:2px 6px;font-size:13px}
#notice p{margin:8px 0;color:#8b949e;font-size:13px}
</style>
</head>
<body>
<div id="bar">Session Chat &#183; <span id="link">${link}</span><span id="mode"></span></div>
<div id="stage">${iframe}<div id="card">
  <h2>Session Chat</h2>
  <div id="card-session" class="sid">&#8212;</div>
  <p>Full embed isn't supported by this host &#8212; the chat opens in a browser tab.</p>
  <a id="card-open" href="#" target="_blank" rel="noreferrer">Open chat</a>
</div><div id="notice"${notInstalled ? ' class="show"' : ""}>
  <h1>Session Chat is not installed</h1>
  <p>This panel is a thin launcher for the <code>@agentik/session-chat</code> app &#8212;
  it does not bundle the chat UI itself.</p>
  <p>To use it, install the app into this daemon:</p>
  <p><code>agentproto app install @agentik/session-chat</code></p>
</div></div>
<script>
window.__APP_INIT__ = ${JSON.stringify(initData)};

${panelBridgeScript("agentproto-session-chat")}

${blobEmbedScript()}

// ── Session-chat launcher logic ──────────────────────────────────────────
var mountedUrl = (window.__APP_INIT__ && window.__APP_INIT__.url) || null;
var pinnedSessionId = null;   // session named by the host's tool-result push
var pendingUrl = null;        // url pushed by the host before the bridge was up
var pendingNotInstalled = false;
var bridged = false;
var cardUrl = null;           // deep link once resolved (drives the card button)
var cardSessionEl = document.getElementById('card-session');
var cardOpenEl = document.getElementById('card-open');
var mountGen = 0;             // bumps per mount(); async work checks it before touching the DOM
var blobUrl = null;           // live object url of the blob-mounted chat, if any
var blobBootTimer = null;
var blobBootOk = false;

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function setMode(text) {
  document.getElementById('mode').textContent = text ? ' \\u00b7 ' + text : '';
  // The chat app is live inside the frame — the launcher bar (title, deep
  // link, mount mode) is noise on top of the real surface. Hide it and let
  // the frame own the full height. Only a failed mount (launcher card /
  // not-installed notice) shows the bar again.
  var bar = document.getElementById('bar');
  var stage = document.getElementById('stage');
  if (bar && stage) {
    bar.style.display = text ? 'none' : '';
    stage.style.height = text ? '100%' : 'calc(100% - 29px)';
  }
}

// One fresh #chat frame on the stage (over the card), the previous one gone.
function newFrame() {
  var stage = document.getElementById('stage');
  var old = document.getElementById('chat');
  if (old) old.remove();
  var frame = document.createElement('iframe');
  frame.id = 'chat';
  frame.title = 'Session Chat';
  stage.insertBefore(frame, stage.firstChild);
  return frame;
}

function revokeBlob() {
  if (blobBootTimer) { clearTimeout(blobBootTimer); blobBootTimer = null; }
  if (blobUrl) {
    try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    blobUrl = null;
  }
}

function mount(url) {
  if (!url || url === mountedUrl) return;
  mountedUrl = url;
  var gen = ++mountGen;
  revokeBlob();
  document.getElementById('notice').className = '';
  setCardUrl(url);
  document.getElementById('link').innerHTML =
    '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">open in a tab</a>';
  var tokened = withEmbedToken(url);
  if (tokened === url) {
    // No per-boot token baked in (standalone tab, VS Code HTTP-iframe panel):
    // the direct frame already passes the daemon's origin checks, and the
    // blob path's daemon calls would have nothing to carry — skip it.
    mountDirect(url);
    return;
  }
  mountBlob(url, tokened, gen).catch(function (err) {
    if (gen !== mountGen) return;
    // The fetch itself was refused (host connect-src not merging our
    // connectDomains, PNA, daemon down, …) — probe answered: no blob path.
    console.warn('[session-chat] blob mount failed, falling back to a direct frame:',
      err && err.message ? err.message : String(err));
    mountDirect(url);
  });
}

// Direct-src iframe of the deep link, with the block probe → launcher card
// fallback. The terminal mount path when the blob one is unavailable.
function mountDirect(url) {
  var frame = newFrame();
  frame.src = withEmbedToken(url);
  setMode('direct frame');
  armBlockProbe(frame);
}

// Blob pass-through: fetch the chat html through the embed token, rewrite it
// for life as a blob: document (transformChatHtmlForBlob, blob-embed.ts) and
// mount it — blob: passes a host frame-src that refuses the daemon origin.
function mountBlob(url, tokened, gen) {
  return fetch(tokened, { credentials: 'omit' }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }).then(function (html) {
    if (gen !== mountGen) return;
    var doc = transformChatHtmlForBlob(html, url, window.__AGENPROTO_EMBED_TOKEN__);
    blobUrl = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
    var frame = newFrame();
    armBlobBootProbe(frame, url, gen);
    frame.src = blobUrl;
    setMode('embedded');
  });
}

// The blob document's shim posts a boot ack as its first statement. No ack
// within the settle window means the host refused the blob frame or its
// inherited CSP killed the document's inline scripts — surface that through
// the direct-frame path (whose own probe ends on the launcher card) rather
// than leaving a silent blank.
window.addEventListener('message', function (evt) {
  var d = evt.data;
  if (!d || typeof d !== 'object' || d.type !== ${JSON.stringify(BLOB_BOOT_MESSAGE_TYPE)}) return;
  var frame = document.getElementById('chat');
  if (!frame || evt.source !== frame.contentWindow) return;
  blobBootOk = true;
  if (blobBootTimer) { clearTimeout(blobBootTimer); blobBootTimer = null; }
});

function armBlobBootProbe(frame, url, gen) {
  blobBootOk = false;
  blobBootTimer = setTimeout(function () {
    blobBootTimer = null;
    if (gen !== mountGen || blobBootOk) return;
    console.warn('[session-chat] blob document never booted (host CSP?), falling back to a direct frame');
    revokeBlob();
    frame.remove();
    mountDirect(url);
  }, 5000);
}

function showNotInstalled() {
  var old = document.getElementById('chat');
  if (old) old.remove();
  revokeBlob();
  setMode('');
  mountedUrl = null;
  document.getElementById('card').style.display = 'none';
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

// ── Embed-token refresh ──────────────────────────────────────────────────
// The token baked into this page by registerMcpApps dies with the daemon
// boot that minted it (runtime embed-tokens.ts), but hosts cache the
// rendered widget: Claude Desktop keeps a conversation's srcdoc, so after
// any daemon restart the cached page replays a dead token and every daemon
// call 403s — the blob fetch fails, the direct frame is refused, and the
// user is left on the launcher card forever. Every tool result carries a
// live token (SessionChatOutput.embedToken), so adopt it before mounting.
//
// Only a render that WAS baked refreshes. A standalone tab or VS Code
// HTTP-iframe panel still holds the literal placeholder and passes the
// daemon's origin checks on its own; handing it a token would switch it
// onto the blob path for no reason.
function adoptEmbedToken(body) {
  var cur = window.__AGENPROTO_EMBED_TOKEN__;
  if (!cur || cur === '__AGENPROTO_EMBED_TOKEN__') return;
  if (!body || typeof body.embedToken !== 'string' || !body.embedToken) return;
  window.__AGENPROTO_EMBED_TOKEN__ = body.embedToken;
}

// Turn a session id into the installed app's deep link over the bridge.
function resolveSession(sessionId) {
  noteSession(sessionId);
  return callTool('agentproto_session_chat', sessionId ? { sessionId: sessionId } : {})
    .then(function(out) {
      adoptEmbedToken(out);
      if (out && out.installed && typeof out.url === 'string' && out.url) mount(out.url);
      else showNotInstalled();
    })
    .catch(function(err) {
      document.getElementById('link').textContent = 'bridge error: ' + (err && err.message ? err.message : String(err));
    });
}

// ── Launcher card (the frame-blocked fallback UI) ────────────────────────
// The iframe mounts OVER the card. When the host's own CSP refuses the
// frame (Claude Desktop / Codex widget frames run frame-src 'self' blob:
// data: and do not yet merge csp.frameDomains), the frame stays on a
// same-origin about:blank — readable, unlike the loaded cross-origin chat —
// and is removed after a settle window so the card becomes the interactive
// surface.
//
// The anchor carries target="_blank" rel="noreferrer" as the fallback path,
// but that is a plain no-op in hosts that sandbox the widget iframe without
// allow-popups (observed in Claude Desktop's side chat) — a normal click
// on such a host does nothing. Where the host advertises the capability
// (McpUiInitializeResult.hostCapabilities.openLinks in the ext-apps spec,
// captured by the bridge's getHostCapabilities()), route through the
// host-mediated ui/open-link request instead, which is not subject to the
// iframe's popup sandboxing.
cardOpenEl.addEventListener('click', function (evt) {
  if (!cardUrl) { evt.preventDefault(); return; }
  if (getHostCapabilities() && getHostCapabilities().openLinks) {
    evt.preventDefault();
    openLink(cardUrl).catch(function () { window.open(cardUrl, '_blank'); });
  }
});

function noteSession(id) {
  if (id && cardSessionEl) cardSessionEl.textContent = id;
}

function setCardUrl(u) {
  if (!u) return;
  cardUrl = u;
  cardOpenEl.setAttribute('href', u);
}

// A blocked frame never leaves about:blank (same-origin with this page —
// readable); the loaded chat is cross-origin (the probe throws). A readable
// frame that is STILL blank when the settle window closes = blocked.
function isBlank(frame) {
  try { return frame.contentWindow.location.href === 'about:blank'; } catch (_) { return false; }
}

function armBlockProbe(frame) {
  var settle = null;
  function probe() {
    if (settle) { clearTimeout(settle); settle = null; }
    if (!isBlank(frame)) return;
    // Still on about:blank right now — arm the settle window, but
    // re-check when it closes: a slow (not blocked) load may have landed
    // in the meantime, and only a frame STILL blank after the window gets
    // removed. load firing in between clears this timeout above.
    settle = setTimeout(function () {
      settle = null;
      if (isBlank(frame)) frame.remove();
    }, 2000);
  }
  setTimeout(function () {
    frame.addEventListener('load', probe);
    probe();
  }, 100);
}

// A url baked at render time (a host that re-renders per call with a real
// initData) mounts on boot — through the same blob-first path as every
// other mount, since the same opaque widget context frames it. The
// pre-rendered #chat frame is replaced by mount()'s own.
if (mountedUrl) {
  var bootUrl = mountedUrl;
  mountedUrl = null;
  adoptEmbedToken(window.__APP_INIT__);
  mount(bootUrl);
}

// The host pushes the triggering tool call's result (ext-apps
// ui/notifications/tool-result). For agent_start that result IS the spawned
// session's descriptor — pin the widget to THAT session.
onHostNotification(function(method, params) {
  if (method !== 'ui/notifications/tool-result') return;
  var body = parseToolResultBody(params);
  if (!body) return;
  if (typeof body.url === 'string' && body.url && body.installed !== false) {
    // Adopt now, not at mount time: the token doesn't depend on the bridge.
    adoptEmbedToken(body);
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
  noteSession(id);
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
