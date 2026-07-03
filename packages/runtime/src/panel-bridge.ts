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
 */

export function panelBridgeScript(appName: string): string {
  return `// ── MCP Apps bridge (shared: panel-bridge.ts) ──
// JSON-RPC 2.0 over window.parent.postMessage · spec 2026-01-26
var _nextId = 1, _pending = {}, _notifyHandlers = [];
function post(msg){ window.parent.postMessage(msg, '*'); }
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
    for (var i = 0; i < _notifyHandlers.length; i++){
      try { _notifyHandlers[i](msg.method, msg.params || {}); } catch(_) {}
    }
  }
});
function initBridge(){
  return rpcRequest('ui/initialize', {
    appInfo: {name: ${JSON.stringify(appName)}, version: '0.1.0'},
    appCapabilities: {availableDisplayModes: ['inline', 'fullscreen']},
    protocolVersion: '2026-01-26'
  }).then(function(){ rpcNotify('ui/notifications/initialized', {}); });
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
}`
}
