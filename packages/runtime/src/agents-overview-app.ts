/**
 * McpApp definition for the agentproto "agents — vue claire" panel.
 *
 * A plain-language overview of agent-cli sessions: one card per session
 * with a single human sentence (what the agent is doing/last said) plus a
 * coarse state — `à traiter` / `au travail` / `en attente` / `terminé`.
 *
 * Uses the same AgnoMcpApp contract as sessions-panel-app.ts (a local
 * McpApp-compatible shape that does NOT depend on @agstudio/mcp-apps —
 * agentproto is a separate pnpm workspace). Wire via `registerMcpApps`.
 *
 * Protocol flow:
 *   1. Tool `agentproto_agents_overview` is called by the host.
 *   2. execute() returns the agent-session snapshot → injected into the
 *      HTML as the initial render via the tool result JSON.
 *   3. The HTML panel opens a JSON-RPC bridge (postMessage) and polls
 *      `session_list` every ~12 s, then calls `summarize_session` for
 *      each visible session to fetch the plain sentence + state.
 *
 * The per-session summary is generated SERVER-SIDE by the
 * `summarize_session` tool (see registerSummarizeSessionTool below).
 * Today it is HEURISTIC — last meaningful output line + a state derived
 * from lifecycle/awaitingInput/recency. There is no LLM client wired into
 * @agentproto/runtime (egress/providers.ts is a proxy allowlist, not an
 * inference client; driver-agent-cli's `ModelLike.complete` would spawn a
 * fresh agent session per call — too heavy, and it would pollute the very
 * session list we render). When a real summarizer is wanted, swap the body
 * of `summarizeSession` for a `ModelLike.complete({system, prompt})` call;
 * the tool contract (1 sentence + state) stays the same.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { panelBridgeScript } from "./panel-bridge.js"
import type { SessionDescriptor } from "./sessions.js"
import type { AgnoMcpApp } from "./sessions-panel-app.js"

// ── Heuristic summary (pure, server-side) ────────────────────────────────────

export type SessionState = "à traiter" | "au travail" | "en attente" | "terminé"

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
/** Chrome-only lines we never want as a summary (spinners, box-drawing,
 *  bare prompts, separators). */
const CHROME_RE = /^[\s>$#*✻✶✳·•.\-=_|~╭╰╮╯│─├┤┌┐└┘]+$/u

function strip(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "")
}

/**
 * Pick the last meaningful output line as a one-sentence summary.
 * Falls back to the session label/command when there's no usable output.
 */
export function summarizeLines(
  lines: readonly string[],
  desc: Pick<SessionDescriptor, "command" | "label" | "name">,
): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = strip(lines[i] ?? "").trim()
    if (t.length < 3) continue
    if (CHROME_RE.test(t)) continue
    return t.length > 160 ? `${t.slice(0, 157)}…` : t
  }
  return desc.label || desc.name || desc.command || "Aucune sortie pour le moment."
}

/**
 * Coarse state from lifecycle + recency. Heuristic, no LLM:
 *   terminé      — exited / killed / error
 *   à traiter    — alive and the agent flagged awaiting-input (your turn)
 *   au travail   — alive and produced output recently (< staleMs)
 *   en attente   — alive but idle (no recent output, not awaiting input)
 */
export function deriveSessionState(
  desc: Pick<SessionDescriptor, "status" | "awaitingInput" | "lastOutputAt">,
  nowMs: number,
  staleMs = 30_000,
): SessionState {
  if (desc.status === "exited" || desc.status === "killed" || desc.status === "error") {
    return "terminé"
  }
  if (desc.awaitingInput) return "à traiter"
  const last = desc.lastOutputAt ? Date.parse(desc.lastOutputAt) : Number.NaN
  if (!Number.isNaN(last) && nowMs - last < staleMs) return "au travail"
  return "en attente"
}

export interface SessionSummary {
  sessionId: string
  summary: string
  state: SessionState
  status: SessionDescriptor["status"]
  label?: string
  lastOutputAt?: string
}

/** Build the full per-session summary from a descriptor + recent lines. */
export function summarizeSession(
  desc: SessionDescriptor,
  lines: readonly string[],
  nowMs: number,
): SessionSummary {
  return {
    sessionId: desc.id,
    summary: summarizeLines(lines, desc),
    state: deriveSessionState(desc, nowMs),
    status: desc.status,
    ...(desc.label ? { label: desc.label } : {}),
    ...(desc.lastOutputAt ? { lastOutputAt: desc.lastOutputAt } : {}),
  }
}

// ── summarize_session tool ───────────────────────────────────────────────────

export interface SummarizeOps {
  getSession(id: string): SessionDescriptor | undefined
  /** Tail the recent ring buffer for a session (same source as
   *  agent_output). Returns [] for unknown sessions. */
  tailLines(id: string, lastN: number): string[]
  /** Current epoch-ms, injectable for tests. Defaults to Date.now. */
  now?: () => number
}

/**
 * Register the server-side `summarize_session` tool. The agents-overview
 * panel calls this via the bridge (callTool) for each visible session.
 */
export function registerSummarizeSessionTool(server: McpServer, ops: SummarizeOps): void {
  server.tool(
    "summarize_session",
    "Summarise a session in one plain sentence plus a coarse state " +
      "(à traiter / au travail / en attente / terminé). Heuristic today " +
      "(last meaningful output line + lifecycle/recency) — no LLM. Used by " +
      "the agents overview panel.",
    {
      sessionId: z.string().describe("Session id to summarise."),
      lastN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max recent lines to scan. Default 120."),
    },
    async input => {
      const desc = ops.getSession(input.sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text" as const, text: `summarize_session: no session "${input.sessionId}"` },
          ],
          isError: true,
        }
      }
      const lines = ops.tailLines(input.sessionId, input.lastN ?? 120)
      const nowMs = (ops.now ?? Date.now)()
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summarizeSession(desc, lines, nowMs), null, 2) },
        ],
      }
    },
  )
}

// ── McpApp factory ───────────────────────────────────────────────────────────

export const agentsOverviewInputSchema = z.object({
  filter: z
    .enum(["running", "all"])
    .optional()
    .describe("`running` = only alive agent sessions; `all` = running + recent (default)."),
})

export type AgentsOverviewInput = z.infer<typeof agentsOverviewInputSchema>
export type AgentsOverviewOutput = { sessions: SessionDescriptor[] }

export interface AgentsOverviewOps {
  listSessions(filter?: "running" | "all"): SessionDescriptor[]
}

export function makeAgentsOverviewApp(
  ops: AgentsOverviewOps,
): AgnoMcpApp<AgentsOverviewInput, AgentsOverviewOutput> {
  return {
    id: "agentproto_agents_overview",
    title: "Agents — vue claire",
    description:
      "Open the agents overview — a plain-language card per agent session " +
      "with one human sentence (what it's doing / last said) and a coarse " +
      "state (à traiter / au travail / en attente / terminé). Polls live and " +
      "asks the server to summarise each session.",
    inputSchema: agentsOverviewInputSchema,
    execute: async input => ({ sessions: ops.listSessions(input.filter) }),
    html: AGENTS_OVERVIEW_HTML,
  }
}

// ── HTML bundle (zero CDN, CSP-safe inline) ──────────────────────────────────

export const AGENTS_OVERVIEW_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>agents — vue claire</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#e6edf3;--text2:#8b949e;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;background:var(--bg);color:var(--text);overflow:hidden}
#app{display:flex;flex-direction:column;height:100%}
#hdr{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--bg2);flex-shrink:0}
#hdr h1{font-size:13px;font-weight:600;letter-spacing:.02em}
#hdr .sub{font-size:11px;color:var(--text2);margin-top:2px}
#refresh-btn{background:none;border:none;cursor:pointer;color:var(--text2);font-size:16px;line-height:1;padding:4px 6px;border-radius:6px}
#refresh-btn:hover{color:var(--text);background:var(--bg3)}
#grid{flex:1;overflow-y:auto;padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;align-content:start}
.card{background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-height:96px}
.card.s-todo{border-left-color:var(--purple)}
.card.s-work{border-left-color:var(--green)}
.card.s-wait{border-left-color:var(--yellow)}
.card.s-done{border-left-color:var(--text2)}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.state{font-size:10px;font-weight:700;padding:2px 8px;border-radius:11px;white-space:nowrap;letter-spacing:.02em}
.state.s-todo{background:rgba(188,140,255,.16);color:var(--purple)}
.state.s-work{background:rgba(63,185,80,.16);color:var(--green)}
.state.s-wait{background:rgba(210,153,34,.16);color:var(--yellow)}
.state.s-done{background:rgba(139,148,158,.14);color:var(--text2)}
.summary{font-size:12.5px;line-height:1.5;color:var(--text);word-break:break-word}
.summary.muted{color:var(--text2);font-style:italic}
.meta{font-size:10.5px;color:var(--text2);display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:auto}
.dot{width:5px;height:5px;border-radius:50%;background:var(--text2);display:inline-block}
#empty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text2);gap:8px;padding:48px;text-align:center}
#empty .ico{font-size:30px}
#statusbar{padding:5px 16px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
</style>
</head>
<body>
<div id="app">
  <div id="hdr">
    <div>
      <h1>Agents — vue claire</h1>
      <div class="sub">une carte par agent · résumé + état</div>
    </div>
    <button id="refresh-btn" title="Rafraîchir" onclick="doRefresh()">&#8635;</button>
  </div>
  <div id="grid"><div id="empty"><div class="ico">&#9889;</div><div>Connexion au bridge&#8230;</div></div></div>
  <div id="statusbar">Connexion&#8230;</div>
</div>
<script>
${panelBridgeScript("agentproto-agents-overview")}

// ── State ──
var REFRESH_MS = 12000;
var pollTimer = null, polling = false;
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function setStatus(m){ document.getElementById('statusbar').textContent = m; }

var STATE_CLASS = {
  'à traiter':'s-todo', 'au travail':'s-work', 'en attente':'s-wait', 'terminé':'s-done'
};
function stateClass(st){ return STATE_CLASS[st] || 's-wait'; }

function fmtAgo(iso){
  if (!iso) return '';
  var t = Date.parse(iso);
  if (isNaN(t)) return '';
  var s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'il y a ' + s + 's';
  var m = Math.round(s/60);
  if (m < 60) return 'il y a ' + m + 'min';
  var h = Math.round(m/60);
  return 'il y a ' + h + 'h';
}

function titleOf(s){
  return s.label || s.name || (s.command ? s.command.split(/\\s+/)[0].split('/').pop() : null) || s.id.slice(0,8);
}

function render(sessions, summaries){
  var grid = document.getElementById('grid');
  if (!sessions.length){
    grid.innerHTML = '<div id="empty"><div class="ico">&#128564;</div><div>Aucune session d\\'agent</div></div>';
    return;
  }
  var html = '';
  for (var i=0;i<sessions.length;i++){
    var s = sessions[i];
    var sum = summaries[s.id] || {};
    var st = sum.state || 'en attente';
    var cls = stateClass(st);
    var summary = sum.summary || 'Résumé indisponible.';
    var muted = !sum.summary ? ' muted' : '';
    html += '<div class="card ' + cls + '">'
      + '<div class="card-top">'
      +   '<span class="title">' + esc(titleOf(s)) + '</span>'
      +   '<span class="state ' + cls + '">' + esc(st) + '</span>'
      + '</div>'
      + '<div class="summary' + muted + '">' + esc(summary) + '</div>'
      + '<div class="meta">'
      +   '<span>' + esc(s.kind || '') + '</span><span class="dot"></span>'
      +   '<span>' + esc(s.status || '') + '</span>'
      +   (s.lastOutputAt ? '<span class="dot"></span><span>' + esc(fmtAgo(s.lastOutputAt)) + '</span>' : '')
      + '</div>'
      + '</div>';
  }
  grid.innerHTML = html;
}

function loadAndRender(){
  return callTool('session_list', {kind:'all'}).then(function(data){
    var all = data.sessions || [];
    var agents = all.filter(function(s){ return s.kind === 'agent-cli'; });
    // Render shells immediately, then fill summaries as they arrive.
    var summaries = {};
    render(agents, summaries);
    setStatus(agents.length + ' agent' + (agents.length===1?'':'s') + ' · ' + new Date().toLocaleTimeString('fr-FR'));
    return Promise.all(agents.map(function(s){
      return callTool('summarize_session', {sessionId: s.id}).then(function(sum){
        summaries[s.id] = sum;
      }).catch(function(){ /* leave shell */ });
    })).then(function(){ render(agents, summaries); });
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
  document.getElementById('grid').innerHTML = '<div id="empty"><div class="ico">&#9888;</div><div>Échec connexion bridge : ' + esc(e.message) + '</div></div>';
});
</script>
</body>
</html>`
