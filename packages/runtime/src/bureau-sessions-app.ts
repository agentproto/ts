/**
 * McpApp definition for the agentproto "bureau — sessions navigateur" panel.
 *
 * Shows the browser sessions (kind === "browser"): adapter, base URL, port,
 * status and uptime. One row per live/recent browser service so you can see
 * what's bound where at a glance.
 *
 * Uses the same AgnoMcpApp contract as sessions-panel-app.ts (no
 * @agstudio/mcp-apps dependency — agentproto is a standalone workspace).
 * Wire via `registerMcpApps`.
 *
 * Protocol flow:
 *   1. Tool `agentproto_bureau_sessions` is called by the host.
 *   2. execute() returns the browser-session snapshot.
 *   3. The HTML panel opens a JSON-RPC bridge (postMessage) and polls
 *      `session_list {kind:'all'}` every ~5 s, filtering to kind==="browser".
 *
 * Data only — no server LLM. The whole bundle is inline (zero CDN).
 */

import { z } from "zod"
import type { SessionDescriptor } from "./sessions.js"
import type { AgnoMcpApp } from "./sessions-panel-app.js"

export const bureauSessionsInputSchema = z.object({
  filter: z
    .enum(["running", "all"])
    .optional()
    .describe("`running` = only alive browser sessions; `all` = running + recent (default)."),
})

export type BureauSessionsInput = z.infer<typeof bureauSessionsInputSchema>
export type BureauSessionsOutput = { sessions: SessionDescriptor[] }

export interface BureauSessionsOps {
  listSessions(filter?: "running" | "all"): SessionDescriptor[]
}

export function makeBureauSessionsApp(
  ops: BureauSessionsOps,
): AgnoMcpApp<BureauSessionsInput, BureauSessionsOutput> {
  return {
    id: "agentproto_bureau_sessions",
    title: "Bureau — sessions navigateur",
    description:
      "Open the browser-sessions panel — one row per browser service " +
      "(adapter, base URL, port, status, uptime). Polls live every ~5 s.",
    inputSchema: bureauSessionsInputSchema,
    execute: async input => ({
      sessions: ops.listSessions(input.filter).filter(s => s.kind === "browser"),
    }),
    html: BUREAU_SESSIONS_HTML,
  }
}

// ── HTML bundle (zero CDN, CSP-safe inline) ──────────────────────────────────

export const BUREAU_SESSIONS_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>bureau — sessions navigateur</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#e6edf3;--text2:#8b949e;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
}
*{box-sizing:border-box}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;background:var(--bg);color:var(--text);overflow:hidden}
#app{display:flex;flex-direction:column;height:100%}
#hdr{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--bg2);flex-shrink:0}
#hdr h1{font-size:13px;font-weight:600}
#hdr .sub{font-size:11px;color:var(--text2);margin-top:2px}
#refresh-btn{background:none;border:none;cursor:pointer;color:var(--text2);font-size:16px;line-height:1;padding:4px 6px;border-radius:6px}
#refresh-btn:hover{color:var(--text);background:var(--bg3)}
#list{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.row{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:11px 14px;display:flex;align-items:center;gap:14px}
.icon{font-size:20px;flex-shrink:0}
.body{flex:1;min-width:0}
.r1{display:flex;align-items:center;gap:8px}
.adapter{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.url{font-family:Menlo,Monaco,'Courier New',monospace;font-size:11.5px;color:var(--blue);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{font-size:10.5px;color:var(--text2);margin-top:3px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dot{width:5px;height:5px;border-radius:50%;background:var(--text2);display:inline-block}
.badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:11px;white-space:nowrap}
.br{background:rgba(63,185,80,.16);color:var(--green)}
.bs{background:rgba(88,166,255,.16);color:var(--blue)}
.bk{background:rgba(248,81,73,.14);color:var(--red)}
.be{background:rgba(139,148,158,.14);color:var(--text2)}
.berr{background:rgba(248,81,73,.22);color:var(--red)}
.port{font-family:Menlo,Monaco,'Courier New',monospace}
#empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text2);gap:8px;padding:48px;text-align:center}
#empty .ico{font-size:30px}
#statusbar{padding:5px 16px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
</style>
</head>
<body>
<div id="app">
  <div id="hdr">
    <div>
      <h1>Bureau — sessions navigateur</h1>
      <div class="sub">services navigateur actifs · URL / port / statut</div>
    </div>
    <button id="refresh-btn" title="Rafraîchir" onclick="doRefresh()">&#8635;</button>
  </div>
  <div id="list"><div id="empty"><div class="ico">&#127760;</div><div>Connexion au bridge&#8230;</div></div></div>
  <div id="statusbar">Connexion&#8230;</div>
</div>
<script>
// ── MCP Apps bridge — JSON-RPC 2.0 over window.parent.postMessage ──
// Spec: io.modelcontextprotocol/ui 2026-01-26
var _nextId = 1, _pending = {};
function post(msg){ window.parent.postMessage(msg, '*'); }
function rpcRequest(method, params){
  return new Promise(function(resolve, reject){
    var id = _nextId++;
    _pending[id] = {resolve: resolve, reject: reject};
    post({jsonrpc:'2.0', id:id, method:method, params:params||{}});
  });
}
function rpcNotify(method, params){ post({jsonrpc:'2.0', method:method, params:params||{}}); }
window.addEventListener('message', function(evt){
  var msg = evt.data;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
  if (msg.id != null && msg.method == null){
    var p = _pending[msg.id];
    if (!p) return;
    delete _pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error.message || ('rpc error ' + msg.error.code)));
    else p.resolve(msg.result);
  }
});
function initBridge(){
  return rpcRequest('ui/initialize', {
    capabilities: {},
    clientInfo: {name:'agentproto-bureau-sessions', version:'0.1.0'},
    protocolVersion: '2026-01-26',
    appCapabilities: {tools:{listChanged:false}, availableDisplayModes:['inline','fullscreen']}
  }).then(function(){ rpcNotify('ui/notifications/initialized', {}); });
}
function callTool(name, args){
  return rpcRequest('tools/call', {name:name, arguments:args||{}}).then(function(result){
    if (result.isError){
      var e = (result.content && result.content[0] && result.content[0].text) || 'tool error';
      throw new Error(e);
    }
    var text = (result.content && result.content[0] && result.content[0].text) || '{}';
    return JSON.parse(text);
  });
}

// ── State ──
var REFRESH_MS = 5000;
var pollTimer = null, polling = false;
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function setStatus(m){ document.getElementById('statusbar').textContent = m; }

function badgeClass(st){
  if (st === 'running') return 'br';
  if (st === 'starting') return 'bs';
  if (st === 'killed') return 'bk';
  if (st === 'error') return 'berr';
  return 'be';
}
function fmtUptime(iso, end){
  if (!iso) return '';
  var start = Date.parse(iso);
  if (isNaN(start)) return '';
  var ref = end ? Date.parse(end) : Date.now();
  var s = Math.max(0, Math.round((ref - start) / 1000));
  if (s < 60) return s + 's';
  var m = Math.floor(s/60), rs = s%60;
  if (m < 60) return m + 'm ' + rs + 's';
  var h = Math.floor(m/60), rm = m%60;
  return h + 'h ' + rm + 'm';
}

function render(rows){
  var list = document.getElementById('list');
  if (!rows.length){
    list.innerHTML = '<div id="empty"><div class="ico">&#127760;</div><div>Aucune session navigateur</div></div>';
    return;
  }
  var html = '';
  for (var i=0;i<rows.length;i++){
    var s = rows[i];
    var bc = badgeClass(s.status);
    var url = s.browserBaseUrl || (s.browserPort ? ('http://127.0.0.1:' + s.browserPort) : '');
    var adapter = s.browserAdapterId || s.label || s.name || 'navigateur';
    var up = fmtUptime(s.startedAt, s.endedAt);
    html += '<div class="row">'
      + '<div class="icon">&#127760;</div>'
      + '<div class="body">'
      +   '<div class="r1"><span class="adapter">' + esc(adapter) + '</span>'
      +     '<span class="badge ' + bc + '">' + esc(s.status || '') + '</span></div>'
      +   (url ? '<div class="url">' + esc(url) + '</div>' : '')
      +   '<div class="meta">'
      +     (s.browserPort ? '<span>port <span class="port">' + esc(s.browserPort) + '</span></span><span class="dot"></span>' : '')
      +     '<span>' + (up ? 'uptime ' + esc(up) : '') + '</span>'
      +   '</div>'
      + '</div>'
      + '</div>';
  }
  list.innerHTML = html;
}

function loadAndRender(){
  return callTool('session_list', {kind:'all'}).then(function(data){
    var all = data.sessions || [];
    var browsers = all.filter(function(s){ return s.kind === 'browser'; });
    render(browsers);
    setStatus(browsers.length + ' session' + (browsers.length===1?'':'s') + ' · ' + new Date().toLocaleTimeString('fr-FR'));
  }).catch(function(e){ setStatus('Erreur : ' + e.message); });
}

function doPoll(){
  if (polling) return;
  polling = true;
  loadAndRender().then(function(){
    polling = false;
    pollTimer = setTimeout(doPoll, REFRESH_MS);
  }).catch(function(){
    polling = false;
    pollTimer = setTimeout(doPoll, REFRESH_MS);
  });
}
function doRefresh(){ if (pollTimer) clearTimeout(pollTimer); return loadAndRender().then(function(){ pollTimer = setTimeout(doPoll, REFRESH_MS); }); }

initBridge().then(loadAndRender).then(function(){
  pollTimer = setTimeout(doPoll, REFRESH_MS);
}).catch(function(e){
  setStatus('Bridge : ' + e.message);
  document.getElementById('list').innerHTML = '<div id="empty"><div class="ico">&#9888;</div><div>Échec connexion bridge : ' + esc(e.message) + '</div></div>';
});
</script>
</body>
</html>`
