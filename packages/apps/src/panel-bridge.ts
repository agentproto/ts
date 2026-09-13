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
 * Display-mode toggle: the bridge also injects two floating buttons
 * (fullscreen + pip) in the top-right corner of every panel, shown only for
 * the modes the host actually advertises via hostContext.availableDisplayModes
 * — same pattern as guilde's canvas.app.ts canvasShellHtml() (the reference
 * implementation that renders correctly in Claude hosts). No auto-request:
 * panels stay inline until the user clicks.
 */

export function panelBridgeScript(appName: string): string {
  return `// ── MCP Apps bridge (shared: panel-bridge.ts) ──
// JSON-RPC 2.0 over window.parent.postMessage · spec 2026-01-26
var _nextId = 1, _pending = {}, _notifyHandlers = [];
var _hostContext = null, _hostContextHandlers = [];
function post(msg){ window.parent.postMessage(msg, '*'); }
function getHostContext(){ return _hostContext; }
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
  return rpcRequest('ui/initialize', {
    appInfo: {name: ${JSON.stringify(appName)}, version: '0.1.0'},
    appCapabilities: {availableDisplayModes: ['inline', 'fullscreen', 'pip']},
    protocolVersion: '2026-01-26'
  }).then(function(result){
    // The initialize result carries the initial hostContext (displayMode +
    // availableDisplayModes) — capture it before notifying the host.
    if (result && result.hostContext) _setHostContext(result.hostContext);
    rpcNotify('ui/notifications/initialized', {});
  });
}
function requestDisplayMode(mode){
  return rpcRequest('ui/request-display-mode', {mode: mode});
}
function callTool(name, args){
  return rpcRequest('tools/call', {name: name, arguments: args || {}}).then(function(result){
    if (result.isError){
      var e = (result.content && result.content[0] && result.content[0].text) || 'tool error';
      throw new Error(e);
    }
    var text = (result.content && result.content[0] && result.content[0].text) || '{}';
    return JSON.parse(text);
  });
}

// ── Display-mode toggle buttons (NO auto-request) ──────────────────────
// Injected by the shared bridge so every panel gets them without touching
// its own markup. Mirrors guilde canvas.app.ts canvasShellHtml(): the
// panel stays inline by default; the user expands on demand. Buttons only
// appear for modes the host advertises in hostContext.availableDisplayModes.
(function(){
  function mount(){
    var style = document.createElement('style');
    style.textContent = '#dm,#pin{display:none;position:fixed;top:8px;z-index:10;'
      + 'border:1px solid #d0d0d0;background:#fff;color:#1a1a1a;'
      + 'font:600 13px/1 system-ui,sans-serif;padding:7px 12px;border-radius:6px;'
      + 'cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.18)}'
      + '#dm{right:8px}#pin{right:118px}'
      + '#dm:hover,#pin:hover{background:#f2f2f2;border-color:#b0b0b0}'
      + '@media (prefers-color-scheme:dark){'
      + '#dm,#pin{border-color:#555;background:#2a2a2a;color:#f0f0f0;box-shadow:0 1px 4px rgba(0,0,0,.5)}'
      + '#dm:hover,#pin:hover{background:#333;border-color:#777}}';
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.id = 'dm'; btn.type = 'button'; btn.title = "Basculer l'affichage";
    var pin = document.createElement('button');
    pin.id = 'pin'; pin.type = 'button'; pin.title = 'Épingler sur le côté (pip)';
    document.body.appendChild(pin);
    document.body.appendChild(btn);

    function has(avail, m){ return !!avail && avail.indexOf(m) >= 0; }

    // Re-sync button visibility + label from the current host context.
    function syncBtn(ctx){
      ctx = ctx || {};
      var avail = ctx.availableDisplayModes;
      // Diagnostic: what does THIS host actually advertise? (inline/fullscreen/pip)
      console.log('[mcp-app] displayMode=', ctx.displayMode,
                  'availableDisplayModes=', avail);

      // Fullscreen toggle button.
      if (has(avail, 'fullscreen')){
        btn.style.display = 'block';
        btn.textContent = (ctx.displayMode === 'fullscreen') ? '⤡ Réduire' : '⤢ Agrandir';
      } else { btn.style.display = 'none'; }

      // Dedicated pip ("pinned on side") button — only if the host advertises pip.
      if (has(avail, 'pip')){
        pin.style.display = 'block';
        pin.textContent = (ctx.displayMode === 'pip') ? '⤡ Détacher' : '📌 Épingler';
      } else { pin.style.display = 'none'; }
    }

    onHostContext(syncBtn);

    btn.addEventListener('click', function(){
      var ctx = getHostContext() || {};
      var inPanel = (ctx.displayMode === 'fullscreen' || ctx.displayMode === 'pip');
      requestDisplayMode(inPanel ? 'inline' : 'fullscreen').catch(function(){});
    });

    pin.addEventListener('click', function(){
      var ctx = getHostContext() || {};
      requestDisplayMode(ctx.displayMode === 'pip' ? 'inline' : 'pip').catch(function(){});
    });
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();`
}
