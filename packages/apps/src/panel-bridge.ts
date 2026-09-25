/**
 * Shared MCP Apps client bridge for agentproto panels.
 *
 * One spec-correct copy of the JSON-RPC-over-postMessage bridge that every
 * ui:// panel embeds in its <script> block. Mirrors the behaviour of
 * @agstudio/mcp-apps' mcpAppClientScript() — which we cannot import here:
 * agentproto is a standalone pnpm workspace with no @agstudio/* dependency
 * (same isolation invariant as mcp-apps-adapter.ts).
 *
 * Handshake (MCP Apps ext spec 2026-01-26, ext-apps McpUiInitializeRequest):
 *   params REQUIRE `appInfo` (Implementation: {name, version}),
 *   `appCapabilities`, and `protocolVersion`. Sending `clientInfo` instead
 *   of `appInfo` fails the host's schema validation — hosts either reply
 *   with an error or silently drop the request, so the panel's initBridge()
 *   promise never resolves and the panel renders blank while every
 *   server-side surface (tools, resources) works. That exact bug shipped in
 *   4 copy-pasted bridges; this module is the single corrected source.
 *
 * The script defines, in panel scope:
 *   post / rpcRequest / rpcNotify      — raw JSON-RPC plumbing
 *   onHostNotification(cb)             — subscribe to host-pushed
 *                                        notifications (method, params)
 *   initBridge()                       — ui/initialize → ui/notifications/initialized
 *   callTool(name, args)               — tools/call + JSON text unwrap
 *   getHostContext() / onHostContext(cb) — host context (displayMode, theme, …),
 *                                        captured from the initialize result and
 *                                        merged on ui/notifications/host-context-changed
 *   requestDisplayMode(mode)           — ui/request-display-mode (inline|fullscreen|pip)
 *
 * Display-mode toggle: the bridge also mounts two floating buttons
 * (fullscreen + pip) in the top-right corner of every panel, shown only for
 * the modes the host actually advertises via hostContext.availableDisplayModes.
 * No auto-request: panels stay inline until the user clicks. The buttons
 * themselves are NOT implemented here — `@agentproto/app-client/display-mode`
 * is the one implementation, shared with the `window.McpApp` bridge injected
 * into installed apps (`packages/runtime/src/app-ui-apps.ts`); this module
 * only hands it `getHostContext`/`onHostContext`/`requestDisplayMode`. It
 * also leaves `window.AgentprotoUI.installDisplayMode` defined in the panel,
 * which is what a panel with its own header calls to place the toggle
 * inline instead (see that module's `mountToggle`).
 *
 * Standalone HTTP mode: `GET /apps/:appId/ui` (packages/runtime
 * http-server.ts) serves this exact script with NO postMessage host on the
 * other end of `window.parent` — it's a plain browser tab (or a VS Code
 * *HTTP-iframe* panel), so `window.parent === window` and nothing ever
 * answers `initBridge()`'s `ui/initialize` request, leaving every panel
 * stuck on "Connecting to bridge…" forever. `injectStandaloneAppBridge`
 * (app-ui-apps.ts) papers over exactly this for installed apps by injecting
 * `window.McpApp.connect() -> Promise<{callTool, ...}>`, a REST-backed
 * stand-in whose `callTool` POSTs to the sibling `./tool-call` route — but
 * this bridge never consumed `window.McpApp`, so builtin panels (the only
 * consumers of this module) were left hanging regardless.
 *
 * Fixed here by detecting that same standalone shape and short-circuiting
 * both `initBridge()` (resolves locally, no round trip) and `callTool()`
 * (routes through `window.McpApp.connect()` instead of `tools/call` over
 * postMessage). The detection requires BOTH `window.parent === window` (no
 * host to talk to — this is the actual condition standalone mode means) AND
 * `window.McpApp` being present with a `connect` function (the capability
 * this bridge needs from it): `window.McpApp` presence alone was considered
 * and rejected as the sole signal, even though it happens to also hold today
 * — the VS Code webview's `srcdoc` relay (packages/vscode
 * appPanel.ts/appPanelController.ts) answers this bridge's raw postMessage
 * JSON-RPC directly and never defines `window.McpApp` for a builtin panel
 * (only `createUiHtmlCache`'s `injectMcpAppBridge`, used for INSTALLED
 * apps' `ui.path` html, defines it) — but that's an accident of today's
 * wiring, not a guarantee; `window.parent === window` is the direct,
 * load-bearing signal ("is there anyone to postMessage?") and doesn't
 * depend on which injector happened to run. There is no host in standalone
 * mode, so `initBridge()` seeds a default `hostContext` of `{displayMode:
 * 'inline', availableDisplayModes: []}` — an empty `availableDisplayModes`
 * is what keeps the display-mode toggle buttons hidden (they only show for
 * modes `hostContext.availableDisplayModes` lists), rather than rendering
 * two buttons with nothing to switch to.
 *
 * The real postMessage-host path (a compliant MCP-Apps host, or the VS Code
 * srcdoc relay) is untouched byte-for-byte: same `rpcRequest`/`rpcNotify`
 * over `window.parent.postMessage`, same handshake, same display-mode
 * plumbing.
 *
 * Asymmetry not fixed here (flagged, not papered over): `window.McpApp`'s
 * `sendMessage`/`updateModelContext` (STANDALONE_REST_BRIDGE_SCRIPT,
 * app-ui-apps.ts) reject with "no host (standalone mode)", while
 * `appPanelController.ts`'s `ui/message`/`ui/update-model-context` handlers
 * accept-and-drop (`return {}`). This bridge doesn't currently expose either
 * call, so the difference is latent, but it's the last behavioural delta
 * between the two panel paths and worth a follow-up if this bridge ever
 * grows those methods.
 */

import { DISPLAY_MODE_SCRIPT_BODY } from "@agentproto/app-client/display-mode"

export function panelBridgeScript(appName: string): string {
  return `// ── MCP Apps bridge (shared: panel-bridge.ts) ──
// JSON-RPC 2.0 over window.parent.postMessage · spec 2026-01-26
var _nextId = 1, _pending = {}, _notifyHandlers = [];
var _hostContext = null, _hostContextHandlers = [];
var _hostCaps = null;
var _standaloneApp = null;
function _isStandalone(){
  return window.parent === window && !!window.McpApp && typeof window.McpApp.connect === 'function';
}
// ── Per-boot embed token (runtime embed-tokens.ts) ────────────────────────
// Panels that iframe the daemon's standalone app host carry this proof so
// GET /apps/:appId/ui?embed=1&et=... can drop its anti-framing headers for
// MCP-Apps hosts whose widget context is an opaque origin (Claude Desktop).
// registerMcpApps replaces the placeholder with a real per-boot token when
// serving the panel as a resource; every other render (tests, standalone
// tab, VS Code HTTP-iframe panel — the latter two already pass
// iframeEmbedAllowed's origin checks) keeps the literal, and
// withEmbedToken() then degrades to an identity function.
window.__AGENPROTO_EMBED_TOKEN__ = "__AGENPROTO_EMBED_TOKEN__";
function withEmbedToken(url){
  var t = window.__AGENPROTO_EMBED_TOKEN__;
  if (!t || t === '__AGENPROTO_EMBED_TOKEN__') return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'et=' + encodeURIComponent(t);
}
function post(msg){ window.parent.postMessage(msg, '*'); }
function getHostContext(){ return _hostContext; }
function getHostCapabilities(){ return _hostCaps; }
function onHostContext(cb){
  _hostContextHandlers.push(cb);
  // Replay the last context so a late subscriber isn't stuck blind.
  if (_hostContext){ try { cb(_hostContext); } catch(_) {} }
}
function _setHostContext(ctx){
  if (!ctx || typeof ctx !== 'object') return;
  // ui/notifications/host-context-changed carries only the changed keys —
  // merge, matching the official ext-apps App behaviour.
  _hostContext = Object.assign({}, _hostContext || {}, ctx);
  for (var i = 0; i < _hostContextHandlers.length; i++){
    try { _hostContextHandlers[i](_hostContext); } catch(_) {}
  }
}
function rpcRequest(method, params){
  return new Promise(function(resolve, reject){
    var id = _nextId++;
    _pending[id] = {resolve: resolve, reject: reject};
    post({jsonrpc: '2.0', id: id, method: method, params: params || {}});
  });
}
function rpcNotify(method, params){ post({jsonrpc: '2.0', method: method, params: params || {}}); }
function onHostNotification(cb){ _notifyHandlers.push(cb); }
window.addEventListener('message', function(evt){
  var msg = evt.data;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
  if (msg.id != null && msg.method == null){
    var p = _pending[msg.id];
    if (!p) return;
    delete _pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error.message || ('rpc error ' + msg.error.code)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method){
    if (msg.method === 'ui/notifications/host-context-changed'){
      _setHostContext(msg.params || {});
    }
    for (var i = 0; i < _notifyHandlers.length; i++){
      try { _notifyHandlers[i](msg.method, msg.params || {}); } catch(_) {}
    }
  }
});
function initBridge(){
  if (_isStandalone()){
    return window.McpApp.connect().then(function(conn){
      _standaloneApp = conn;
      // No host to advertise a hostContext — default to inline with no
      // other modes available, which keeps the display-mode toggle buttons
      // hidden (they only show for modes hostContext.availableDisplayModes
      // lists) instead of rendering two buttons with nothing to switch to.
      _setHostContext({displayMode: 'inline', availableDisplayModes: []});
    });
  }
  return rpcRequest('ui/initialize', {
    appInfo: {name: ${JSON.stringify(appName)}, version: '0.1.0'},
    appCapabilities: {availableDisplayModes: ['inline', 'fullscreen', 'pip']},
    protocolVersion: '2026-01-26'
  }).then(function(result){
    // The initialize result carries the initial hostContext (displayMode +
    // availableDisplayModes) — capture it before notifying the host.
    if (result && result.hostContext) _setHostContext(result.hostContext);
    // McpUiInitializeResult.hostCapabilities (ext-apps spec) — e.g. openLinks,
    // "Host supports opening external URLs". Captured once, read via
    // getHostCapabilities() by panels that need to branch on it.
    if (result && result.hostCapabilities) _hostCaps = result.hostCapabilities;
    rpcNotify('ui/notifications/initialized', {});
  });
}
function requestDisplayMode(mode){
  return rpcRequest('ui/request-display-mode', {mode: mode});
}
function openLink(url){
  if (_standaloneApp && typeof _standaloneApp.openLink === 'function') return _standaloneApp.openLink(url);
  return rpcRequest('ui/open-link', {url: url});
}
function callTool(name, args){
  var raw = _standaloneApp
    ? _standaloneApp.callTool(name, args || {})
    : rpcRequest('tools/call', {name: name, arguments: args || {}});
  return raw.then(function(result){
    if (result.isError){
      var e = (result.content && result.content[0] && result.content[0].text) || 'tool error';
      throw new Error(e);
    }
    var text = (result.content && result.content[0] && result.content[0].text) || '{}';
    return JSON.parse(text);
  });
}

// ── Display-mode toggle (shared: @agentproto/app-client/display-mode) ──
// The installer is inlined verbatim (it is self-contained and idempotent),
// then handed this panel's own JSON-RPC plumbing. NO auto-request: the
// panel stays inline until the user clicks, and the buttons only appear for
// the modes the host advertises in hostContext.availableDisplayModes.
${DISPLAY_MODE_SCRIPT_BODY}
var displayMode = window.AgentprotoUI.installDisplayMode({
  getHostContext: getHostContext,
  onHostContext: onHostContext,
  requestDisplayMode: requestDisplayMode
});`
}
