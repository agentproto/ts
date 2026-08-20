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
      "calls/results, turn-end, usage) on the right. Omit `sessionId` to " +
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
#timeline-pane{flex:1;display:flex;flex-direction:column;min-width:0}
#timeline-head{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0}
#timeline-head .focus-id{font-weight:600;font-size:13px;font-family:Menlo,Monaco,monospace}
#status-line{margin-left:auto;font-size:11px;color:var(--text2)}
#timeline-body{flex:1;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:8px}

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
.row.usage_update .kind{color:var(--text3)}
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
      <span id="status-line">connecting…</span>
    </div>
    <div id="timeline-body"><div id="timeline-empty">No session focused yet.</div></div>
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
// tool-call/tool-result by toolCallId, pass through turn-end/usage_update,
// ignore unknown kinds. Keep in sync with the TS module; the TS module is
// the one the test suite imports.
// ============================================================

function initialTimelineState() {
  return { rows: [] };
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
        return { rows: state.rows.slice(0, -1).concat([mergeTextDelta(last, record)]) };
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
          return { rows: patched };
        }
        break;
      }
      var row = {
        kind: 'text', id: rowId(record, state.rows), seq: record.seq, ts: record.ts,
        sessionId: record.sessionId, text: record.text || '',
      };
      if (record.partial === true) row.partial = true;
      return { rows: state.rows.concat([row]) };
    }
    case 'tool-call': {
      var row = {
        kind: 'tool-call', id: rowId(record, state.rows), seq: record.seq, ts: record.ts,
        sessionId: record.sessionId, toolCallId: record.toolCallId || '',
        toolName: record.toolName || 'unknown', arguments: record.arguments, status: 'pending',
      };
      return { rows: state.rows.concat([row]) };
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
        return { rows: state.rows.concat([row]) };
      }
      var updated = Object.assign({}, state.rows[idx], {
        status: record.isError ? 'error' : 'ok', result: record.result,
      });
      var rows = state.rows.slice();
      rows[idx] = updated;
      return { rows: rows };
    }
    case 'turn-end': {
      var row = {
        kind: 'turn-end', id: rowId(record, state.rows), seq: record.seq, ts: record.ts,
        sessionId: record.sessionId, reason: record.reason,
      };
      return { rows: state.rows.concat([row]) };
    }
    case 'usage_update': {
      var row = {
        kind: 'usage_update', id: rowId(record, state.rows), seq: record.seq, ts: record.ts,
        sessionId: record.sessionId, size: record.size, used: record.used, cost: record.cost,
        tokensIn: record.tokensIn, tokensOut: record.tokensOut,
      };
      return { rows: state.rows.concat([row]) };
    }
    default:
      return state;
  }
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

// ============================================================
// LEFT pane — live tree
// ============================================================

var currentTree = [];
var focusId = (window.__APP_INIT__ && window.__APP_INIT__.sessionId) || null;
var treeTimer = null;

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

function renderTree() {
  var body = document.getElementById('tree-body');
  var root = focusId ? findNode(currentTree, focusId) : null;
  var renderNodes = root ? [root] : currentTree;
  if (!renderNodes.length) {
    body.innerHTML = '<div id="tree-empty">No sessions.</div>';
    return;
  }
  body.innerHTML = renderNodes.map(function(n) { return renderTreeNode(n, 0); }).join('');
  var els = body.querySelectorAll('.tnode');
  els.forEach(function(el) {
    el.addEventListener('click', function() {
      var id = el.getAttribute('data-id');
      if (id === focusId) return;
      setFocus(id);
    });
  });
}

function pollTree() {
  callTool('app_session_tree', {}).then(function(res) {
    currentTree = res.tree || [];
    if (!focusId) {
      focusId = pickInitialFocus(currentTree);
      if (focusId) startTimeline(focusId);
    }
    renderTree();
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

function setStatus(msg) {
  document.getElementById('status-line').textContent = msg;
}

function renderTimeline() {
  document.getElementById('focus-id-label').textContent = focusId || '—';
  var body = document.getElementById('timeline-body');
  var rows = timelineState.rows;
  if (!rows.length) {
    body.innerHTML = '<div id="timeline-empty">No events yet.</div>';
    return;
  }
  body.innerHTML = rows.map(renderRow).join('');
}

function renderRow(row) {
  if (row.kind === 'text') {
    return '<div class="row text"><div class="rhead"><span class="kind">text</span></div>' +
      '<div class="body">' + escHtml(row.text) + '</div></div>';
  }
  if (row.kind === 'tool-call') {
    var badgeCls = row.status === 'pending' ? 'pending' : row.status;
    var badgeText = row.status === 'pending' ? 'pending' : (row.status === 'ok' ? 'ok' : 'error');
    var resultHtml = row.status !== 'pending'
      ? '<details><summary>result</summary><pre>' + escHtml(safeJson(row.result)) + '</pre></details>'
      : '';
    return '<div class="row tool-call"><div class="rhead"><span class="kind">tool</span>' +
      '<span class="toolname">' + escHtml(row.toolName) + '</span>' +
      '<span class="status-badge ' + badgeCls + '">' + badgeText + '</span></div>' +
      '<details><summary>arguments</summary><pre>' + escHtml(safeJson(row.arguments)) + '</pre></details>' +
      resultHtml + '</div>';
  }
  if (row.kind === 'turn-end') {
    return '<div class="row turn-end"><div class="rhead"><span class="kind">turn end</span>' +
      '<span class="chip">' + escHtml(row.reason || '—') + '</span></div></div>';
  }
  if (row.kind === 'usage_update') {
    var parts = [];
    if (row.tokensIn != null) parts.push('in ' + row.tokensIn);
    if (row.tokensOut != null) parts.push('out ' + row.tokensOut);
    if (row.used != null && row.size != null) parts.push(row.used + '/' + row.size);
    if (row.cost != null) parts.push('$' + row.cost);
    return '<div class="row usage_update"><div class="rhead"><span class="kind">usage</span>' +
      '<span class="chip">' + escHtml(parts.join(' · ') || '—') + '</span></div></div>';
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
    timelineState = reduceEvent(timelineState, rec);
    if (typeof rec.seq === 'number' && rec.seq > sincePtr) sincePtr = rec.seq;
    renderTimeline();
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
        timelineState = reduceEvent(timelineState, events[i]);
      }
      if (typeof res.nextSeq === 'number') sincePtr = res.nextSeq;
      if (events.length) renderTimeline();
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
  renderTimeline();
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
  focusId = init.sessionId || null;
  pollTree();
  treeTimer = setInterval(pollTree, 2000);
  if (focusId) startTimeline(focusId);
}).catch(function(e) {
  setStatus('Bridge error: ' + e.message);
});
</script>
</body>
</html>`
}
