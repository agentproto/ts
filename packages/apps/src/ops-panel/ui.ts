/**
 * Ops Panel — a self-contained MCP App panel for `ops-panel`.
 *
 * The daemon operations cockpit: special durable sessions (Session Watchdog,
 * Sessions Manager) as launchable cards, the session list filterable by
 * workspace with lifecycle actions, housekeeping (session GC, worktree GC)
 * and the cron ledger. Talks to the daemon only through the
 * `window.McpApp.connect()` bridge — every action round-trips through
 * `app_tool_call { appId, tool, args }`, gated by {@link OPS_PANEL_TOOLS}
 * (same convention as `session-viewer`).
 *
 * Special-session recognition is by spawn label (`Session Watchdog` /
 * `Sessions Manager` — see `agents/`): the panel finds the newest session
 * wearing the label, shows its status, and offers Launch / Restart / Kill.
 * Launching the watchdog also (re)wires its `watchdog-tick` cron — the
 * `prompt-session` job that re-prompts the durable session every 5 minutes —
 * deleting any stale tick first so a dead session id never keeps a failing
 * cron behind.
 */

import { manager, MANAGER_LABEL } from "./agents/manager.js"
import {
  watchdog,
  WATCHDOG_LABEL,
  WATCHDOG_TICK_LABEL,
  WATCHDOG_TICK_PROMPT,
  WATCHDOG_TICK_SCHEDULE,
} from "./agents/watchdog.js"

export const OPS_PANEL_TOOLS = [
  "daemon_health",
  "session_list",
  "agent_start",
  "agent_prompt",
  "agent_kill",
  "session_restart",
  "session_archive",
  "session_gc",
  "cron_list",
  "cron_create",
  "cron_delete",
  "cron_run",
  "worktree_gc",
] as const

const APP_ID = "@agentproto/ops-panel"

/** What the panel needs to launch each special session, injected below. */
const SPECIALS = [
  {
    key: "watchdog",
    label: WATCHDOG_LABEL,
    tagline: "Health ticks every 5 min — flags, archives, never kills.",
    prompt: watchdog.body ?? "",
    cron: {
      label: WATCHDOG_TICK_LABEL,
      schedule: WATCHDOG_TICK_SCHEDULE,
      prompt: WATCHDOG_TICK_PROMPT,
    },
  },
  {
    key: "manager",
    label: MANAGER_LABEL,
    tagline: "You talk to it, it drives the other sessions.",
    prompt: manager.body ?? "",
    cron: null,
  },
] as const

export const OPS_PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ops Panel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#e6edf3;--text2:#8b949e;--text3:#6e7681;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;background:var(--bg);color:var(--text)}
#app{display:flex;flex-direction:column;height:100%;overflow:hidden}

#topbar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0}
#topbar h1{font-size:13px;font-weight:700;letter-spacing:.02em}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;background:var(--bg3);border:1px solid var(--border);color:var(--text2);padding:3px 9px;border-radius:999px}
.chip .d{width:7px;height:7px;border-radius:50%;background:var(--text3);flex:none}
.chip.ok .d{background:var(--green)}
.chip.bad .d{background:var(--red)}
#ws-select{margin-left:auto;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11.5px;font-family:inherit}
#refresh-btn{background:none;border:1px solid var(--border);cursor:pointer;color:var(--text2);font-size:13px;line-height:1;padding:4px 8px;border-radius:6px;font-family:inherit}
#refresh-btn:hover{color:var(--text);background:var(--bg3)}

#body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:16px}
.sect h2{font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;display:flex;align-items:center;gap:8px}
.sect h2 .count{font-weight:600;color:var(--text3);text-transform:none;letter-spacing:0}

#specials{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px}
.card .ct{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700}
.card .tagline{font-size:11px;color:var(--text2);margin-top:3px}
.card .meta{font-size:10.5px;color:var(--text3);margin-top:7px;display:flex;flex-wrap:wrap;gap:5px 10px}
.card .cronline{font-size:10.5px;margin-top:7px;display:flex;align-items:center;gap:6px;color:var(--text2)}
.card .actions{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}

.badge{display:inline-block;padding:1px 6px;border-radius:10px;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.02em}
.b-run{background:rgba(63,185,80,.15);color:var(--green)}
.b-busy{background:rgba(63,185,80,.25);color:var(--green)}
.b-wait{background:rgba(88,166,255,.15);color:var(--blue)}
.b-idle{background:rgba(139,148,158,.12);color:var(--text2)}
.b-end{background:rgba(139,148,158,.1);color:var(--text3)}
.b-err{background:rgba(248,81,73,.15);color:var(--red)}
.b-warn{background:rgba(210,153,34,.15);color:var(--yellow)}

button.act{background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;cursor:pointer;font-family:inherit}
button.act:hover{border-color:var(--text3)}
button.act.primary{background:rgba(88,166,255,.15);border-color:rgba(88,166,255,.4);color:var(--blue)}
button.act.danger{color:var(--red)}
button.act.danger:hover{border-color:var(--red)}
button.act.confirm{background:rgba(248,81,73,.2);border-color:var(--red);color:var(--red)}
button.act:disabled{opacity:.45;cursor:default}

table{width:100%;border-collapse:collapse}
th{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)}
td{font-size:11.5px;padding:6px 8px;border-bottom:1px solid var(--bg3);vertical-align:middle}
tr:hover td{background:var(--bg2)}
td .sn{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;display:block}
td .sid{font-size:10px;color:var(--text3);font-family:Menlo,Monaco,monospace}
.ws-tag{display:inline-block;font-size:10px;font-weight:600;background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--text2)}
td.actions{white-space:nowrap;text-align:right}
td.actions button{margin-left:4px}

.hk{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
.hk .card .nums{display:flex;gap:14px;margin-top:8px}
.hk .num{display:flex;flex-direction:column}
.hk .num b{font-size:17px;font-weight:700}
.hk .num span{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em}

#toast{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 14px;font-size:11.5px;display:none;max-width:80%;z-index:10}
#toast.err{border-color:var(--red);color:var(--red)}
.empty{color:var(--text3);font-size:11.5px;padding:8px}
</style>
</head>
<body>
<div id="app">
  <div id="topbar">
    <h1>Agentproto Ops</h1>
    <span class="chip" id="daemon-chip"><span class="d"></span><span id="daemon-txt">daemon&hellip;</span></span>
    <select id="ws-select"><option value="">all workspaces</option></select>
    <button id="refresh-btn" title="Refresh" type="button">&#8635; refresh</button>
  </div>
  <div id="body">
    <div class="sect">
      <h2>Special sessions</h2>
      <div id="specials"></div>
    </div>
    <div class="sect">
      <h2>Sessions <span class="count" id="sess-count"></span></h2>
      <div id="sessions"></div>
    </div>
    <div class="sect">
      <h2>Housekeeping</h2>
      <div class="hk" id="housekeeping"></div>
    </div>
    <div class="sect">
      <h2>Crons <span class="count" id="cron-count"></span></h2>
      <div id="crons"></div>
    </div>
  </div>
</div>
<div id="toast"></div>
<script>
var callTool = null;
var APP_ID = ${JSON.stringify(APP_ID)};
var SPECIALS = ${JSON.stringify(SPECIALS)};

// app_tool_call wraps its dispatch result at least once (its own text-result
// body is the JSON-stringified inner MCP tool result); peel back through
// nested {content:[{type:"text",text:...}]} shells until the payload stops
// looking like one — same convention as session-viewer.
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

var toastTimer = null;
function toast(msg, isErr) {
  var el = document.getElementById("toast");
  el.textContent = msg;
  el.className = isErr ? "err" : "";
  el.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.style.display = "none"; }, isErr ? 6000 : 3000);
}

// Two-click confirm: first click arms the button, second within 4s fires.
var armed = {};
function confirmClick(key, btn, fn) {
  if (armed[key]) {
    clearTimeout(armed[key].t);
    delete armed[key];
    fn();
    return;
  }
  var prev = btn.textContent;
  btn.classList.add("confirm");
  btn.textContent = "sure?";
  armed[key] = { t: setTimeout(function () {
    delete armed[key];
    btn.classList.remove("confirm");
    btn.textContent = prev;
  }, 4000) };
}

// ============================================================
// state
// ============================================================

var sessions = [];
var crons = [];
var wsFilter = "";
var pollTimer = null;
var busyActions = false;

function isLive(s) { return !!s && (s.status === "running" || s.status === "starting"); }

function displayBadge(s) {
  if (s.status === "running") {
    if (s.busy) return { label: "working", cls: "b-busy" };
    if (s.awaitingInput) return { label: "waiting", cls: "b-wait" };
    return { label: "idle", cls: "b-idle" };
  }
  if (s.status === "starting") return { label: "starting", cls: "b-wait" };
  if (s.status === "error" || s.status === "killed") return { label: s.status, cls: "b-err" };
  return { label: s.status || "exited", cls: "b-end" };
}

function labelOf(s) {
  return s.label || s.title || s.name || (s.command ? String(s.command).split("/").pop() : null) || s.id;
}

function specialSessionFor(sp) {
  var best = null;
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    if ((s.label || s.title) !== sp.label) continue;
    if (!best) { best = s; continue; }
    // Prefer a live one; among equals prefer the newest.
    if (isLive(s) && !isLive(best)) { best = s; continue; }
    if (isLive(s) === isLive(best) && String(s.startedAt) > String(best.startedAt)) best = s;
  }
  return best;
}

function cronByLabel(label) {
  var hits = [];
  for (var i = 0; i < crons.length; i++) if (crons[i].label === label) hits.push(crons[i]);
  return hits;
}

// ============================================================
// data loading
// ============================================================

function loadAll() {
  return Promise.all([
    callApp("session_list", { kind: "all" }).then(function (d) {
      sessions = (d && d.sessions) || (Array.isArray(d) ? d : []);
    }),
    callApp("cron_list", {}).then(function (d) {
      crons = Array.isArray(d) ? d : (d && d.jobs) || [];
    }).catch(function () { crons = []; }),
  ]).then(function () {
    renderWorkspaces();
    renderSpecials();
    renderSessions();
    renderCrons();
    updateHousekeepingNums();
  });
}

function loadHealth() {
  return callApp("daemon_health", {}).then(function (d) {
    var chip = document.getElementById("daemon-chip");
    chip.className = "chip ok";
    var v = (d && (d.version || (d.build && d.build.sha) || d.status)) || "ok";
    document.getElementById("daemon-txt").textContent = "daemon " + String(v).slice(0, 16);
  }).catch(function (e) {
    var chip = document.getElementById("daemon-chip");
    chip.className = "chip bad";
    document.getElementById("daemon-txt").textContent = "daemon unreachable";
  });
}

// Housekeeping card is built ONCE (so the worktree plan text and armed
// confirm buttons survive the 5s poll); only the counters re-render — see
// updateHousekeepingNums. The worktree plan is a separate dry-run call, on
// demand only (it walks git state — not something to hammer on every poll).
function buildHousekeeping() {
  var el = document.getElementById("housekeeping");
  el.innerHTML =
    '<div class="card"><div class="ct">Sessions GC</div>'
    + '<div class="nums" id="gc-nums"></div>'
    + '<div class="actions">'
    + '<button class="act" id="gc-archive">Archive &gt;7d</button>'
    + '<button class="act danger" id="gc-forget">Forget &gt;30d</button>'
    + '</div></div>'
    + '<div class="card"><div class="ct">Worktrees</div>'
    + '<div class="meta" id="wt-plan">No plan yet — run a dry run.</div>'
    + '<div class="actions">'
    + '<button class="act" id="wt-dry">Dry run</button>'
    + '<button class="act danger" id="wt-apply" disabled>Reclaim now</button>'
    + '</div></div>';

  document.getElementById("gc-archive").addEventListener("click", function () {
    runAction("session_gc", { olderThanDays: 7 }, "GC: archived old terminal sessions");
  });
  var forgetBtn = document.getElementById("gc-forget");
  forgetBtn.addEventListener("click", function () {
    confirmClick("gc-forget", forgetBtn, function () {
      runAction("session_gc", { olderThanDays: 30, forget: true }, "GC: forgot >30d terminal sessions");
    });
  });
  document.getElementById("wt-dry").addEventListener("click", function () { worktreePlan(false); });
  var applyBtn = document.getElementById("wt-apply");
  applyBtn.addEventListener("click", function () {
    confirmClick("wt-apply", applyBtn, function () { worktreePlan(true); });
  });
  updateHousekeepingNums();
}

function updateHousekeepingNums() {
  var el = document.getElementById("gc-nums");
  if (!el) return;
  var terminal = 0, live = 0;
  for (var i = 0; i < sessions.length; i++) {
    if (isLive(sessions[i])) live++;
    else terminal++;
  }
  el.innerHTML =
    '<div class="num"><b>' + live + '</b><span>live</span></div>'
    + '<div class="num"><b>' + terminal + '</b><span>terminal</span></div>';
}

function worktreePlan(apply) {
  var el = document.getElementById("wt-plan");
  el.textContent = apply ? "reclaiming\\u2026" : "planning\\u2026";
  callApp("worktree_gc", apply ? { apply: true } : {}).then(function (d) {
    var entries = (d && (d.plan || d.entries || d.worktrees)) || [];
    var counts = { reclaim: 0, salvage: 0, hold: 0 };
    for (var i = 0; i < entries.length; i++) {
      var c = entries[i].classification || entries[i].class || entries[i].action;
      if (counts[c] != null) counts[c]++;
    }
    el.textContent = (apply ? "applied — " : "dry run — ")
      + counts.reclaim + " reclaim / " + counts.salvage + " salvage / " + counts.hold + " hold"
      + (entries.length === 0 ? " (no linked worktrees)" : "");
    document.getElementById("wt-apply").disabled = counts.reclaim === 0 || apply;
    if (apply) toast("Worktree GC applied");
  }).catch(function (e) {
    el.textContent = "worktree_gc: " + e.message;
  });
}

// ============================================================
// rendering
// ============================================================

function renderWorkspaces() {
  var sel = document.getElementById("ws-select");
  var seen = {};
  var slugs = [];
  for (var i = 0; i < sessions.length; i++) {
    var w = sessions[i].workspaceSlug;
    if (w && !seen[w]) { seen[w] = true; slugs.push(w); }
  }
  slugs.sort();
  var cur = wsFilter;
  var html = '<option value="">all workspaces</option>';
  for (var j = 0; j < slugs.length; j++) {
    html += '<option value="' + escHtml(slugs[j]) + '"' + (slugs[j] === cur ? " selected" : "") + '>' + escHtml(slugs[j]) + "</option>";
  }
  sel.innerHTML = html;
}

function renderSpecials() {
  var el = document.getElementById("specials");
  var html = "";
  for (var i = 0; i < SPECIALS.length; i++) {
    var sp = SPECIALS[i];
    var s = specialSessionFor(sp);
    var badge = s ? displayBadge(s) : { label: "not running", cls: "b-end" };
    var meta = "";
    if (s) {
      meta += "<span>" + escHtml(s.id) + "</span>";
      if (s.startedAt) meta += "<span>started " + escHtml(fmtRelative(s.startedAt)) + "</span>";
      if (s.costUsd != null) meta += "<span>$" + Number(s.costUsd).toFixed(2) + "</span>";
    }
    var cronline = "";
    if (sp.cron) {
      var jobs = cronByLabel(sp.cron.label);
      if (jobs.length === 0) {
        cronline = '<span class="badge b-end">no cron</span> tick not scheduled';
      } else {
        var job = jobs[0];
        var ok = !job.lastResult || job.lastResult.ok;
        var pointsAt = job.action && job.action.sessionId;
        var stale = s && isLive(s) && pointsAt && pointsAt !== s.id;
        cronline = '<span class="badge ' + (job.active ? (ok && !stale ? "b-run" : "b-warn") : "b-end") + '">'
          + (job.active ? (ok && !stale ? "tick ok" : (stale ? "tick stale" : "tick failing")) : "tick off") + "</span> "
          + escHtml(job.schedule) + (pointsAt ? " &rarr; " + escHtml(pointsAt) : "")
          + (!ok && job.lastResult && job.lastResult.summary ? " &middot; " + escHtml(String(job.lastResult.summary).slice(0, 60)) : "");
      }
    }
    var actions = "";
    if (!s || !isLive(s)) {
      actions += '<button class="act primary" data-sp="' + sp.key + '" data-do="launch">Launch</button>';
      if (s) actions += '<button class="act" data-sp="' + sp.key + '" data-do="restart">Restart last</button>';
    } else {
      if (sp.cron) {
        actions += '<button class="act" data-sp="' + sp.key + '" data-do="tick">Tick now</button>';
        actions += '<button class="act" data-sp="' + sp.key + '" data-do="fixcron">Re-wire cron</button>';
      } else {
        actions += '<button class="act" data-sp="' + sp.key + '" data-do="tick">Ping</button>';
      }
      actions += '<button class="act danger" data-sp="' + sp.key + '" data-do="kill">Kill</button>';
    }
    html += '<div class="card">'
      + '<div class="ct">' + escHtml(sp.label) + ' <span class="badge ' + badge.cls + '">' + escHtml(badge.label) + "</span></div>"
      + '<div class="tagline">' + escHtml(sp.tagline) + "</div>"
      + (meta ? '<div class="meta">' + meta + "</div>" : "")
      + (cronline ? '<div class="cronline">' + cronline + "</div>" : "")
      + '<div class="actions">' + actions + "</div>"
      + "</div>";
  }
  el.innerHTML = html;
  var btns = el.querySelectorAll("button[data-sp]");
  for (var k = 0; k < btns.length; k++) {
    (function (btn) {
      btn.addEventListener("click", function () { specialAction(btn.getAttribute("data-sp"), btn.getAttribute("data-do"), btn); });
    })(btns[k]);
  }
}

function renderSessions() {
  var el = document.getElementById("sessions");
  var rows = [];
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    if (wsFilter && s.workspaceSlug !== wsFilter) continue;
    rows.push(s);
  }
  rows.sort(function (a, b) {
    var la = isLive(a) ? 1 : 0, lb = isLive(b) ? 1 : 0;
    if (la !== lb) return lb - la;
    return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
  });
  var liveCount = 0;
  for (var c = 0; c < rows.length; c++) if (isLive(rows[c])) liveCount++;
  document.getElementById("sess-count").textContent = liveCount + " live / " + rows.length + " shown";
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty">No sessions' + (wsFilter ? " in " + escHtml(wsFilter) : "") + ".</div>";
    return;
  }
  var html = "<table><thead><tr><th>Session</th><th>Workspace</th><th>Status</th><th>Started</th><th>Cost</th><th></th></tr></thead><tbody>";
  var shown = rows.slice(0, 80);
  for (var j = 0; j < shown.length; j++) {
    var s2 = shown[j];
    var db = displayBadge(s2);
    var acts = "";
    if (isLive(s2)) {
      acts += '<button class="act danger" data-id="' + escHtml(s2.id) + '" data-do="kill">Kill</button>';
    } else {
      acts += '<button class="act" data-id="' + escHtml(s2.id) + '" data-do="restart">Restart</button>';
      if (!s2.archived) acts += '<button class="act" data-id="' + escHtml(s2.id) + '" data-do="archive">Archive</button>';
    }
    html += "<tr>"
      + '<td><span class="sn" title="' + escHtml(labelOf(s2)) + '">' + escHtml(labelOf(s2)) + '</span><span class="sid">' + escHtml(s2.id) + "</span></td>"
      + "<td>" + (s2.workspaceSlug ? '<span class="ws-tag">' + escHtml(s2.workspaceSlug) + "</span>" : "") + "</td>"
      + '<td><span class="badge ' + db.cls + '">' + escHtml(db.label) + "</span></td>"
      + "<td>" + escHtml(fmtRelative(s2.startedAt)) + "</td>"
      + "<td>" + (s2.costUsd != null ? "$" + Number(s2.costUsd).toFixed(2) : "") + "</td>"
      + '<td class="actions">' + acts + "</td>"
      + "</tr>";
  }
  html += "</tbody></table>";
  if (rows.length > shown.length) html += '<div class="empty">&hellip; ' + (rows.length - shown.length) + " more (narrow with the workspace filter)</div>";
  el.innerHTML = html;
  var btns = el.querySelectorAll("button[data-id]");
  for (var k = 0; k < btns.length; k++) {
    (function (btn) {
      btn.addEventListener("click", function () { sessionAction(btn.getAttribute("data-id"), btn.getAttribute("data-do"), btn); });
    })(btns[k]);
  }
}

function renderCrons() {
  var el = document.getElementById("crons");
  document.getElementById("cron-count").textContent = crons.length ? crons.length + " jobs" : "";
  if (crons.length === 0) {
    el.innerHTML = '<div class="empty">No cron jobs.</div>';
    return;
  }
  var html = "<table><thead><tr><th>Label</th><th>Schedule</th><th>State</th><th>Last</th><th>Next</th><th></th></tr></thead><tbody>";
  for (var i = 0; i < crons.length; i++) {
    var c = crons[i];
    var last = c.lastResult == null ? "" : (c.lastResult.ok ? "ok" : "failed");
    var lastCls = c.lastResult == null ? "b-end" : (c.lastResult.ok ? "b-run" : "b-err");
    html += "<tr>"
      + '<td><span class="sn">' + escHtml(c.label || c.id) + "</span></td>"
      + "<td>" + escHtml(c.schedule) + "</td>"
      + '<td><span class="badge ' + (c.active ? "b-run" : "b-end") + '">' + (c.active ? "active" : "off") + "</span></td>"
      + "<td>" + (last ? '<span class="badge ' + lastCls + '" title="' + escHtml((c.lastResult && c.lastResult.summary) || "") + '">' + last + "</span>" : "") + "</td>"
      + "<td>" + escHtml(c.nextRunAt ? fmtRelative(c.nextRunAt).replace(" ago", "") : "") + "</td>"
      + '<td class="actions">'
      + '<button class="act" data-cron="' + escHtml(c.id) + '" data-do="run">Run</button>'
      + '<button class="act danger" data-cron="' + escHtml(c.id) + '" data-do="delete">Delete</button>'
      + "</td></tr>";
  }
  html += "</tbody></table>";
  el.innerHTML = html;
  var btns = el.querySelectorAll("button[data-cron]");
  for (var k = 0; k < btns.length; k++) {
    (function (btn) {
      btn.addEventListener("click", function () { cronAction(btn.getAttribute("data-cron"), btn.getAttribute("data-do"), btn); });
    })(btns[k]);
  }
}

// ============================================================
// actions
// ============================================================

function runAction(tool, args, okMsg) {
  if (busyActions) return Promise.resolve();
  busyActions = true;
  return callApp(tool, args).then(function (d) {
    busyActions = false;
    if (okMsg) toast(okMsg);
    return loadAll().then(function () { return d; });
  }).catch(function (e) {
    busyActions = false;
    toast(tool + ": " + e.message, true);
    throw e;
  });
}

function findSpecial(key) {
  for (var i = 0; i < SPECIALS.length; i++) if (SPECIALS[i].key === key) return SPECIALS[i];
  return null;
}

function rewireTickCron(sp, sessionId) {
  if (!sp.cron) return Promise.resolve();
  var stale = cronByLabel(sp.cron.label);
  var chain = Promise.resolve();
  for (var i = 0; i < stale.length; i++) {
    (function (jobId) {
      chain = chain.then(function () { return callApp("cron_delete", { jobId: jobId }); });
    })(stale[i].id);
  }
  return chain.then(function () {
    return callApp("cron_create", {
      schedule: sp.cron.schedule,
      recurring: true,
      label: sp.cron.label,
      action: { kind: "prompt-session", sessionId: sessionId, prompt: sp.cron.prompt },
    });
  });
}

function specialAction(key, what, btn) {
  var sp = findSpecial(key);
  if (!sp) return;
  var s = specialSessionFor(sp);
  if (what === "launch") {
    btn.disabled = true;
    callApp("agent_start", {
      adapter: "claude-code",
      label: sp.label,
      prompt: sp.prompt,
      keepAlive: true,
    }).then(function (d) {
      var id = d && d.id;
      toast(sp.label + " launched" + (id ? " (" + id + ")" : ""));
      return id && sp.cron ? rewireTickCron(sp, id) : null;
    }).then(function () { return loadAll(); })
      .catch(function (e) { toast("launch: " + e.message, true); btn.disabled = false; });
    return;
  }
  if (what === "restart" && s) {
    btn.disabled = true;
    callApp("session_restart", { idOrName: s.id }).then(function (d) {
      var id = (d && d.id) || s.id;
      toast(sp.label + " restarted");
      return sp.cron ? rewireTickCron(sp, id) : null;
    }).then(function () { return loadAll(); })
      .catch(function (e) { toast("restart: " + e.message, true); btn.disabled = false; });
    return;
  }
  if (what === "tick" && s) {
    var prompt = sp.cron ? sp.cron.prompt : "Status check: report where things stand, briefly.";
    runAction("agent_prompt", { sessionId: s.id, prompt: prompt }, sp.label + " prompted");
    return;
  }
  if (what === "fixcron" && s) {
    btn.disabled = true;
    rewireTickCron(sp, s.id).then(function () {
      toast("Cron re-wired to " + s.id);
      return loadAll();
    }).catch(function (e) { toast("cron: " + e.message, true); btn.disabled = false; });
    return;
  }
  if (what === "kill" && s) {
    confirmClick("kill-" + s.id, btn, function () {
      runAction("agent_kill", { sessionId: s.id }, sp.label + " killed");
    });
  }
}

function sessionAction(id, what, btn) {
  if (what === "kill") {
    confirmClick("kill-" + id, btn, function () {
      runAction("agent_kill", { sessionId: id }, "Killed " + id);
    });
    return;
  }
  if (what === "restart") { runAction("session_restart", { idOrName: id }, "Restarted " + id); return; }
  if (what === "archive") { runAction("session_archive", { idOrName: id }, "Archived " + id); }
}

function cronAction(jobId, what, btn) {
  if (what === "run") { runAction("cron_run", { jobId: jobId }, "Cron fired"); return; }
  if (what === "delete") {
    confirmClick("cron-" + jobId, btn, function () {
      runAction("cron_delete", { jobId: jobId }, "Cron deleted");
    });
  }
}

// ============================================================
// boot
// ============================================================

document.getElementById("refresh-btn").addEventListener("click", function () { loadHealth(); loadAll(); });
document.getElementById("ws-select").addEventListener("change", function (e) {
  wsFilter = e.target.value;
  renderSessions();
});

window.McpApp.connect()
  .then(function (bridge) {
    callTool = bridge.callTool;
    buildHousekeeping();
    loadHealth();
    return loadAll();
  })
  .then(function () {
    pollTimer = setInterval(loadAll, 5000);
  })
  .catch(function (err) {
    document.getElementById("body").innerHTML =
      '<div class="empty">Standalone mode \\u2014 no host bridge (' + escHtml(err.message) + ")</div>";
  });
</script>
</body>
</html>`
