/**
 * HTML bundle for the agentproto work-board panel — the `WORK_BOARD_HTML`
 * served as the `ui://agentproto_work_board/view` resource by
 * `registerMcpApps` (see ../mcp-app-types.ts and runtime's
 * mcp-apps-adapter.ts). Mounted via the `agentproto_work_board` tool defined
 * in ./index.ts.
 *
 * A kanban over the daemon's Task ledger (`packages/runtime/src/
 * task-ledger.ts`) — the one writable multi-party entity the daemon exposes
 * (Activity is a read-only projection; a session has a lifecycle, not an
 * intention). Columns are the ledger's own status enum, folding `cancelled`
 * into the `failed` column (tagged distinctly — see `columnOf` below)
 * rather than adding a fifth column for a status v1 treats as terminal
 * scrap. The board/swimlane selector is the ledger's own board id
 * (`tree:<rootSessionId>` or `ws:<slug>`) — always shown verbatim, never
 * hidden behind a friendly name, per the ledger's scoping model.
 *
 * Protocol: MCP Apps ext spec 2026-01-26
 *   – Bridge: JSON-RPC 2.0 over window.parent.postMessage
 *   – Handshake: ui/initialize → host result → ui/notifications/initialized
 *   – Data: tools/call → task_list (`full: true` — the compact projection
 *     drops `verification`, which the verification tell needs) on a ~4 s poll
 *   – Actions: tools/call → task_claim / task_update / task_create
 *
 * Read-only-safe first: no drag-and-drop. Each card gets the explicit status
 * actions valid from its current state (Claim/Start/Done/Fail/Release/
 * Cancel/Reopen) — a correct read-only-plus-explicit-actions board beats a
 * half-wired drag, per the brief.
 *
 * The verification tell (never render an unverified done as gate-passed):
 *   - `verification.kind === "gate"`   → solid green "✓ gate"
 *   - `verification.kind === "self-report"` → amber outline "self-report"
 *   - `verification.kind === "human"`  → blue "human"
 *   - a declared `verify` with no verification yet → grey "gated" tag
 * An owner-less task always reads "Unclaimed", never "pending" (that word is
 * reserved for the Activity vocabulary's "blocked" meaning elsewhere).
 */

import { panelBridgeScript } from "../panel-bridge.js"

export const WORK_BOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>agentproto work board</title>
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
#board-label{font-size:11px;color:var(--text2)}
#board-id{font-weight:600;color:var(--text);font-size:12px}
#board-input{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:inherit;width:220px}
.tbtn{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}
.tbtn:hover{background:var(--border)}
#new-title{flex:1;min-width:120px;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:inherit}
#columns{flex:1;display:flex;overflow-x:auto;overflow-y:hidden}
.col{width:260px;min-width:220px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid var(--border)}
.col-hdr{padding:8px 10px;border-bottom:1px solid var(--border);background:var(--bg2);font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;display:flex;justify-content:space-between}
.col-body{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:8px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 10px}
.c-title{font-size:12px;font-weight:500;margin-bottom:4px;word-break:break-word}
.c-id{font-size:10px;color:var(--text2);margin-bottom:6px}
.c-row{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:6px}
.tag{display:inline-block;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;white-space:nowrap}
.t-unclaimed{background:rgba(139,148,158,.15);color:var(--text2);border:1px dashed var(--text2)}
.t-owner{background:rgba(88,166,255,.15);color:var(--blue)}
.t-gate{background:rgba(63,185,80,.18);color:var(--green)}
.t-self{background:rgba(210,153,34,.18);color:var(--yellow)}
.t-human{background:rgba(88,166,255,.18);color:var(--blue)}
.t-gated{background:rgba(139,148,158,.12);color:var(--text2)}
.t-cancelled{background:rgba(139,148,158,.12);color:var(--text2)}
.c-err{font-size:10px;color:var(--red);margin-bottom:6px;word-break:break-word}
.c-actions{display:flex;flex-wrap:wrap;gap:4px}
.abtn{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit}
.abtn:hover{background:var(--border)}
.abtn.danger{border-color:var(--red);color:var(--red)}
.abtn.primary{border-color:var(--green);color:var(--green)}
#statusbar{padding:4px 12px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
.empty{padding:16px 8px;color:var(--text2);font-size:11px;text-align:center}
</style>
</head>
<body>
<div id="app">
  <div id="toolbar">
    <span id="board-label">Board:</span>
    <span id="board-id">—</span>
    <input id="board-input" type="text" placeholder="tree:&lt;sessionId&gt; or ws:&lt;slug&gt;">
    <button class="tbtn" id="go-btn">Go</button>
    <button class="tbtn" id="refresh-btn" title="Refresh">&#8635;</button>
    <input id="new-title" type="text" placeholder="New task title&#8230;">
    <button class="tbtn" id="add-btn">+ Add</button>
  </div>
  <div id="columns"></div>
  <div id="statusbar">Connecting to bridge&#8230;</div>
</div>
<script>
${panelBridgeScript("agentproto-work-board-panel")}

// ============================================================
// State
// ============================================================

var COLUMNS = [
  {key: 'pending', label: 'Pending'},
  {key: 'in_progress', label: 'In Progress'},
  {key: 'done', label: 'Done'},
  {key: 'failed', label: 'Failed'}
];

var boardId = null;
var tasks = [];
var pollTimer = null;
var pollActive = false;

function setStatus(msg) {
  document.getElementById('statusbar').textContent = msg;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A cancelled task folds into the Failed column, tagged distinctly — v1
// treats both as terminal scrap, and a fifth column for a rarely-used
// status isn't worth the width.
function columnOf(status) {
  if (status === 'cancelled') return 'failed';
  return status;
}

// ============================================================
// Verification tell — never render an unverified done as gate-passed.
// ============================================================

function verificationTag(t) {
  var v = t.verification;
  if (v) {
    if (v.kind === 'gate') return '<span class="tag t-gate">&#10003; gate</span>';
    if (v.kind === 'self-report') return '<span class="tag t-self">self-report</span>';
    if (v.kind === 'human') return '<span class="tag t-human">human</span>';
  }
  if (t.status === 'in_progress' && t.verify) {
    return '<span class="tag t-gated">gated</span>';
  }
  return '';
}

function ownerTag(t) {
  if (!t.owner) return '<span class="tag t-unclaimed">Unclaimed</span>';
  return '<span class="tag t-owner">' + esc(t.owner) + '</span>';
}

// ============================================================
// Card actions — explicit status moves, no drag-and-drop (read-only-safe
// first: see module docblock).
// ============================================================

function actionsFor(t) {
  var a = [];
  if (t.status === 'pending') {
    if (!t.owner) a.push({label: 'Claim', action: 'claim', cls: 'primary'});
    else a.push({label: 'Start', action: 'start', cls: 'primary'});
    a.push({label: 'Cancel', action: 'cancel', cls: 'danger'});
  } else if (t.status === 'in_progress') {
    a.push({label: 'Done', action: 'done', cls: 'primary'});
    a.push({label: 'Fail', action: 'fail', cls: 'danger'});
    a.push({label: 'Release', action: 'release', cls: ''});
    a.push({label: 'Cancel', action: 'cancel', cls: 'danger'});
  } else if (t.status === 'done') {
    a.push({label: 'Reopen', action: 'reopen', cls: ''});
  }
  return a;
}

function applyAction(taskId, action) {
  var t = null;
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].taskId === taskId) { t = tasks[i]; break; }
  }
  if (!t) return;
  var p;
  if (action === 'claim') {
    p = callTool('task_claim', {taskId: t.taskId, rev: t.rev});
  } else if (action === 'start') {
    p = callTool('task_update', {taskId: t.taskId, rev: t.rev, status: 'in_progress'});
  } else if (action === 'done') {
    p = callTool('task_update', {taskId: t.taskId, rev: t.rev, status: 'done'});
  } else if (action === 'fail') {
    p = callTool('task_update', {taskId: t.taskId, rev: t.rev, status: 'failed'});
  } else if (action === 'release') {
    p = callTool('task_update', {taskId: t.taskId, rev: t.rev, owner: null});
  } else if (action === 'cancel') {
    p = callTool('task_update', {taskId: t.taskId, rev: t.rev, status: 'cancelled'});
  } else if (action === 'reopen') {
    p = callTool('task_update', {taskId: t.taskId, rev: t.rev, status: 'pending'});
  } else {
    return;
  }
  p.then(function (result) {
    if (result && result.conflict) {
      setStatus('Someone else moved "' + t.title + '" first — refreshed.');
    } else if (result && result.error) {
      setStatus('Action failed: ' + result.error);
    } else {
      setStatus('Updated "' + t.title + '".');
    }
    return loadBoard();
  }).catch(function (e) {
    setStatus('Action failed: ' + e.message);
  });
}

// ============================================================
// Render
// ============================================================

function renderCard(t) {
  var html = '<div class="card" data-taskid="' + esc(t.taskId) + '">';
  html += '<div class="c-title">' + esc(t.title) + '</div>';
  html += '<div class="c-id">#' + esc(t.taskId) + '</div>';
  html += '<div class="c-row">' + ownerTag(t) + verificationTag(t);
  if (t.status === 'cancelled') html += '<span class="tag t-cancelled">cancelled</span>';
  html += '</div>';
  if (t.lastVerifyError) {
    html += '<div class="c-err">verify failed: ' + esc(t.lastVerifyError) + '</div>';
  }
  var actions = actionsFor(t);
  if (actions.length > 0) {
    html += '<div class="c-actions">';
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      html += '<button class="abtn ' + a.cls + '" data-taskid="' + esc(t.taskId) + '" data-action="' + a.action + '">' + a.label + '</button>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function render() {
  document.getElementById('board-id').textContent = boardId || '—';
  if (!document.getElementById('board-input').value) {
    document.getElementById('board-input').value = boardId || '';
  }
  var el = document.getElementById('columns');
  var html = '';
  for (var c = 0; c < COLUMNS.length; c++) {
    var col = COLUMNS[c];
    var rows = tasks.filter(function (t) { return columnOf(t.status) === col.key; });
    html += '<div class="col"><div class="col-hdr"><span>' + col.label + '</span><span>' + rows.length + '</span></div><div class="col-body">';
    if (rows.length === 0) {
      html += '<div class="empty">No tasks</div>';
    } else {
      for (var i = 0; i < rows.length; i++) html += renderCard(rows[i]);
    }
    html += '</div></div>';
  }
  el.innerHTML = html;
}

// ============================================================
// Data
// ============================================================

function loadBoard() {
  var args = {includeClosed: true, full: true};
  if (boardId) args.boardId = boardId;
  return callTool('task_list', args).then(function (data) {
    boardId = data.boardId || boardId;
    tasks = data.tasks || [];
    render();
    setStatus(tasks.length + ' task' + (tasks.length === 1 ? '' : 's') + ' · ' + new Date().toLocaleTimeString());
  }).catch(function (e) {
    setStatus('Error: ' + e.message);
  });
}

function doPoll() {
  if (pollActive) return;
  pollActive = true;
  loadBoard().then(function () {
    pollActive = false;
    pollTimer = setTimeout(doPoll, 4000);
  }).catch(function () {
    pollActive = false;
    pollTimer = setTimeout(doPoll, 4000);
  });
}

// ============================================================
// Toolbar wiring
// ============================================================

document.getElementById('columns').addEventListener('click', function (evt) {
  var btn = evt.target.closest ? evt.target.closest('button[data-action]') : null;
  if (!btn) return;
  applyAction(btn.getAttribute('data-taskid'), btn.getAttribute('data-action'));
});

document.getElementById('refresh-btn').addEventListener('click', function () {
  loadBoard();
});

document.getElementById('go-btn').addEventListener('click', function () {
  var v = document.getElementById('board-input').value.trim();
  if (!v) return;
  boardId = v;
  loadBoard();
});

document.getElementById('add-btn').addEventListener('click', function () {
  var input = document.getElementById('new-title');
  var title = input.value.trim();
  if (!title) return;
  var args = {title: title};
  if (boardId) args.boardId = boardId;
  callTool('task_create', args).then(function (result) {
    if (result && result.error) {
      setStatus('Create failed: ' + result.error);
      return;
    }
    input.value = '';
    setStatus('Created "' + title + '".');
    return loadBoard();
  }).catch(function (e) {
    setStatus('Create failed: ' + e.message);
  });
});

// ============================================================
// Boot
// ============================================================

initBridge().then(function () {
  return loadBoard();
}).then(function () {
  pollTimer = setTimeout(doPoll, 4000);
}).catch(function (e) {
  setStatus('Bridge error: ' + e.message);
});
</script>
</body>
</html>`
