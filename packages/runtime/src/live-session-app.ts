/**
 * McpApp definition for the live-session widget — a two-pane panel (left:
 * live session tree, right: streaming timeline) that lets a host attach to
 * any running agent session and watch it work in real time.
 *
 * Forked structurally from terminal-panel-app.ts: same AgnoMcpApp contract
 * and "static ui:// resource renders with empty
 * initData, widget self-bootstraps via tools/call" pattern. Unlike the
 * terminal (one WebSocket, one PTY), this widget has two independent data
 * needs — a polled tree snapshot and a per-session event timeline — so it
 * layers on top of the bridge rather than replacing it with a single socket.
 *
 * Data paths (see `.plans/CONTRACT.md` §WP-B):
 *   LEFT  (tree):     poll `app_session_tree` via `callTool` every ~2s.
 *   RIGHT (timeline):  PRIMARY = `EventSource` on `/sessions/:id/events/stream`
 *                      (opportunistic — falls back if it doesn't open/emit
 *                      within ~2.5s); FALLBACK = poll `app_session_events`
 *                      via `callTool` every ~1.5s, advancing `since`.
 *   Both app_* tools are registered by WP-A (`app-pull-tools.ts`) and are
 *   `visibility: ["app"]`-only, i.e. reachable solely over this bridge.
 *
 * The timeline reducer lives in `live-session-app.logic.ts` as a pure,
 * dependency-free module so it's unit-testable outside the browser. This
 * file inlines a hand-kept COPY of that same logic into the HTML bundle
 * (see "INLINED REDUCER COPY" below) since the widget ships as one
 * self-contained script with no bundler step. Keep the two in sync. Its MCP
 * Apps handshake comes from the shared spec-correct panel bridge.
 *
 * Rendering (WP1): the timeline body is patched INCREMENTALLY — a
 * text-delta that merges into the last row patches only that row's text
 * node (found via `data-row-id`); every other new row is appended with one
 * `insertAdjacentHTML`. A full `innerHTML` reset happens only on session
 * start/`setFocus()` and on display-mode switches. Auto-scroll decision is
 * `isNearBottom` (inlined copy, SPEC §2) captured BEFORE any DOM mutation:
 * stick to bottom when the user was at the bottom, otherwise preserve the
 * read position exactly and surface a "new messages" pill.
 *
 * Compact mode (WP3/WP4): when `hostContext.displayMode === 'inline'` (or
 * the viewport is under ~640px) the tree pane collapses into a header
 * `<select>` (WP4) and the timeline renders through `groupAdjacentToolCalls`
 * (inlined copy, SPEC §3) with a colour rail and collapsible tool-call
 * groups. `setFocus()` remains the only session-switch entry point.
 */

import { z } from "zod"
import { panelBridgeScript } from "./panel-bridge.js"
import type { AgnoMcpApp } from "./sessions-panel-app.js"

export const liveSessionInputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe(
      "Attach the widget to an existing session by id or name. Omit to " +
        "self-discover the newest running session from the tree.",
    ),
})

export type LiveSessionInput = z.infer<typeof liveSessionInputSchema>

export type LiveSessionOutput = {
  /** Echoes the input id, or undefined to let the widget self-discover a
   *  focus session client-side from `app_session_tree`. */
  sessionId?: string
  /** The daemon's own HTTP origin — connection recipe for both the SSE
   *  stream and the bridge's `tools/call` fallback. */
  httpBaseUrl: string
}

export interface LiveSessionOps {
  /** The daemon's own HTTP origin, e.g. "http://127.0.0.1:18790". Defaults
   *  to the daemon's documented default port (`index.ts:776`) so the app
   *  works out of the box in the common single-daemon case. */
  httpBaseUrl?: string
}

/**
 * Factory: close over the daemon's own HTTP origin so execute() needs
 * nothing beyond the tool input (no registry access — mirrors
 * sessions-panel-app.ts/terminal-panel-app.ts; the app_* tools this widget
 * calls over the bridge are what actually touch the registry).
 */
export function makeLiveSessionApp(
  ops?: LiveSessionOps,
): AgnoMcpApp<LiveSessionInput, LiveSessionOutput> {
  const httpBaseUrl = ops?.httpBaseUrl ?? "http://127.0.0.1:18790"
  // `new URL(...).origin` normalises the base URL to the exact connectDomains
  // entry the CSP allowlist needs (same derivation as terminal-panel-app.ts's
  // wsOrigin), covering both the SSE EventSource and any bridge fallback.
  const httpOrigin = new URL(httpBaseUrl).origin

  return {
    id: "live_session",
    title: "Live Session",
    description:
      "Open the live session widget — a two-pane view of a running agent " +
      "session: a live tree on the left, a streaming timeline (text, tool " +
      "calls/results, turn-end) on the right. Omit `sessionId` to " +
      "attach to the newest running session; pass one to attach directly.",
    inputSchema: liveSessionInputSchema,
    execute: async input => ({
      sessionId: input.sessionId,
      httpBaseUrl,
    }),
    html: (initData: LiveSessionOutput) => LIVE_SESSION_HTML(initData),
    csp: { connectDomains: [httpOrigin] },
  }
}

// ── HTML bundle (zero CDN, self-contained) ──────────────────────────────────

function LIVE_SESSION_HTML(initData: LiveSessionOutput): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>agentproto live session</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#e6edf3;--text2:#8b949e;--text3:#6e7681;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
}
html,body{height:100%;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;background:var(--bg);color:var(--text);overflow:hidden}
#app{display:flex;height:100%}
#tree-pane{width:280px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--bg2)}
#tree-head{padding:10px 12px;border-bottom:1px solid var(--border);font-weight:600;font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;flex-shrink:0}
#tree-body{flex:1;overflow-y:auto;padding:6px}
#timeline-pane{flex:1;display:flex;flex-direction:column;min-width:0;position:relative}
#timeline-head{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0}
#timeline-head .focus-id{font-weight:600;font-size:13px;font-family:Menlo,Monaco,monospace}
#head-summary{margin-left:auto;font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;min-width:0}
#head-summary .sdot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:3px;vertical-align:1px}
#head-summary .sdot.running{background:var(--green)}
#head-summary .sdot.grey{background:var(--text3)}
#head-summary .sdot.error{background:var(--red)}
#usage-chip{font-size:10.5px;font-family:Menlo,Monaco,monospace;background:var(--bg3);border-radius:4px;padding:1px 6px;color:var(--text)}
#status-line{margin-left:8px;font-size:11px;color:var(--text2);flex-shrink:0}
#timeline-body{flex:1;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:8px}
#head-selector{display:none;max-width:42%;font:inherit;font-size:12px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:2px 4px}
#new-pill{display:none;position:absolute;right:14px;bottom:12px;z-index:6;background:var(--blue);color:#0d1117;border:none;font-size:11px;font-weight:700;padding:5px 11px;border-radius:12px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4)}
#new-pill.show{display:block}

/* WP3 compact mode — colour rail + tighter rows; only under body.compact-mode
   (displayMode 'inline' or narrow viewport). fullscreen/pip keep the cards. */
body.compact-mode #tree-pane{display:none}
body.compact-mode #head-selector{display:inline-block}
body.compact-mode #focus-id-label{display:none}
body.compact-mode .row{border-radius:6px;padding:5px 8px;border-left-width:3px}
body.compact-mode .row.text{border-left-color:var(--blue)}
body.compact-mode .row.tool-call{border-left-color:var(--yellow)}
body.compact-mode .row.turn-end{border-left-color:var(--purple)}
body.compact-mode .row .body{font-size:12px;margin-top:3px}
body.compact-mode .row .rhead{font-size:10px}
details.tool-group{border:1px solid var(--border);border-radius:8px;background:var(--bg2);padding:5px 8px;border-left:3px solid var(--yellow)}
details.tool-group>summary{cursor:pointer;font-size:11px;color:var(--text2);font-weight:600;list-style:none}
details.tool-group[open]>summary{margin-bottom:6px}
details.tool-group .row{margin-top:5px}

.tnode{border-radius:6px;cursor:pointer;padding:5px 8px;margin:1px 0;display:flex;align-items:center;gap:7px;font-size:12px}
.tnode:hover{background:var(--bg3)}
.tnode.focus{background:var(--bg3);outline:1px solid var(--blue)}
.tnode .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot.running{background:var(--green)}
.dot.grey{background:var(--text3)}
.dot.error{background:var(--red)}
.tnode .label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:Menlo,Monaco,monospace}
.tnode .badge{font-size:9px;font-weight:700;color:var(--purple);border:1px solid var(--purple);border-radius:3px;padding:0 4px;flex-shrink:0}
.tchildren{margin-left:14px;border-left:1px solid var(--border);padding-left:4px}
#tree-empty{padding:12px;color:var(--text3);font-size:12px}

.row{border:1px solid var(--border);border-radius:8px;background:var(--bg2);padding:8px 10px}
.row .rhead{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text2)}
.row .kind{font-weight:700;text-transform:uppercase;letter-spacing:.03em;font-size:10px}
.row.text .kind{color:var(--blue)}
.row.tool-call .kind{color:var(--yellow)}
.row.turn-end .kind{color:var(--purple)}
.row .body{margin-top:5px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.row.text .body{font-family:inherit}
.row.tool-call .toolname{font-family:Menlo,Monaco,monospace;font-weight:600}
.status-badge{font-size:9px;font-weight:700;border-radius:3px;padding:1px 5px;margin-left:6px}
.status-badge.pending{background:var(--bg3);color:var(--text2)}
.status-badge.ok{background:#0f3d20;color:var(--green)}
.status-badge.error{background:#3d1418;color:var(--red)}
.row details{margin-top:6px}
.row summary{cursor:pointer;font-size:11px;color:var(--text2)}
.row pre{margin-top:4px;font-family:Menlo,Monaco,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--text2);background:var(--bg);border-radius:5px;padding:6px 8px;max-height:200px;overflow:auto}
.chip{display:inline-block;font-size:10.5px;font-family:Menlo,Monaco,monospace;background:var(--bg3);border-radius:4px;padding:2px 6px}
#timeline-empty{color:var(--text3);font-size:12px;padding:8px 2px}
</style>
</head>
<body>
<div id="app">
  <div id="tree-pane">
    <div id="tree-head">Sessions</div>
    <div id="tree-body"><div id="tree-empty">Loading…</div></div>
  </div>
  <div id="timeline-pane">
    <div id="timeline-head">
      <span class="focus-id" id="focus-id-label">—</span>
      <select id="head-selector" title="Sessions"></select>
      <span id="head-summary"></span>
      <span id="status-line">connecting…</span>
    </div>
    <div id="timeline-body"><div id="timeline-empty">No session focused yet.</div></div>
    <button id="new-pill" type="button">↓ New messages</button>
  </div>
</div>
<script>
window.__APP_INIT__ = ${JSON.stringify(initData)};

${panelBridgeScript("agentproto-live-session")}

// ============================================================
// INLINED REDUCER COPY — hand-kept mirror of live-session-app.logic.ts.
// Plain JS, same semantics: coalesce consecutive text-delta of the same
// session (and rejoin an unterminated mid-line fragment split by an
// interleaved record — see the TS module's text-delta arm), pair
// tool-call/tool-result by toolCallId, pass through turn-end, keep usage
// as STATE (SPEC §1: usage leaves the timeline — a usage_update record
// never produces a row), ignore unknown kinds. Keep in sync with the TS
// module; the TS module is the one the test suite imports.
// ============================================================

function initialTimelineState() {
  return { rows: [], usage: null };
}

function rowId(record, rows) {
  return record.seq != null ? (record.kind + '-' + record.seq) : (record.kind + '-' + rows.length);
}

// Fold a text-delta record into an existing row (fresh object), keeping the
// row's "partial" hint in step with the latest record — see mergeTextDelta in
// the TS module.
function mergeTextDelta(row, record) {
  var merged = Object.assign({}, row, {
    text: row.text + (record.text || ''),
    seq: record.seq,
    ts: record.ts,
  });
  if (record.partial === true) merged.partial = true;
  else delete merged.partial;
  return merged;
}

function reduceEvent(state, record) {
  switch (record.kind) {
    case 'text-delta': {
      var last = state.rows[state.rows.length - 1];
      if (last && last.kind === 'text' && last.sessionId === record.sessionId) {
        return { rows: state.rows.slice(0, -1).concat([mergeTextDelta(last, record)]), usage: state.usage };
      }
      // Debounce can flush an unterminated mid-word fragment (flagged
      // partial), let a tool-call land, then flush the continuation — look
      // back within the same turn (bounded by this session's last turn-end)
      // for that session's most recent text row and continue it in place.
      // Only the explicit partial flag glues: a non-partial record with no
      // trailing newline is the writer's normal end-of-text-block shape.
      for (var i = state.rows.length - 1; i >= 0; i--) {
        var prior = state.rows[i];
        if (prior.sessionId !== record.sessionId) continue;
        if (prior.kind === 'turn-end') break;
        if (prior.kind !== 'text') continue;
        if (prior.partial === true) {
          var patched = state.rows.slice();
          patched[i] = mergeTextDelta(prior, record);
          return { rows: patched, usage: state.usage };
        }
        break;
      }
      var row = {
        kind: 'text', id: rowId(record, state.rows), seq: record.seq, ts: record.ts,
        sessionId: record.sessionId, text: record.text || '',
      };
      if (record.partial === true) row.partial = true;
      return { rows: state.rows.concat([row]), usage: state.usage };
    }
    case 'tool-call': {
      var row = {
        kind: 'tool-call', id: rowId(record, state.rows), seq: record.seq, ts: record.ts,
        sessionId: record.sessionId, toolCallId: record.toolCallId || '',
        toolName: record.toolName || 'unknown', arguments: record.arguments, status: 'pending',
      };
      return { rows: state.rows.concat([row]), usage: state.usage };
    }
    case 'tool-result': {
      var idx = -1;
      for (var i = 0; i < state.rows.length; i++) {
        if (state.rows[i].kind === 'tool-call' && state.rows[i].toolCallId === record.toolCallId) idx = i;
      }
      if (idx === -1) {
        var row = {
          kind: 'tool-call', id: rowId(record, state.rows), seq: record.seq, ts: record.ts,
          sessionId: record.sessionId, toolCallId: record.toolCallId || '', toolName: 'unknown',
          status: record.isError ? 'error' : 'ok', result: record.result,
        };
        return { rows: state.rows.concat([row]), usage: state.usage };
      }
      var updated = Object.assign({}, state.rows[idx], {
        status: record.isError ? 'error' : 'ok', result: record.result,
      });
      var rows = state.rows.slice();
      rows[idx] = updated;
      return { rows: rows, usage: state.usage };
    }
    case 'turn-end': {
      var row = {
        kind: 'turn-end', id: rowId(record, state.rows), seq: record.seq, ts: record.ts,
        sessionId: record.sessionId, reason: record.reason,
      };
      return { rows: state.rows.concat([row]), usage: state.usage };
    }
    case 'usage_update': {
      // Usage is state, not a row (SPEC §1) — last-write-wins, no merge with
      // the prior snapshot. state.rows is reused as-is (it didn't change).
      return {
        rows: state.rows,
        usage: {
          size: record.size, used: record.used, cost: record.cost,
          tokensIn: record.tokensIn, tokensOut: record.tokensOut,
          seq: record.seq, ts: record.ts,
        },
      };
    }
    default:
      return state;
  }
}

// ============================================================
// INLINED PURE HELPERS — exact copies of live-session-app.logic.ts's
// isNearBottom (SPEC §2) and groupAdjacentToolCalls (SPEC §3). Same names,
// same signatures, same default thresholds; plain JS because the widget
// has no import step.
// ============================================================

var SCROLL_STICK_THRESHOLD_PX = 24;

function isNearBottom(scrollHeight, scrollTop, clientHeight, threshold) {
  if (threshold == null) threshold = SCROLL_STICK_THRESHOLD_PX;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

var TOOL_CALL_GROUP_THRESHOLD = 2;

// Collapse runs of \`threshold\`+ adjacent tool-call rows into one
// {kind:'tool-group', rows:[...]} entry; everything else passes through as
// individual {kind:'row', row} entries, same order as the input.
function groupAdjacentToolCalls(rows, threshold) {
  if (threshold == null) threshold = TOOL_CALL_GROUP_THRESHOLD;
  var out = [];
  var run = [];
  function flushRun() {
    if (!run.length) return;
    if (run.length >= threshold) out.push({ kind: 'tool-group', rows: run });
    else for (var j = 0; j < run.length; j++) out.push({ kind: 'row', row: run[j] });
    run = [];
  }
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'tool-call') { run.push(rows[i]); continue; }
    flushRun();
    out.push({ kind: 'row', row: rows[i] });
  }
  flushRun();
  return out;
}

// ============================================================
// Rendering helpers
// ============================================================

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function safeJson(v) {
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}

function statusDotClass(status) {
  if (status === 'running' || status === 'starting') return 'running';
  if (status === 'error' || status === 'killed') return 'error';
  return 'grey';
}

// SPEC §4 (non-contract guidance): 52524 → "52.5k", >=1e6 → "M" suffix,
// one decimal, trailing .0 vanishes because the value stays a number.
// cost → "$" + toFixed(2). Read from timelineState.usage.
function fmtCompactNum(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
  if (n >= 1000) return (Math.round(n / 100) / 10) + 'k';
  return String(n);
}

function usageChipText(usage) {
  if (!usage) return '';
  var bits = [];
  if (usage.used != null && usage.size != null) {
    bits.push(fmtCompactNum(usage.used) + '/' + fmtCompactNum(usage.size));
  } else if (usage.used != null) {
    bits.push(fmtCompactNum(usage.used));
  }
  if (typeof usage.cost === 'number') bits.push('$' + usage.cost.toFixed(2));
  return bits.join(' · ');
}

// WP5: elapsed seconds since the timeline's first row (running only).
function elapsedText(rows, status) {
  if (status !== 'running' && status !== 'starting') return null;
  if (!rows.length || rows[0].ts == null) return null;
  var ms = new Date(rows[0].ts).getTime();
  if (!isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 1000)) + 's';
}

// ============================================================
// LEFT pane — live tree
// ============================================================

var currentTree = [];
var focusId = (window.__APP_INIT__ && window.__APP_INIT__.sessionId) || null;
// Where the current focus came from: 'pinned' (the tool result that mounted
// this widget named a session — never auto-switched away), 'auto' (self-
// discovered newest running session, a guess the host may still correct),
// 'user' (explicit click/selector choice — outranks everything).
var focusSource = focusId ? 'pinned' : null;
var bootDone = false;
var treeTimer = null;

// INLINED COPY of live-session-app.logic.ts extractToolResultSessionId —
// keep in sync (same convention as the reducer copy below).
function extractToolResultSessionId(params) {
  if (!params || typeof params !== 'object') return null;
  var res = (params.result && typeof params.result === 'object') ? params.result : params;
  if (res.isError) return null;
  var content = Array.isArray(res.content) ? res.content : [];
  var item = content[0];
  if (!item || item.type !== 'text' || typeof item.text !== 'string') return null;
  try {
    var body = JSON.parse(item.text);
    if (body && typeof body.sessionId === 'string' && body.sessionId) return body.sessionId;
    if (body && typeof body.id === 'string' && body.id) return body.id;
  } catch (_) {}
  return null;
}

// The host pushes the triggering tool call's result (ext-apps
// ui/notifications/tool-result). For agent_start that result IS the spawned
// session's descriptor — pin the widget to THAT session instead of leaving
// pollTree() to self-discover the newest running one, which made every
// agent_start card show the latest started session rather than its own.
onHostNotification(function(method, params) {
  if (method !== 'ui/notifications/tool-result') return;
  var id = extractToolResultSessionId(params);
  if (!id || focusSource === 'user' || id === focusId) return;
  focusSource = 'pinned';
  if (bootDone) setFocus(id);
  else focusId = id; // boot's own startTimeline(focusId) picks it up
});

function findNode(nodes, id) {
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return nodes[i];
    var found = findNode(nodes[i].children || [], id);
    if (found) return found;
  }
  return null;
}

function flattenDfs(nodes, out) {
  out = out || [];
  for (var i = 0; i < nodes.length; i++) {
    out.push(nodes[i]);
    flattenDfs(nodes[i].children || [], out);
  }
  return out;
}

function pickInitialFocus(tree) {
  var flat = flattenDfs(tree);
  var alive = flat.filter(function(n) { return n.status === 'running' || n.status === 'starting'; });
  if (alive.length) return alive[alive.length - 1].id;
  return tree.length ? tree[0].id : null;
}

function renderTreeNode(node, depth) {
  var childrenHtml = (node.children || []).map(function(c) { return renderTreeNode(c, depth + 1); }).join('');
  var badge = node.isOrchestrator ? '<span class="badge">orch</span>' : '';
  var cls = 'tnode' + (node.id === focusId ? ' focus' : '');
  return '<div class="' + cls + '" data-id="' + escHtml(node.id) + '">' +
    '<span class="dot ' + statusDotClass(node.status) + '"></span>' +
    '<span class="label">' + escHtml(node.label || node.id) + '</span>' + badge +
    '</div>' +
    (childrenHtml ? '<div class="tchildren">' + childrenHtml + '</div>' : '');
}

// WP4: compact header <select> mirrors the tree; still routes through
// setFocus() — the only session-switch entry point.
function renderHeadSelector() {
  var sel = document.getElementById('head-selector');
  var flat = flattenDfs(currentTree);
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  if (!flat.length) return;
  for (var i = 0; i < flat.length; i++) {
    var n = flat[i];
    var o = document.createElement('option');
    o.value = n.id;
    o.textContent = (n.id === focusId ? '● ' : '') + (n.label || n.id);
    sel.appendChild(o);
  }
  sel.value = focusId || '';
}

function renderTree() {
  var body = document.getElementById('tree-body');
  var root = focusId ? findNode(currentTree, focusId) : null;
  var renderNodes = root ? [root] : currentTree;
  if (!renderNodes.length) {
    body.innerHTML = '<div id="tree-empty">No sessions.</div>';
    renderHeadSelector();
    return;
  }
  body.innerHTML = renderNodes.map(function(n) { return renderTreeNode(n, 0); }).join('');
  var els = body.querySelectorAll('.tnode');
  els.forEach(function(el) {
    el.addEventListener('click', function() {
      var id = el.getAttribute('data-id');
      if (id === focusId) return;
      focusSource = 'user';
      setFocus(id);
    });
  });
  renderHeadSelector();
}

function pollTree() {
  callTool('app_session_tree', {}).then(function(res) {
    currentTree = res.tree || [];
    if (!focusId) {
      focusId = pickInitialFocus(currentTree);
      if (focusId) { focusSource = 'auto'; startTimeline(focusId); }
    }
    renderTree();
    updateHeader();
  }).catch(function() {
    // Leave the last-known tree rendered; the next poll may recover.
  });
}

// ============================================================
// RIGHT pane — timeline for focusId
// ============================================================

var timelineState = initialTimelineState();
var sincePtr = 0;
var activeSource = null; // {type:'sse', es} | {type:'poll', timer}
var compactMode = false; // WP3: hostContext.displayMode === 'inline' (or narrow)

function setStatus(msg) {
  document.getElementById('status-line').textContent = msg;
}

function isCompact() {
  return (getHostContext() && getHostContext().displayMode === 'inline') ||
    (typeof window !== 'undefined' && window.innerWidth < 640);
}

// WP3/WP4: apply the compact/expanded split. Only re-renders the timeline
// when the mode actually flips (scroll + <details> state survive otherwise).
function applyDisplayMode() {
  var c = isCompact();
  document.body.classList.toggle('compact-mode', c);
  if (c !== compactMode) {
    compactMode = c;
    renderTimelineFull();
    renderTree();
  }
}

// WP5 + WP2: one header line — \`● running · 3 tools · 52.5k/200k · $0.04 · 12s\`
// (status dot from the focus node, tool count from the rows, usage from
// timelineState.usage — no usage_update row anymore) + transport status.
function updateHeader() {
  document.getElementById('focus-id-label').textContent = focusId || '—';
  var rows = timelineState.rows || [];
  var usage = timelineState.usage;
  var tools = 0;
  for (var i = 0; i < rows.length; i++) if (rows[i].kind === 'tool-call') tools++;
  var node = focusId ? findNode(currentTree, focusId) : null;
  var st = node ? node.status : null;
  var parts = [];
  if (st) parts.push('<span class="sdot ' + statusDotClass(st) + '"></span>' + escHtml(st));
  if (tools) parts.push(tools + (tools === 1 ? ' tool' : ' tools'));
  var chip = usageChipText(usage);
  if (chip) parts.push('<span id="usage-chip" class="chip">' + escHtml(chip) + '</span>');
  var el = elapsedText(rows, st);
  if (el) parts.push(escHtml(el));
  document.getElementById('head-summary').innerHTML = parts.length ? parts.join(' · ') : '';
}

function captureDetailsOpenFlags(body) {
  var dets = body.querySelectorAll('details');
  var flags = [];
  for (var i = 0; i < dets.length; i++) flags.push(dets[i].open);
  return flags;
}

function restoreDetailsOpenFlags(body, flags) {
  var dets = body.querySelectorAll('details');
  for (var i = 0; i < dets.length && i < flags.length; i++) {
    if (flags[i]) dets[i].open = true;
  }
}

// Full rebuild — used ONLY for the first paint of a session, a setFocus()
// session switch (SPEC §2: full reset is correct there), a display-mode
// flip, and as the fallback for shapes the incremental patcher can't patch.
// A display-mode flip re-renders the SAME content (WP3: "réactif... sans
// perdre le scroll ni l'état des <details>"), so open <details> and the
// exact scroll offset (not just the at-bottom decision) survive the rebuild.
function renderTimelineFull() {
  var body = document.getElementById('timeline-body');
  var wasAtBottom = isNearBottom(body.scrollHeight, body.scrollTop, body.clientHeight);
  var savedScrollTop = body.scrollTop;
  var flags = captureDetailsOpenFlags(body);
  body.innerHTML = buildTimelineHtml();
  restoreDetailsOpenFlags(body, flags);
  body.scrollTop = wasAtBottom ? body.scrollHeight : savedScrollTop;
  updateHeader();
}

function buildTimelineHtml() {
  var rows = timelineState.rows;
  if (!rows.length) return '<div id="timeline-empty">No events yet.</div>';
  if (compactMode) {
    var entries = groupAdjacentToolCalls(rows);
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.kind === 'tool-group') {
        html += '<details class="tool-group"><summary>▸ ' + e.rows.length + ' tool calls</summary>' +
          e.rows.map(renderRow).join('') + '</details>';
      } else {
        html += renderRow(e.row);
      }
    }
    return html;
  }
  return rows.map(renderRow).join('');
}

// ── WP1 incremental patch (dense mode) ─────────────────────────────────
// One record, one minimal DOM mutation. The common case (text-delta merged
// into the LAST rendered row) patches just that row's text node. Anything
// else appends via insertAdjacentHTML. Only rare in-place replacements
// (tool-result merge, partial-lookback re-merge) swap ONE element's HTML.
function applyRecordToDom(prevRows) {
  var body = document.getElementById('timeline-body');
  // Capture "stuck to bottom?" BEFORE any mutation (SPEC §2).
  var wasAtBottom = isNearBottom(body.scrollHeight, body.scrollTop, body.clientHeight);
  var rows = timelineState.rows;

  if (compactMode) {
    // Inline mode: smaller rows — full grouped rebuild, preserving
    // wasAtBottom/scrollTop and <details> open-state. Only touch the DOM
    // (and the scroll/pill decision) when the rows actually changed — a
    // usage_update leaves rows === prevRows, so it must fall through to the
    // header-only path below, same as the dense-mode branch.
    if (rows !== prevRows) {
      var flags = captureDetailsOpenFlags(body);
      body.innerHTML = buildTimelineHtml();
      restoreDetailsOpenFlags(body, flags);
      if (wasAtBottom) body.scrollTop = body.scrollHeight;
      else showNewPill();
    }
    updateHeader();
    return;
  }

  var appended = rows.length > prevRows.length;
  if (prevRows.length === 0 || (appended && !samePrefix(prevRows, rows))) {
    // First real paint of this session (empty placeholder present) or an
    // unexpected shape — full reset is correct/cheapest.
    body.innerHTML = buildTimelineHtml();
    body.scrollTop = body.scrollHeight;
    updateHeader();
    return;
  }

  if (appended) {
    body.insertAdjacentHTML('beforeend', renderRow(rows[rows.length - 1]));
  } else if (rows.length === prevRows.length && rows.length > 0) {
    // Exactly one row object replaced (tool-result merge, partial-text
    // re-merge via the reducer's lookback). Patch that one element only.
    // Scan from the tail: the hot path (a text-delta merged into the LAST
    // row, the dominant streaming case) is found in O(1) this way instead
    // of walking the whole array — the rare mid-array lookback re-merge
    // still resolves correctly, just slower.
    var idx = -1;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i] !== prevRows[i]) { idx = i; break; }
    }
    var patched = false;
    if (idx >= 0) {
      var row = rows[idx];
      var el = body.querySelector('[data-row-id="' + escHtml(row.id) + '"]');
      if (el) {
        if (row.kind === 'text' && idx === rows.length - 1) {
          // High-frequency case: patch the existing text node in place.
          var b = el.querySelector('.body');
          if (b) { b.textContent = row.text; patched = true; }
        }
        if (!patched) { el.outerHTML = renderRow(row); patched = true; }
      }
    }
    if (!patched) {
      // Multiple rows changed at once (shouldn't happen per-record) — rebuild.
      body.innerHTML = buildTimelineHtml();
      if (wasAtBottom) body.scrollTop = body.scrollHeight;
      updateHeader();
      return;
    }
  } else {
    // rows unchanged (usage_update) — header only.
    updateHeader();
    return;
  }

  // Scroll decision AFTER the mutation: stick or leave the position alone.
  if (wasAtBottom) body.scrollTop = body.scrollHeight;
  else showNewPill();
  updateHeader();
}

function samePrefix(prevRows, rows) {
  for (var i = 0; i < prevRows.length; i++) {
    if (prevRows[i] !== rows[i]) return false;
  }
  return true;
}

function showNewPill() {
  document.getElementById('new-pill').classList.add('show');
}

function hideNewPill() {
  document.getElementById('new-pill').classList.remove('show');
}

function renderRow(row) {
  if (row.kind === 'text') {
    return '<div class="row text" data-row-id="' + escHtml(row.id) + '"><div class="rhead"><span class="kind">text</span></div>' +
      '<div class="body">' + escHtml(row.text) + '</div></div>';
  }
  if (row.kind === 'tool-call') {
    var badgeCls = row.status === 'pending' ? 'pending' : row.status;
    var badgeText = row.status === 'pending' ? 'pending' : (row.status === 'ok' ? 'ok' : 'error');
    var resultHtml = row.status !== 'pending'
      ? '<details><summary>result</summary><pre>' + escHtml(safeJson(row.result)) + '</pre></details>'
      : '';
    return '<div class="row tool-call" data-row-id="' + escHtml(row.id) + '"><div class="rhead"><span class="kind">tool</span>' +
      '<span class="toolname">' + escHtml(row.toolName) + '</span>' +
      '<span class="status-badge ' + badgeCls + '">' + badgeText + '</span></div>' +
      '<details><summary>arguments</summary><pre>' + escHtml(safeJson(row.arguments)) + '</pre></details>' +
      resultHtml + '</div>';
  }
  if (row.kind === 'turn-end') {
    return '<div class="row turn-end" data-row-id="' + escHtml(row.id) + '"><div class="rhead"><span class="kind">turn end</span>' +
      '<span class="chip">' + escHtml(row.reason || '—') + '</span></div></div>';
  }
  return '';
}

function teardownTimeline() {
  if (activeSource) {
    if (activeSource.type === 'sse' && activeSource.es) {
      try { activeSource.es.close(); } catch (e) {}
    }
    // Both the poll re-arm timer AND the SSE open/first-message fallback
    // timer must be cleared, or a focus switch within the 2.5s window leaves
    // a stale timer that fires startPolling for the abandoned session.
    if (activeSource.timer) clearTimeout(activeSource.timer);
    if (activeSource.fallbackTimer) clearTimeout(activeSource.fallbackTimer);
  }
  activeSource = null;
}

function attemptSSE(id) {
  var settled = false;
  var es;
  try {
    es = new EventSource(window.__APP_INIT__.httpBaseUrl + '/sessions/' + encodeURIComponent(id) + '/events/stream');
  } catch (e) {
    startPolling(id);
    return;
  }
  var src = { type: 'sse', es: es, fallbackTimer: null };
  activeSource = src;
  // Every callback below re-checks focusId===id AND that src is still the
  // live source: a focus switch tears down src and starts a new one, so a
  // late open/message/error from this abandoned EventSource must be a no-op
  // rather than mutating the new focus's timeline or clobbering activeSource.
  function stale() { return activeSource !== src || focusId !== id; }
  src.fallbackTimer = setTimeout(function() {
    if (settled || stale()) return;
    settled = true;
    try { es.close(); } catch (e) {}
    startPolling(id);
  }, 2500);
  es.addEventListener('open', function() {
    if (settled || stale()) return;
    settled = true;
    clearTimeout(src.fallbackTimer);
    setStatus('streaming via SSE');
  });
  es.onmessage = function(evt) {
    if (stale()) return;
    if (!settled) {
      settled = true;
      clearTimeout(src.fallbackTimer);
      setStatus('streaming via SSE');
    }
    var rec;
    try { rec = JSON.parse(evt.data); } catch (e) { return; }
    var prev = timelineState;
    timelineState = reduceEvent(timelineState, rec);
    if (typeof rec.seq === 'number' && rec.seq > sincePtr) sincePtr = rec.seq;
    if (timelineState !== prev) applyRecordToDom(prev.rows);
  };
  es.onerror = function() {
    if (stale()) return;
    if (!settled) {
      settled = true;
      clearTimeout(src.fallbackTimer);
      try { es.close(); } catch (e) {}
      startPolling(id);
    } else {
      // Do not leave EventSource to perform its native reconnect: this
      // endpoint replays from since=0 when no cursor is provided, so a
      // transparent reconnect would duplicate every row already reduced.
      // The bridge poll resumes from sincePtr instead and preserves the
      // exactly-once cursor contract.
      try { es.close(); } catch (e) {}
      startPolling(id);
    }
  };
}

function startPolling(id) {
  activeSource = { type: 'poll', timer: null };
  setStatus('polling');
  function tick() {
    if (!activeSource || activeSource.type !== 'poll' || focusId !== id) return;
    callTool('app_session_events', { sessionId: id, since: sincePtr }).then(function(res) {
      var events = res.events || [];
      for (var i = 0; i < events.length; i++) {
        var prev = timelineState;
        timelineState = reduceEvent(timelineState, events[i]);
        if (timelineState !== prev) applyRecordToDom(prev.rows);
      }
      if (typeof res.nextSeq === 'number') sincePtr = res.nextSeq;
      setStatus('polling');
      if (activeSource) activeSource.timer = setTimeout(tick, 1500);
    }).catch(function() {
      setStatus('disconnected');
      if (activeSource) activeSource.timer = setTimeout(tick, 1500);
    });
  }
  tick();
}

function startTimeline(id) {
  teardownTimeline();
  timelineState = initialTimelineState();
  sincePtr = 0;
  hideNewPill();
  renderTimelineFull();
  setStatus('connecting…');
  attemptSSE(id);
}

function setFocus(id) {
  focusId = id;
  renderTree();
  startTimeline(id);
}

// ============================================================
// Boot
// ============================================================

initBridge().then(function() {
  var init = window.__APP_INIT__ || {};
  if (init.httpBaseUrl) return init;
  // Static ui:// resources render once at server-registration time with
  // EMPTY initData (mcp-apps-adapter.ts registerMcpApps) — fall back to
  // calling the tool ourselves over the bridge, same as the other panels.
  return callTool('live_session', {}).then(function(result) {
    window.__APP_INIT__ = result;
    return result;
  });
}).then(function(init) {
  // Only override the focus when live_session itself named a session AND a
  // tool-result notification didn't already pin one while the fallback
  // tools/call above was in flight — the host's push names the exact
  // session this widget was mounted for, so it outranks the fallback's
  // (argument-less, hence session-less in practice) self-call.
  if (init.sessionId && focusSource !== 'pinned') {
    focusId = init.sessionId;
    focusSource = 'pinned';
  }
  onHostContext(function() {
    applyDisplayMode();
    updateHeader();
  });
  document.getElementById('head-selector').addEventListener('change', function(evt) {
    var id = evt.target.value;
    if (id && id !== focusId) { focusSource = 'user'; setFocus(id); }
  });
  document.getElementById('new-pill').addEventListener('click', function() {
    var body = document.getElementById('timeline-body');
    body.scrollTop = body.scrollHeight;
    hideNewPill();
  });
  document.getElementById('timeline-body').addEventListener('scroll', function() {
    // User scrolled back near the bottom — the pill is stale, hide it.
    var el = document.getElementById('timeline-body');
    if (isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight)) hideNewPill();
  });
  window.addEventListener('resize', function() {
    var c = isCompact();
    if (c !== compactMode) { applyDisplayMode(); }
  });
  applyDisplayMode();
  bootDone = true;
  pollTree();
  treeTimer = setInterval(pollTree, 2000);
  setInterval(updateHeader, 1000); // keep the WP5 elapsed clock fresh
  if (focusId) startTimeline(focusId);
}).catch(function(e) {
  setStatus('Bridge error: ' + e.message);
});
</script>
</body>
</html>`
}
