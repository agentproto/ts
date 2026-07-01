/**
 * MCP App resource: agentproto sessions panel.
 *
 * Declares a `ui://agentproto/sessions-panel` resource (mimeType
 * `text/html;profile=mcp-app`) and an `open_sessions_panel` tool that
 * links to it via `_meta.ui.resourceUri`.
 *
 * Protocol: MCP Apps ext spec 2026-01-26
 *   – Bridge: JSON-RPC 2.0 over window.parent.postMessage
 *   – Handshake: ui/initialize → host result → ui/notifications/initialized
 *   – Data: tools/call → list_sessions + get_agent_session_output (3 s poll)
 *   – Kill action: tools/call → kill_agent_session | kill_terminal_session
 *     (goes through Claude's normal tool approval flow)
 *
 * The HTML bundle is fully autonomous (zero CDN, zero external deps).
 * ANSI-to-HTML renderer handles SGR codes (colors 0-15, bold, dim,
 * italic, underline, reset). CR-overwrite sequences are stripped so
 * progress bars don't corrupt the output.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const RESOURCE_URI = "ui://agentproto/sessions-panel"
const MIME_TYPE = "text/html;profile=mcp-app"

// ── HTML bundle ─────────────────────────────────────────────────────────────

export const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>agentproto sessions</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#e6edf3;--text2:#8b949e;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
}
html,body{height:100%;font-family:Menlo,Monaco,'Courier New',monospace;font-size:13px;background:var(--bg);color:var(--text);overflow:hidden}
#app{display:flex;height:100%}
#sidebar{width:220px;min-width:180px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
#sidebar-hdr{padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
#sidebar-hdr h1{font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.06em}
#refresh-btn{background:none;border:none;cursor:pointer;color:var(--text2);font-size:15px;line-height:1;padding:2px 4px;border-radius:4px;font-family:inherit}
#refresh-btn:hover{color:var(--text);background:var(--bg3)}
#session-list{flex:1;overflow-y:auto;padding:4px 0}
.si{padding:8px 12px;cursor:pointer;border-left:2px solid transparent}
.si:hover{background:var(--bg3)}
.si.active{background:var(--bg3);border-left-color:var(--blue)}
.sn{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm{font-size:11px;color:var(--text2);margin-top:2px;display:flex;gap:6px;align-items:center}
.badge{display:inline-block;padding:1px 5px;border-radius:10px;font-size:10px;font-weight:600}
.br{background:rgba(63,185,80,.15);color:var(--green)}
.bs{background:rgba(88,166,255,.15);color:var(--blue)}
.be{background:rgba(139,148,158,.1);color:var(--text2)}
.bk{background:rgba(248,81,73,.1);color:var(--red)}
.berr{background:rgba(248,81,73,.2);color:var(--red)}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#toolbar{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;background:var(--bg2)}
#session-title{font-size:12px;font-weight:500;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.abtn{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}
.abtn:hover{background:var(--border)}
.abtn:disabled{opacity:.4;cursor:default}
.abtn.danger{border-color:var(--red);color:var(--red)}
.abtn.danger:hover{background:rgba(248,81,73,.1)}
#output{flex:1;overflow-y:auto;padding:8px 12px;background:var(--bg);font-size:12px;line-height:1.6}
.line{white-space:pre-wrap;word-break:break-all}
#empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text2);gap:8px;text-align:center;padding:24px}
#empty .ico{font-size:32px}
#statusbar{padding:4px 12px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
.errmsg{color:var(--red);padding:12px}
/* ANSI SGR */
.ab{font-weight:bold}.ad{opacity:.6}.ai{font-style:italic}.au{text-decoration:underline}
.f0{color:#21262d}.f1{color:#f85149}.f2{color:#3fb950}.f3{color:#d29922}
.f4{color:#58a6ff}.f5{color:#bc8cff}.f6{color:#39d353}.f7{color:#e6edf3}
.f8{color:#8b949e}.f9{color:#ff7b72}.f10{color:#56d364}.f11{color:#e3b341}
.f12{color:#79c0ff}.f13{color:#d2a8ff}.f14{color:#56d364}.f15{color:#f0f6fc}
</style>
</head>
<body>
<div id="app">
  <div id="sidebar">
    <div id="sidebar-hdr">
      <h1>Sessions</h1>
      <button id="refresh-btn" title="Refresh" onclick="doRefresh()">&#8635;</button>
    </div>
    <div id="session-list"></div>
  </div>
  <div id="main">
    <div id="toolbar" style="display:none">
      <span id="session-title"></span>
      <button class="abtn danger" id="kill-btn" onclick="doKill()">Kill</button>
    </div>
    <div id="output">
      <div id="empty"><div class="ico">&#9889;</div><div>Select a session</div></div>
    </div>
    <div id="statusbar">Connecting to bridge&#8230;</div>
  </div>
</div>
<script>
// ============================================================
// MCP Apps bridge — JSON-RPC 2.0 over window.parent.postMessage
// Spec: io.modelcontextprotocol/ui 2026-01-26
// ============================================================

var _nextId = 1;
var _pending = {};   // id -> {resolve, reject}

function post(msg) {
  window.parent.postMessage(msg, '*');
}

function rpcRequest(method, params) {
  return new Promise(function(resolve, reject) {
    var id = _nextId++;
    _pending[id] = {resolve: resolve, reject: reject};
    post({jsonrpc: '2.0', id: id, method: method, params: params || {}});
  });
}

function rpcNotify(method, params) {
  post({jsonrpc: '2.0', method: method, params: params || {}});
}

window.addEventListener('message', function(evt) {
  var msg = evt.data;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
  // Responses have an id and are not requests (no method)
  if (msg.id != null && msg.method == null) {
    var p = _pending[msg.id];
    if (!p) return;
    delete _pending[msg.id];
    if (msg.error) {
      p.reject(new Error(msg.error.message || 'rpc error ' + msg.error.code));
    } else {
      p.resolve(msg.result);
    }
  }
  // Host notifications (ui/notifications/tool-input, ui/resource-teardown, etc.)
  // — ignored for now; panel drives via poll
});

// Initialize bridge per spec 2026-01-26
function initBridge() {
  return rpcRequest('ui/initialize', {
    capabilities: {},
    clientInfo: {name: 'agentproto-sessions-panel', version: '0.1.0'},
    protocolVersion: '2026-01-26',
    appCapabilities: {
      tools: {listChanged: false},
      availableDisplayModes: ['inline', 'fullscreen']
    }
  }).then(function() {
    rpcNotify('ui/notifications/initialized', {});
  });
}

// Call an MCP tool through the bridge and parse the JSON result text
function callTool(name, args) {
  return rpcRequest('tools/call', {name: name, arguments: args || {}}).then(function(result) {
    if (result.isError) {
      var errText = (result.content && result.content[0] && result.content[0].text) || 'tool error';
      throw new Error(errText);
    }
    var text = (result.content && result.content[0] && result.content[0].text) || '{}';
    return JSON.parse(text);
  });
}

// ============================================================
// ANSI-to-HTML renderer (SGR codes: colors 0-15, bold/dim/italic/underline)
// ============================================================

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function ansiToHtml(raw) {
  // Strip CR overwrite sequences (progress bars: \r without \n)
  var text = raw.replace(/[^\n]*\r([^\n])/g, '$1').replace(/\r/g, '');
  var bold = false, dim = false, italic = false, underline = false, fg = -1;
  var out = '';
  // Split on ESC [ ... m (SGR) sequences; keep delimiters
  var ESC = '';
  var parts = text.split(/([]\[[0-9;]*m)/);
  for (var pi = 0; pi < parts.length; pi++) {
    var part = parts[pi];
    if (part.length === 0) continue;
    if (part.charCodeAt(0) === 0x1b && part[1] === '[') {
      // Parse SGR parameters
      var inner = part.slice(2, part.length - 1); // strip ESC[ and m
      var codes = inner === '' ? [0] : inner.split(';').map(Number);
      for (var ci = 0; ci < codes.length; ci++) {
        var c = codes[ci];
        if (c === 0) { bold = false; dim = false; italic = false; underline = false; fg = -1; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 3) italic = true;
        else if (c === 4) underline = true;
        else if (c === 22) { bold = false; dim = false; }
        else if (c === 23) italic = false;
        else if (c === 24) underline = false;
        else if (c >= 30 && c <= 37) fg = c - 30;
        else if (c === 39) fg = -1;
        else if (c >= 90 && c <= 97) fg = c - 90 + 8;
      }
    } else {
      // Text segment — strip any remaining non-printable ESC sequences
      var safe = escHtml(part).replace(/\[[^m]*[A-Za-z]/g, '');
      if (safe === '') continue;
      var cls = '';
      if (bold) cls += ' ab';
      if (dim) cls += ' ad';
      if (italic) cls += ' ai';
      if (underline) cls += ' au';
      if (fg >= 0 && fg <= 15) cls += ' f' + fg;
      cls = cls.trim();
      out += cls ? '<span class="' + cls + '">' + safe + '</span>' : safe;
    }
  }
  return out;
}

// ============================================================
// App state
// ============================================================

var sessions = [];
var activeId = null;
var outputLines = [];
var nextCursor = 0;
var pollTimer = null;
var pollActive = false;

function setStatus(msg) {
  document.getElementById('statusbar').textContent = msg;
}

// ============================================================
// Session list
// ============================================================

function badgeClass(status) {
  if (status === 'running') return 'br';
  if (status === 'starting') return 'bs';
  if (status === 'killed') return 'bk';
  if (status === 'error') return 'berr';
  return 'be'; // exited
}

function renderSidebar() {
  var el = document.getElementById('session-list');
  if (sessions.length === 0) {
    el.innerHTML = '<div style="padding:12px;color:var(--text2);font-size:11px">No sessions</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    var label = s.label || s.name || (s.command ? s.command.split('/').pop() : null) || s.id.slice(0, 8);
    var bc = badgeClass(s.status);
    var active = s.id === activeId ? ' active' : '';
    html += '<div class="si' + active + '" onclick="selectSession(\'' + s.id + '\')">'
          + '<div class="sn">' + escHtml(label) + '</div>'
          + '<div class="sm">'
          + '<span class="badge ' + bc + '">' + s.status + '</span>'
          + '<span>' + escHtml(s.kind || '') + '</span>'
          + '</div></div>';
  }
  el.innerHTML = html;
}

function loadSessions() {
  return callTool('session_list', {kind: 'all'}).then(function(data) {
    sessions = data.sessions || [];
    renderSidebar();
    setStatus(sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ' · ' + new Date().toLocaleTimeString());
  }).catch(function(e) {
    setStatus('Error: ' + e.message);
  });
}

// ============================================================
// Output panel
// ============================================================

function renderOutputFull() {
  var el = document.getElementById('output');
  if (outputLines.length === 0) {
    el.innerHTML = '<div id="empty"><div class="ico">&#9889;</div><div>No output yet</div></div>';
    return;
  }
  var html = '';
  for (var i = 0; i < outputLines.length; i++) {
    html += '<div class="line">' + ansiToHtml(outputLines[i]) + '</div>';
  }
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function appendLines(lines) {
  var el = document.getElementById('output');
  // Remove empty-state placeholder if present
  var empty = el.querySelector('#empty');
  if (empty) empty.parentNode.removeChild(empty);
  var frag = document.createDocumentFragment();
  for (var i = 0; i < lines.length; i++) {
    var div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = ansiToHtml(lines[i]);
    frag.appendChild(div);
  }
  el.appendChild(frag);
  el.scrollTop = el.scrollHeight;
}

function selectSession(id) {
  activeId = id;
  outputLines = [];
  nextCursor = 0;
  renderSidebar();

  var s = null;
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].id === id) { s = sessions[i]; break; }
  }

  var toolbar = document.getElementById('toolbar');
  toolbar.style.display = 'flex';
  document.getElementById('session-title').textContent = (s && (s.label || s.name)) || id.slice(0, 12);

  var killBtn = document.getElementById('kill-btn');
  killBtn.disabled = !s || (s.status !== 'running' && s.status !== 'starting');

  document.getElementById('output').innerHTML = '<div style="padding:12px;color:var(--text2)">Loading&#8230;</div>';

  // Initial load
  callTool('agent_output', {sessionId: id, lastN: 200}).then(function(data) {
    outputLines = data.lines || [];
    nextCursor = data.nextCursor || 0;
    renderOutputFull();
  }).catch(function(e) {
    document.getElementById('output').innerHTML = '<div class="errmsg">Error: ' + escHtml(e.message) + '</div>';
  });
}

// ============================================================
// Kill
// ============================================================

function doKill() {
  if (!activeId) return;
  var s = null;
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].id === activeId) { s = sessions[i]; break; }
  }
  var toolName = (s && s.pty) ? 'terminal_kill' : 'agent_kill';
  callTool(toolName, {sessionId: activeId}).then(function() {
    return doRefresh();
  }).catch(function(e) {
    setStatus('Kill failed: ' + e.message);
  });
}

// ============================================================
// Poll
// ============================================================

function doPoll() {
  if (pollActive) return;
  pollActive = true;
  var p = loadSessions();
  if (activeId) {
    var capturedId = activeId;
    var capturedCursor = nextCursor;
    p = p.then(function() {
      return callTool('agent_output', {sessionId: capturedId, since: capturedCursor});
    }).then(function(data) {
      if (capturedId !== activeId) return; // user switched sessions
      var newLines = data.lines || [];
      if (newLines.length > 0) {
        outputLines = outputLines.concat(newLines);
        if (outputLines.length > 2000) outputLines = outputLines.slice(-2000);
        nextCursor = data.nextCursor || nextCursor;
        appendLines(newLines);
      }
    }).catch(function() {});
  }
  p.then(function() {
    pollActive = false;
    pollTimer = setTimeout(doPoll, 3000);
  }).catch(function() {
    pollActive = false;
    pollTimer = setTimeout(doPoll, 3000);
  });
}

function doRefresh() {
  return loadSessions().then(function() {
    if (activeId) {
      return callTool('agent_output', {sessionId: activeId, lastN: 200}).then(function(data) {
        outputLines = data.lines || [];
        nextCursor = data.nextCursor || 0;
        renderOutputFull();
      });
    }
  });
}

// ============================================================
// Boot
// ============================================================

initBridge().then(function() {
  return loadSessions();
}).then(function() {
  pollTimer = setTimeout(doPoll, 3000);
}).catch(function(e) {
  setStatus('Bridge error: ' + e.message);
  document.getElementById('output').innerHTML = '<div class="errmsg">Failed to connect to MCP bridge: ' + escHtml(e.message) + '</div>';
});
</script>
</body>
</html>`

// ── MCP registration ─────────────────────────────────────────────────────────

export function registerSessionsPanelResource(server: McpServer): void {
  // Resource — MCP Apps host (Claude) reads this and renders the HTML
  // in a sandboxed iframe.
  server.registerResource(
    "sessions-panel",
    RESOURCE_URI,
    {
      mimeType: MIME_TYPE,
      description:
        "Interactive sessions panel — browse, inspect output, and kill " +
        "agentproto daemon sessions. Rendered as an MCP App in the host UI.",
      _meta: {
        ui: {
          // No external CSP domains needed — fully autonomous bundle.
          prefersBorder: true,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: MIME_TYPE,
          text: PANEL_HTML,
        },
      ],
    }),
  )

  // Tool — links to the panel resource via _meta.ui.resourceUri so the
  // host pre-associates the panel with this tool call and can show it
  // immediately when the tool is invoked.
  server.registerTool(
    "open_sessions_panel",
    {
      description:
        "Open the agentproto sessions panel — an interactive UI that shows all " +
        "running and recent sessions (agent-CLI, terminal/PTY, commands). " +
        "The panel polls live data and lets you inspect output or kill sessions. " +
        "Rendered as an MCP App in the host interface.",
      inputSchema: undefined,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: true,
              panel: RESOURCE_URI,
              message: "Sessions panel available. The host should render it as an MCP App.",
            },
            null,
            2,
          ),
        },
      ],
    }),
  )
}
