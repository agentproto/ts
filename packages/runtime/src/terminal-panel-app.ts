/**
 * McpApp definition for a REAL interactive terminal — connects the MCP App
 * iframe directly to the daemon's live PTY WebSocket (`/sessions/:id/pty`),
 * not a poll loop. Distinct from @agentproto/apps's sessions-panel/
 * agents-overview/bureau-sessions, which are all read-only snapshots
 * refreshed via `tools/call`. This is the one builtin panel that stays in
 * runtime (needs the PTY WebSocket + `spawnOrAttach`, not a portable,
 * dependency-free `AgnoMcpApp` factory) — see builtin-apps.ts for the five
 * that moved.
 *
 * Uses the same AgnoMcpApp contract (no @agstudio/mcp-apps dependency —
 * agentproto is a standalone workspace). Wire via `registerMcpApps`.
 *
 * Protocol flow:
 *   1. Tool `agentproto_terminal` is called (spawn a new PTY, or attach to
 *      an existing one by `sessionId`).
 *   2. execute() resolves/creates the session via `ops.spawnOrAttach`, then
 *      returns `{sessionId, wsUrl, token, cols, rows}` as the tool's JSON
 *      text result — the client's connection recipe.
 *   3. The HTML panel opens `ui/initialize` (the standard bridge handshake,
 *      for spec compliance) and, independently, opens a real `WebSocket` to
 *      `wsUrl` — bytes flow directly daemon <-> iframe, no `tools/call`
 *      round-trip on the data path.
 *
 * CSP: per the MCP Apps ext spec (2026-01-26), a sandboxed host iframe may
 * only open a WebSocket to an origin the resource's `_meta.ui.csp
 * .connectDomains` allowlist declares. `csp.connectDomains` below is set to
 * the exact origin `wsUrl` resolves to, threaded by `registerMcpApps`
 * (mcp-apps-adapter.ts) into the RESOURCE's `_meta.ui.csp` — CSP is
 * resource-only, never on the tool. Whether Cowork's host actually enforces
 * (or even reads) this declaration is unverified; this only builds the
 * correct declaration.
 */

import { z } from "zod"
import type { AgnoMcpApp } from "@agentproto/apps"

export const terminalPanelInputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      "Attach to an existing PTY session (id or name from terminal_start). " +
        "Omit to spawn a new one from `argv`.",
    ),
  argv: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      "Argv for a new PTY session. Ignored when `sessionId` is set. " +
        "Defaults to a login shell (`bash`).",
    ),
  cwd: z
    .string()
    .optional()
    .describe("Absolute cwd for a new session. Wins over workspaceSlug."),
  workspaceSlug: z
    .string()
    .optional()
    .describe("Workspace slug resolving cwd for a new session."),
  cols: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Terminal columns. Default 80."),
  rows: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Terminal rows. Default 24."),
})

export type TerminalPanelInput = z.infer<typeof terminalPanelInputSchema>

export type TerminalPanelOutput = {
  sessionId: string
  wsUrl: string
  /** Empty string when the daemon has no token configured (the sessions
   *  gate is a no-op in that case — see checkSessionsToken). */
  token: string
  cols: number
  rows: number
}

export interface TerminalPanelOps {
  /** Resolve `input.sessionId` to a live PTY session, or spawn a fresh one
   *  from `input.argv`/`input.cwd`/`input.workspaceSlug`. Registry access
   *  (findByIdOrName / spawnPty / workspace resolution) lives entirely on
   *  the caller's side of this closure — this module never imports
   *  SessionsRegistry, matching the sessions-panel-app.ts convention. */
  spawnOrAttach(input: TerminalPanelInput): Promise<{ sessionId: string }>
  /** The daemon's own PTY-WS origin, e.g. "ws://127.0.0.1:18790". Computed
   *  once by the caller (packages/runtime/src/index.ts already knows its
   *  own `port`/`bind` at server-construction time — no need to re-derive
   *  it from `.agentproto/runtime.json` on disk, see the comment at the
   *  call site). */
  wsBaseUrl: string
  /** Sessions-gate bearer token, or undefined when the daemon runs with no
   *  token configured. Sent to the client as a query-string param (not a
   *  header) because a browser/iframe WS upgrade can't set custom headers
   *  — this is the same tradeoff `checkSessionsToken`'s `?token=` path
   *  exists for. */
  token?: string
}

/**
 * Factory: close over the daemon's own connection info + a spawn/attach
 * callback so execute() needs nothing beyond the tool input.
 */
export function makeTerminalPanelApp(
  ops: TerminalPanelOps,
): AgnoMcpApp<TerminalPanelInput, TerminalPanelOutput> {
  // `new URL(...).origin` normalises "ws://127.0.0.1:18790" (no path) to
  // itself — this is the exact connectDomains entry the CSP allowlist
  // needs, derived from the one wsUrl this app will ever open.
  const wsOrigin = new URL(ops.wsBaseUrl).origin

  return {
    id: "agentproto_terminal",
    title: "Interactive Terminal",
    description:
      "Open a REAL interactive terminal — a live PTY session streamed over " +
      "a WebSocket, not a polling panel. Spawns a new shell (default `bash`) " +
      "or attaches to an existing terminal/PTY session by id.",
    inputSchema: terminalPanelInputSchema,
    execute: async input => {
      const { sessionId } = await ops.spawnOrAttach(input)
      const cols = input.cols ?? 80
      const rows = input.rows ?? 24
      return {
        sessionId,
        wsUrl: `${ops.wsBaseUrl}/sessions/${encodeURIComponent(sessionId)}/pty?cols=${cols}&rows=${rows}`,
        token: ops.token ?? "",
        cols,
        rows,
      }
    },
    html: (initData: TerminalPanelOutput) => TERMINAL_HTML(initData),
    csp: { connectDomains: [wsOrigin] },
  }
}

// ── HTML bundle (zero CDN, self-contained) ──────────────────────────────────

function TERMINAL_HTML(initData: TerminalPanelOutput): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>agentproto terminal</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#e6edf3;--text2:#8b949e;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
}
html,body{height:100%;font-family:Menlo,Monaco,'Courier New',monospace;font-size:13px;background:var(--bg);color:var(--text);overflow:hidden}
#app{display:flex;flex-direction:column;height:100%}
#toolbar{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;background:var(--bg2);flex-shrink:0}
#toolbar .title{font-size:12px;font-weight:500;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.abtn{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}
.abtn:hover{background:var(--border)}
#output{flex:1;overflow-y:auto;padding:8px 12px;background:var(--bg);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all}
#inputbar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
#inputbar .prompt{color:var(--green);font-weight:bold}
#line{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;outline:none}
#line:disabled{opacity:.5}
#statusbar{padding:4px 12px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
/* ANSI SGR — copied verbatim from sessions-panel.ts (same PTY-output
   rendering problem: colours 0-15, bold/dim/italic/underline). */
.ab{font-weight:bold}.ad{opacity:.6}.ai{font-style:italic}.au{text-decoration:underline}
.f0{color:#21262d}.f1{color:#f85149}.f2{color:#3fb950}.f3{color:#d29922}
.f4{color:#58a6ff}.f5{color:#bc8cff}.f6{color:#39d353}.f7{color:#e6edf3}
.f8{color:#8b949e}.f9{color:#ff7b72}.f10{color:#56d364}.f11{color:#e3b341}
.f12{color:#79c0ff}.f13{color:#d2a8ff}.f14{color:#56d364}.f15{color:#f0f6fc}
</style>
</head>
<body>
<div id="app">
  <div id="toolbar">
    <span class="title" id="title">Terminal</span>
    <button class="abtn" id="ctrlc-btn" onclick="sendCtrlC()">Ctrl-C</button>
  </div>
  <div id="output"></div>
  <div id="inputbar">
    <span class="prompt">&gt;</span>
    <input id="line" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="type a command, press Enter to send&#8230;">
  </div>
  <div id="statusbar">Connecting&#8230;</div>
</div>
<script>
window.__APP_INIT__ = ${JSON.stringify(initData)};

// ============================================================
// MCP Apps bridge — JSON-RPC 2.0 over window.parent.postMessage
// Spec: io.modelcontextprotocol/ui 2026-01-26
// Copied verbatim from sessions-panel.ts — same handshake, same
// wire shape. The terminal's data path never rides this bridge
// (it talks to the PTY WebSocket directly); we still complete
// ui/initialize for host-side spec compliance, and use tools/call
// as a fallback source of connection info (see boot below).
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
});

function initBridge() {
  return rpcRequest('ui/initialize', {
    capabilities: {},
    clientInfo: {name: 'agentproto-terminal-panel', version: '0.1.0'},
    protocolVersion: '2026-01-26',
    appCapabilities: {
      tools: {listChanged: false},
      availableDisplayModes: ['inline', 'fullscreen']
    }
  }).then(function() {
    rpcNotify('ui/notifications/initialized', {});
  });
}

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
// ANSI-to-HTML renderer — copied verbatim from sessions-panel.ts
// (SGR codes: colors 0-15, bold/dim/italic/underline).
// ============================================================

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function ansiToHtml(raw) {
  var text = raw.replace(/[^\\n]*\\r([^\\n])/g, '$1').replace(/\\r/g, '');
  var bold = false, dim = false, italic = false, underline = false, fg = -1;
  var out = '';
  var parts = text.split(/([\\x1b]\\[[0-9;]*m)/);
  for (var pi = 0; pi < parts.length; pi++) {
    var part = parts[pi];
    if (part.length === 0) continue;
    if (part.charCodeAt(0) === 0x1b && part[1] === '[') {
      var inner = part.slice(2, part.length - 1);
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
      var safe = escHtml(part).replace(/\\x1b\\[[^m]*[A-Za-z]/g, '');
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
// Terminal state
// ============================================================

var ws = null;
var ended = false;

function setStatus(msg) {
  document.getElementById('statusbar').textContent = msg;
}

function appendChunk(text) {
  var el = document.getElementById('output');
  var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  var span = document.createElement('span');
  span.innerHTML = ansiToHtml(text);
  el.appendChild(span);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Ctrl-C is the single most common interactive need (killing a hung
// foreground command) and can't be typed into a plain <input>, so it
// gets its own button + keydown intercept alongside line mode.
function sendCtrlC() {
  wsSend({kind: 'input', text: '\\u0003'});
}

// ------------------------------------------------------------
// Input mode: LINE-BUFFERED, not raw keystroke-by-keystroke.
//
// Tradeoff (intentional prototype scope cut, not a bug): a real
// terminal forwards every keydown (arrows -> ANSI escapes, Backspace
// -> \\x7f, live single-char echo, etc). Doing that correctly inside a
// sandboxed iframe means fighting the browser for key composition,
// IME input, and OS-level shortcut interception — a lot of surface
// for a prototype whose point is proving the PTY WebSocket + CSP
// plumbing. Line mode (type a full command, Enter submits it as one
// CR-terminated frame) covers the dominant use case — running shell
// commands — with a small fraction of the code and no keyboard-replay
// edge cases. Ctrl-C is special-cased (see sendCtrlC) since "kill the
// foreground thing" is common enough to need a way in.
// ------------------------------------------------------------
function initInput() {
  var input = document.getElementById('line');
  input.addEventListener('keydown', function(evt) {
    if (evt.key === 'Enter') {
      evt.preventDefault();
      var text = input.value;
      input.value = '';
      wsSend({kind: 'input', text: text + '\\r'});
    } else if (evt.ctrlKey && (evt.key === 'c' || evt.key === 'C')) {
      evt.preventDefault();
      sendCtrlC();
    }
  });
  input.focus();
}

function connect(conn) {
  var url = conn.wsUrl + (conn.wsUrl.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(conn.token || '');
  document.getElementById('title').textContent = 'Terminal · ' + conn.sessionId;
  setStatus('Connecting to ' + conn.sessionId + '\\u2026');
  ws = new WebSocket(url);
  ws.addEventListener('open', function() {
    setStatus('Connected \\u00b7 ' + conn.sessionId);
    wsSend({kind: 'resize', cols: conn.cols || 80, rows: conn.rows || 24});
  });
  ws.addEventListener('message', function(evt) {
    var frame;
    try { frame = JSON.parse(evt.data); } catch (e) { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.kind === 'data' && typeof frame.b64 === 'string') {
      try {
        var bytes = atob(frame.b64);
        var text = decodeURIComponent(escape(bytes));
        appendChunk(text);
      } catch (e) {
        // ignore malformed base64
      }
    } else if (frame.kind === 'exit') {
      ended = true;
      var code = typeof frame.exitCode === 'number' ? frame.exitCode : 0;
      setStatus('Session ended \\u00b7 exit code ' + code);
      document.getElementById('line').disabled = true;
      appendChunk('\\n[session ended, exit code ' + code + ']\\n');
    }
  });
  ws.addEventListener('close', function() {
    if (!ended) setStatus('Disconnected');
    document.getElementById('line').disabled = true;
  });
  ws.addEventListener('error', function() {
    setStatus('WebSocket error');
  });
}

// ============================================================
// Boot
// ============================================================

initInput();
initBridge().then(function() {
  var init = window.__APP_INIT__ || {};
  if (init.wsUrl) return init;
  // The static ui:// resource is rendered once at server-registration
  // time with an EMPTY initData (see registerMcpApps in
  // mcp-apps-adapter.ts) — window.__APP_INIT__ above is therefore
  // "{}" unless a future host wires the real tool-call result back
  // into the iframe. Fall back to calling the tool ourselves over the
  // bridge, same as the other panels' initial load.
  return callTool('agentproto_terminal', {});
}).then(function(conn) {
  connect(conn);
}).catch(function(e) {
  setStatus('Bridge error: ' + e.message);
  appendChunk('[failed to connect: ' + e.message + ']\\n');
});
</script>
</body>
</html>`
}
