/**
 * Session Viewer — a self-contained MCP App panel for `session-viewer`.
 *
 * Talks to the daemon only through the `window.McpApp.connect()` bridge
 * (never a direct `fetch`): every action round-trips through the app's own
 * `app_tool_call` gateway tool, `{ appId, tool, args }` — same convention as
 * `media-viewer`/`mail-triage`. Read-only by design: `session_list` picks a
 * session (live or finished), `conversation_read` renders it as a clean
 * conversation — no spawn/kill/resume action lives here.
 *
 * Live sessions are polled (`conversation_read` has no push channel over
 * this bridge — see the PR's feasibility note on a real event/PTY stream);
 * a finished session is fetched once and left alone.
 */

export const SESSION_VIEWER_TOOLS = ["session_list", "conversation_read"] as const

const APP_ID = "@agentproto/session-viewer"

export const SESSION_VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Session Viewer</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#e6edf3;--text2:#8b949e;--text3:#6e7681;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;background:var(--bg);color:var(--text)}
#app{display:flex;height:100%;overflow:hidden}

/* sidebar */
#sidebar{width:250px;min-width:190px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
#sidebar-hdr{padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
#sidebar-hdr h1{font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;flex:1}
#archived-toggle{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--text2);padding:6px 12px;border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
#archived-toggle input{cursor:pointer}
#refresh-btn{background:none;border:none;cursor:pointer;color:var(--text2);font-size:14px;line-height:1;padding:2px 4px;border-radius:4px;font-family:inherit}
#refresh-btn:hover{color:var(--text);background:var(--bg3)}
#session-list{flex:1;overflow-y:auto;padding:4px 0}
.si{padding:8px 12px;cursor:pointer;border-left:2px solid transparent}
.si:hover{background:var(--bg3)}
.si.active{background:var(--bg3);border-left-color:var(--blue)}
.si .sn{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.si .sm{font-size:10.5px;color:var(--text2);margin-top:3px;display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.badge{display:inline-block;padding:1px 6px;border-radius:10px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.02em}
.b-run{background:rgba(63,185,80,.15);color:var(--green)}
.b-wait{background:rgba(88,166,255,.15);color:var(--blue)}
.b-idle{background:rgba(139,148,158,.12);color:var(--text2)}
.b-end{background:rgba(139,148,158,.1);color:var(--text3)}
.b-err{background:rgba(248,81,73,.15);color:var(--red)}
#empty-sidebar{padding:14px 12px;color:var(--text2);font-size:11.5px}

/* main */
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#header{padding:12px 18px;border-bottom:1px solid var(--border);background:var(--bg2);flex-shrink:0}
#header .htitle{font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px}
.pulse{width:7px;height:7px;border-radius:50%;background:var(--green);flex:none;box-shadow:0 0 0 0 rgba(63,185,80,.4);animation:pulse 2s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 6px rgba(63,185,80,0)}100%{box-shadow:0 0 0 0 rgba(63,185,80,0)}}
#header .hfacts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.fact{font-size:10.5px;font-weight:600;background:var(--bg3);border:1px solid var(--border);color:var(--text2);padding:3px 9px;border-radius:999px}
#empty-main,#loading-main,#error-main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text2);gap:8px;text-align:center;padding:24px}
#empty-main .ico,#loading-main .ico{font-size:30px}
#error-main{color:var(--red)}

/* transcript */
#transcript{flex:1;overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column;gap:10px}
.msg{display:flex;flex-direction:column;max-width:78%}
.msg.role-user{align-self:flex-end;align-items:flex-end}
.msg.role-assistant,.msg.role-tool{align-self:flex-start;align-items:flex-start}
.msg.role-system{align-self:center;max-width:90%}
.bubble{border-radius:10px;padding:9px 12px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.role-user .bubble{background:var(--blue);color:#04101c;border-bottom-right-radius:3px}
.role-assistant .bubble{background:var(--bg2);border:1px solid var(--border);border-bottom-left-radius:3px}
.role-system .bubble{background:transparent;border:1px dashed var(--border);color:var(--text2);font-size:11.5px;text-align:center}
.mrow{display:flex;align-items:center;gap:6px;margin-bottom:3px}
.mrole{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text3)}
.mtime{font-size:10px;color:var(--text3);font-variant-numeric:tabular-nums}

.chip{margin-top:6px;border:1px solid var(--border);border-radius:8px;background:var(--bg3);overflow:hidden;cursor:pointer;width:100%}
.chip .ch{padding:6px 10px;font-size:11.5px;display:flex;align-items:center;gap:7px;color:var(--text2)}
.chip .ch .ci{color:var(--yellow);flex:none}
.chip.tool-result .ch .ci{color:var(--purple)}
.chip .ch .cname{font-weight:600;color:var(--text)}
.chip .ch .cprev{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text3)}
.chip .ch .cchev{flex:none;transition:transform .12s;color:var(--text3);font-size:10px}
.chip.open .ch .cchev{transform:rotate(90deg)}
.chip pre{display:none;margin:0;border-top:1px solid var(--border);padding:9px 11px;font-family:Menlo,Monaco,'Courier New',monospace;font-size:11px;line-height:1.5;color:var(--text2);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
.chip.open pre{display:block}
.reasoning{margin-bottom:6px;font-size:11.5px;font-style:italic;color:var(--text2);border-left:2px solid var(--border);padding-left:8px}

#statusbar{padding:5px 18px;font-size:10.5px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0;display:flex;justify-content:space-between}
</style>
</head>
<body>
<div id="app">
  <div id="sidebar">
    <div id="sidebar-hdr">
      <h1>Sessions</h1>
      <button id="refresh-btn" title="Refresh" type="button">&#8635;</button>
    </div>
    <label id="archived-toggle"><input type="checkbox" id="archived-check"> show archived</label>
    <div id="session-list"></div>
  </div>
  <div id="main">
    <div id="header" style="display:none"></div>
    <div id="empty-main"><div class="ico">&#128172;</div><div>Pick a session to read its conversation</div></div>
    <div id="transcript" style="display:none"></div>
    <div id="statusbar" style="display:none">
      <span id="status-left"></span>
      <span id="status-right"></span>
    </div>
  </div>
</div>
<script>
var callTool = null;
var APP_ID = ${JSON.stringify(APP_ID)};

// app_tool_call wraps its dispatch result at least once (its own text-result
// body is the JSON-stringified inner MCP tool result); peel back through
// nested {content:[{type:"text",text:...}]} shells until the payload stops
// looking like one — works whichever layer the host's bridge already
// unwrapped. With conversation_read's format:"json" this resolves straight
// to the { meta, messages } object; with session_list, straight to
// { sessions: [...] }.
function unwrapText(result) {
  var cur = result;
  for (var i = 0; i < 4; i++) {
    if (typeof cur === "string") {
      try { cur = JSON.parse(cur); continue; } catch (e) { return cur; }
    }
    if (cur && Array.isArray(cur.content) && cur.content[0] && typeof cur.content[0].text === "string") {
      cur = cur.content[0].text;
      continue;
    }
    break;
  }
  return cur;
}

function callApp(tool, args) {
  return callTool("app_tool_call", { appId: APP_ID, tool: tool, args: args || {} }).then(unwrapText);
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtTime(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch (e) { return ""; }
}

function fmtClock(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return ""; }
}

function fmtRelative(iso) {
  if (!iso) return "";
  var ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return "";
  var s = Math.round(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  var m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  var h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

function fmtDuration(startIso, endIso) {
  var end = endIso ? new Date(endIso).getTime() : Date.now();
  var start = new Date(startIso).getTime();
  if (!isFinite(start) || !isFinite(end)) return "";
  var s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  var h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function prettyArgs(raw) {
  if (raw == null) return "";
  if (typeof raw !== "string") return JSON.stringify(raw, null, 2);
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { return raw; }
}

function firstLine(s, max) {
  var t = String(s == null ? "" : s).split("\\n")[0];
  return t.length > max ? t.slice(0, max) + "\\u2026" : t;
}

// ============================================================
// state
// ============================================================

var sessions = [];
var activeId = null;
var includeArchived = false;
var currentMeta = null;
var lastMessageCount = -1;
var sidebarTimer = null;
var convoTimer = null;

function findSession(id) {
  for (var i = 0; i < sessions.length; i++) if (sessions[i].id === id) return sessions[i];
  return null;
}

function isLive(s) {
  return !!s && (s.status === "running" || s.status === "starting");
}

// ============================================================
// sidebar
// ============================================================

function displayBadge(s) {
  if (s.status === "running") {
    if (s.busy) return { label: "working", cls: "b-run" };
    if (s.awaitingInput) return { label: "waiting", cls: "b-wait" };
    return { label: "idle", cls: "b-idle" };
  }
  if (s.status === "starting") return { label: "starting", cls: "b-wait" };
  if (s.status === "error" || s.status === "killed") return { label: s.status, cls: "b-err" };
  return { label: s.status || "exited", cls: "b-end" };
}

function renderSidebar() {
  var el = document.getElementById("session-list");
  if (sessions.length === 0) {
    el.innerHTML = '<div id="empty-sidebar">No sessions yet.</div>';
    return;
  }
  var html = "";
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    var label = s.label || s.title || s.name || (s.command ? String(s.command).split("/").pop() : null) || s.id.slice(0, 10);
    var db = displayBadge(s);
    var active = s.id === activeId ? " active" : "";
    html += '<div class="si' + active + '" data-id="' + escHtml(s.id) + '">'
      + '<div class="sn">' + escHtml(label) + "</div>"
      + '<div class="sm">'
      + '<span class="badge ' + db.cls + '">' + escHtml(db.label) + "</span>"
      + "<span>" + escHtml(s.kind || "") + "</span>"
      + "<span>" + escHtml(fmtRelative(s.startedAt)) + "</span>"
      + "</div></div>";
  }
  el.innerHTML = html;
  var rows = el.querySelectorAll(".si");
  for (var j = 0; j < rows.length; j++) {
    rows[j].addEventListener("click", (function (id) { return function () { selectSession(id); }; })(rows[j].getAttribute("data-id")));
  }
}

function loadSessions() {
  return callApp("session_list", { kind: "all", includeArchived: includeArchived }).then(function (data) {
    sessions = (data && data.sessions) || [];
    renderSidebar();
    if (activeId) {
      var hdr = document.getElementById("header");
      if (hdr.style.display !== "none") renderHeader();
    }
  }).catch(function (e) {
    document.getElementById("status-left").textContent = "sessions: " + e.message;
  });
}

// ============================================================
// header
// ============================================================

function renderHeader() {
  var s = findSession(activeId);
  var meta = currentMeta || {};
  var el = document.getElementById("header");
  el.style.display = "block";

  var title = meta.title || (s && (s.label || s.title)) || activeId;
  var live = s && isLive(s);
  var pulse = live ? '<span class="pulse"></span>' : "";

  var facts = [];
  if (meta.model || (s && s.model)) facts.push(escHtml(meta.model || (s && s.model)));
  if (s && s.adapterSlug) facts.push(escHtml(s.adapterSlug));
  if (s && s.kind) facts.push(escHtml(s.kind));
  if (s) { var db = displayBadge(s); facts.push(escHtml(db.label)); }
  if (s && s.cwd) facts.push('<span title="' + escHtml(s.cwd) + '">' + escHtml(s.cwd.length > 46 ? "\\u2026" + s.cwd.slice(-44) : s.cwd) + "</span>");
  var started = (meta.startedAt || (s && s.startedAt));
  if (started) facts.push("started " + escHtml(fmtClock(started)) + " (" + escHtml(fmtRelative(started)) + ")");
  var ended = meta.endedAt || (s && s.endedAt);
  if (ended) facts.push("ran " + escHtml(fmtDuration(started, ended)));
  else if (started) facts.push("running " + escHtml(fmtDuration(started)));
  if (meta.messageCount != null) facts.push(meta.messageCount + " messages");
  if (meta.toolCallCount != null) facts.push(meta.toolCallCount + " tool calls");
  if (meta.tokens && (meta.tokens.input != null || meta.tokens.output != null)) {
    facts.push("tokens " + (meta.tokens.input || 0) + "\\u2192" + (meta.tokens.output || 0));
  }
  if (meta.costUsd != null) facts.push("$" + Number(meta.costUsd).toFixed(4));

  el.innerHTML = '<div class="htitle">' + pulse + escHtml(title) + "</div>"
    + '<div class="hfacts">' + facts.map(function (f) { return '<span class="fact">' + f + "</span>"; }).join("") + "</div>";
}

// ============================================================
// transcript
// ============================================================

function renderToolCallChip(tc) {
  var args = prettyArgs(tc.args);
  return '<div class="chip tool-call"><div class="ch"><span class="ci">&#9656;</span>'
    + '<span class="cname">' + escHtml(tc.name || "tool") + "</span>"
    + '<span class="cprev">' + escHtml(firstLine(args, 64)) + "</span>"
    + '<span class="cchev">&#9656;</span></div><pre>' + escHtml(args) + "</pre></div>";
}

function renderToolResultChip(m) {
  var text = m.text || "";
  return '<div class="chip tool-result"><div class="ch"><span class="ci">&#128295;</span>'
    + '<span class="cname">' + escHtml(m.toolName || "result") + "</span>"
    + '<span class="cprev">' + escHtml(firstLine(text, 64)) + "</span>"
    + '<span class="cchev">&#9656;</span></div><pre>' + escHtml(text) + "</pre></div>";
}

function renderMessage(m) {
  var time = m.ts ? '<span class="mtime">' + fmtTime(m.ts) + "</span>" : "";
  if (m.role === "system") {
    return '<div class="msg role-system"><div class="bubble">' + escHtml(m.text || "") + "</div></div>";
  }
  if (m.role === "tool") {
    return '<div class="msg role-tool">' + renderToolResultChip(m) + "</div>";
  }
  if (m.role === "user") {
    return '<div class="msg role-user"><div class="mrow"><span class="mrole">You</span>' + time + "</div>"
      + '<div class="bubble">' + escHtml(m.text || "") + "</div></div>";
  }
  // assistant
  var inner = "";
  if (m.reasoning) inner += '<div class="reasoning">' + escHtml(m.reasoning) + "</div>";
  if (m.text) inner += escHtml(m.text);
  var body = inner ? '<div class="bubble">' + inner + "</div>" : "";
  var chips = (m.toolCalls || []).map(renderToolCallChip).join("");
  return '<div class="msg role-assistant"><div class="mrow"><span class="mrole">Assistant</span>' + time + "</div>"
    + body + chips + "</div>";
}

function renderTranscript(messages) {
  var el = document.getElementById("transcript");
  var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  el.style.display = "flex";
  document.getElementById("empty-main").style.display = "none";
  var errEl = document.getElementById("error-main");
  if (errEl) errEl.style.display = "none";
  if (messages.length === 0) {
    el.innerHTML = '<div style="color:var(--text2);text-align:center;padding:20px">(empty conversation)</div>';
    return;
  }
  el.innerHTML = messages.map(renderMessage).join("");
  if (atBottom) el.scrollTop = el.scrollHeight;

  var chips = el.querySelectorAll(".chip");
  for (var i = 0; i < chips.length; i++) {
    chips[i].querySelector(".ch").addEventListener("click", (function (chip) {
      return function () { chip.classList.toggle("open"); };
    })(chips[i]));
  }
}

function renderNoConversation(reason) {
  document.getElementById("transcript").style.display = "none";
  document.getElementById("empty-main").style.display = "none";
  var el = document.getElementById("error-main");
  el.style.display = "flex";
  el.innerHTML = '<div class="ico">&#128683;</div><div>No readable conversation for this session'
    + (reason ? '<br><span style="font-size:11px;color:var(--text3)">' + escHtml(reason) + "</span>" : "")
    + "</div>";
}

// ============================================================
// selection + polling
// ============================================================

function clearConvoPoll() {
  if (convoTimer) { clearTimeout(convoTimer); convoTimer = null; }
}

function scheduleConvoPoll() {
  clearConvoPoll();
  var s = findSession(activeId);
  if (!isLive(s)) return;
  convoTimer = setTimeout(function () {
    loadConversation(activeId, { silent: true });
  }, 3500);
}

function loadConversation(id, opts) {
  opts = opts || {};
  var requestedId = id;
  if (!opts.silent) {
    document.getElementById("transcript").style.display = "none";
    document.getElementById("empty-main").style.display = "none";
    var errEl = document.getElementById("error-main");
    errEl.style.display = "flex";
    errEl.innerHTML = '<div class="ico">&#8987;</div><div>Loading\\u2026</div>';
  }
  document.getElementById("status-left").textContent = "loading\\u2026";
  return callApp("conversation_read", { idOrName: id, format: "json" }).then(function (data) {
    if (activeId !== requestedId) return; // switched away meanwhile
    if (!data || !Array.isArray(data.messages)) {
      currentMeta = null;
      renderHeader();
      renderNoConversation(data && data.reason);
      clearConvoPoll();
      document.getElementById("status-left").textContent = "no conversation";
      return;
    }
    currentMeta = data.meta || {};
    lastMessageCount = data.messages.length;
    renderHeader();
    renderTranscript(data.messages);
    document.getElementById("status-left").textContent = data.messages.length + " messages";
    document.getElementById("status-right").textContent = "updated " + fmtTime(Date.now());
    scheduleConvoPoll();
  }).catch(function (e) {
    if (activeId !== requestedId) return;
    document.getElementById("status-left").textContent = "error: " + e.message;
    if (!opts.silent) renderNoConversation(e.message);
  });
}

function selectSession(id) {
  if (activeId === id) return;
  activeId = id;
  currentMeta = null;
  lastMessageCount = -1;
  clearConvoPoll();
  renderSidebar();
  document.getElementById("statusbar").style.display = "flex";
  renderHeader();
  loadConversation(id, {});
}

// ============================================================
// boot
// ============================================================

document.getElementById("refresh-btn").addEventListener("click", function () {
  loadSessions();
  if (activeId) loadConversation(activeId, {});
});
document.getElementById("archived-check").addEventListener("change", function (e) {
  includeArchived = !!e.target.checked;
  loadSessions();
});

window.McpApp.connect()
  .then(function (bridge) {
    callTool = bridge.callTool;
    return loadSessions();
  })
  .then(function () {
    sidebarTimer = setInterval(loadSessions, 5000);
    if (!activeId && sessions.length > 0) selectSession(sessions[0].id);
  })
  .catch(function (err) {
    document.getElementById("empty-main").innerHTML =
      '<div class="ico">&#9888;</div><div>Standalone mode \\u2014 no host bridge (' + escHtml(err.message) + ")</div>";
  });
</script>
</body>
</html>`
