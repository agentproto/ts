/**
 * MCP App resource: agentproto session story panel.
 *
 * Ported 1:1 from the validated mockup at docs/session-story-mockup.html —
 * same CSS, same DOM structure/classes, same interaction model (anchored
 * side panel, sticky collapsible chapter headers, Simple/Tech toggle,
 * composer with local chapter-routing classification). Fake data is
 * replaced with live data pulled through the MCP Apps postMessage bridge.
 *
 * The HTML must stay fully self-contained (CSP: inline CSS/JS only, no
 * CDN, no external fonts) — see mcp-apps-adapter.ts and the other panels
 * in this file family (sessions-panel.ts, agents-overview-app.ts) for the
 * same constraint. Because of that, this file cannot `import` the pure
 * `buildStory` module from session-story.ts — the folding/chaptering
 * heuristics are ported to vanilla JS below (`buildStoryJs`), mirroring
 * session-story.ts function-for-function so the two stay easy to diff.
 *
 * Protocol: MCP Apps ext spec 2026-01-26
 *   – Bridge: JSON-RPC 2.0 over window.parent.postMessage
 *   – Handshake: ui/initialize → host result → ui/notifications/initialized
 *   – Data: tools/call → session_list (status/picker) + agent_export
 *     (timeline, re-fetched on turn boundaries) + agent_prompt (composer)
 */

import { panelBridgeScript } from "./panel-bridge.js"

const RESOURCE_URI = "ui://agentproto_session_story/view"
const MIME_TYPE = "text/html;profile=mcp-app"
void RESOURCE_URI
void MIME_TYPE

export const SESSION_STORY_PANEL_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>session story</title>
<style>
  :root {
    color-scheme: light;
    --bg:#faf8f5; --panel:#fffdfa; --line:#ece5da; --line-soft:#f2ede3;
    --ink:#241f1a; --ink-mute:#7d7060; --ink-faint:#a9997f; --ink-ghost:#b3a893;
    --accent:#0d7a4f; --accent-soft:#e8f4ec;
    --gold:#a6701b; --gold-soft:#fff2dc;
    --blue:#1d4e80; --blue-soft:#e9f1fb;
    --violet:#5b3fa6; --violet-soft:#ede9ff;
    --sel:#fbeccd; --red:#b3261e; --red-soft:#fbeae8;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--ink); -webkit-font-smoothing:antialiased; }
  .app { height:100vh; display:flex; flex-direction:column; }
  .hidden { display:none !important; }

  /* ── picker screen ── */
  #pickerScreen { height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:24px; }
  #pickerScreen h1 { font-size:15px; font-weight:700; }
  #pickerList { width:min(520px,90vw); max-height:60vh; overflow-y:auto; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
  .pk-item { padding:10px 14px; border-bottom:1px solid var(--line-soft); cursor:pointer; display:flex; align-items:center; gap:10px; }
  .pk-item:last-child { border-bottom:none; }
  .pk-item:hover { background:var(--line-soft); }
  .pk-name { flex:1; min-width:0; font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pk-meta { flex:none; font-size:10.5px; color:var(--ink-faint); font-weight:600; }
  .pk-empty { padding:24px; text-align:center; color:var(--ink-mute); font-size:12.5px; }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:10px; font-weight:700; }
  .badge.running { background:var(--accent-soft); color:var(--accent); }
  .badge.starting { background:var(--blue-soft); color:var(--blue); }
  .badge.exited { background:var(--line-soft); color:var(--ink-faint); }
  .badge.killed, .badge.error { background:var(--red-soft); color:var(--red); }

  /* ── big picture : mission + plan de sous-tâches ── */
  .hero { flex:none; padding:13px 20px 0; border-bottom:1px solid var(--line); background:var(--panel); }
  .hero-top { display:flex; align-items:center; gap:13px; }
  .pulse { width:10px; height:10px; border-radius:50%; background:var(--accent); flex:none;
           box-shadow:0 0 0 0 rgba(13,122,79,.35); animation:pulse 2.4s infinite; }
  .pulse.off { background:var(--ink-ghost); animation:none; }
  @keyframes pulse { 70% { box-shadow:0 0 0 9px rgba(13,122,79,0); } 100% { box-shadow:0 0 0 0 rgba(13,122,79,0); } }
  .who { min-width:0; flex:1; }
  .who .h1 { font-size:14.5px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .who .h2 { font-size:12px; color:var(--ink-mute); margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .modewrap { display:flex; border:1px solid var(--line); border-radius:9px; overflow:hidden; flex:none; }
  .modewrap button { border:none; background:var(--panel); color:var(--ink-mute); font-size:11px; font-weight:700; padding:6px 11px; cursor:pointer; }
  .modewrap button.on { background:var(--ink); color:#fdf9f2; }
  button.sim { border:1px solid var(--line); background:var(--panel); color:var(--ink-mute); font-weight:700;
               font-size:11.5px; border-radius:8px; padding:6px 12px; cursor:pointer; flex:none; }
  button.sim.on { background:var(--ink); border-color:var(--ink); color:#fdf9f2; }

  /* plan strip : les sous-tâches, l'avancement d'un coup d'œil */
  .plan { display:flex; gap:6px; overflow-x:auto; padding:11px 0 12px; scrollbar-width:none; }
  .plan::-webkit-scrollbar { display:none; }
  .pt { flex:none; display:flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; padding:5px 11px;
        border-radius:999px; border:1px solid var(--line); background:var(--bg); color:var(--ink-mute); cursor:pointer; white-space:nowrap; }
  .pt:hover { border-color:var(--ink-ghost); }
  .pt .st { font-size:10px; }
  .pt.done { color:var(--accent); background:var(--accent-soft); border-color:transparent; }
  .pt.cur { color:var(--gold); background:var(--gold-soft); border-color:transparent; }
  .pt.cur .st { animation:blink 1.6s infinite; }
  @keyframes blink { 50% { opacity:.35; } }

  /* ── corps ── */
  .body { flex:1; display:flex; min-height:0; }
  .feedcol { flex:1; min-width:320px; display:flex; flex-direction:column; }
  .feed { flex:1; overflow-y:auto; padding:4px 14px 10px; display:flex; flex-direction:column; scroll-behavior:smooth; }
  .fspacer { flex:1; }

  /* chapitres */
  .chap { flex:none; position:sticky; top:0; z-index:5; margin:8px -4px 2px; padding:7px 12px; display:flex; align-items:center; gap:9px;
          background:color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter:blur(6px);
          border-radius:9px; cursor:pointer; font-size:11.5px; font-weight:800; letter-spacing:.03em; color:var(--ink-mute); }
  .chap:hover { color:var(--ink); }
  .chap .cst { flex:none; width:17px; height:17px; border-radius:50%; display:grid; place-items:center; font-size:9.5px; font-weight:900; }
  .chap.done .cst { background:var(--accent-soft); color:var(--accent); }
  .chap.cur .cst { background:var(--gold-soft); color:var(--gold); }
  .chap .cnum { color:var(--ink-ghost); font-weight:700; }
  .chap .csum { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .chap .cmeta { flex:none; font-size:10.5px; color:var(--ink-ghost); font-weight:600; }
  .chap .cchev { flex:none; color:var(--ink-ghost); transition:transform .15s; }
  .chap.open .cchev { transform:rotate(90deg); }

  .row { flex:none; min-height:44px; margin:1px 0 1px 10px; padding:5px 12px 5px 10px; display:flex; align-items:center; gap:11px;
         cursor:pointer; border-radius:10px; border-left:3px solid transparent; transition:background .12s; }
  .row:hover { background:var(--line-soft); }
  .row[aria-selected="true"] { background:var(--sel); border-left-color:var(--gold); }
  .row .ico { width:24px; height:24px; border-radius:8px; flex:none; display:grid; place-items:center; font-size:11.5px; font-weight:800; }
  .ico.k-text { background:var(--blue-soft); color:var(--blue); }
  .ico.k-edit { background:var(--gold-soft); color:var(--gold); }
  .ico.k-bash { background:var(--accent-soft); color:var(--accent); }
  .ico.k-read { background:var(--violet-soft); color:var(--violet); }
  .ico.k-user { background:var(--ink); color:#fdf9f2; }
  .row .mid { flex:1; min-width:0; }
  .row .sum { display:block; font-size:13.5px; line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row .raw1 { display:block; font-size:10.5px; color:var(--ink-faint); font-family:ui-monospace,Menlo,monospace;
               white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
  body:not(.tech) .row .raw1 { display:none; }
  .row .route { display:inline-block; font-size:10px; font-weight:800; padding:1px 8px; border-radius:999px; margin-top:2px; }
  .route.cont { background:var(--blue-soft); color:var(--blue); }
  .route.newt { background:var(--gold-soft); color:var(--gold); }
  .row .cnt { flex:none; font-size:10px; font-weight:800; color:var(--gold); background:var(--gold-soft); padding:2px 7px; border-radius:999px; }
  .row .ts { flex:none; font-size:10.5px; color:var(--ink-ghost); font-variant-numeric:tabular-nums; }
  @keyframes slidein { from { opacity:0; transform:translateY(6px); } }
  .row.new { animation:slidein .25s ease-out; }

  /* ── panneau ancré ── */
  .panel { flex:none; width:0; overflow:hidden; border-left:1px solid transparent; background:var(--panel);
           display:flex; flex-direction:column; transition:width .22s ease, border-color .22s; }
  .panel.open { width:min(430px,46vw); border-left-color:var(--line); }
  .panel-inner { width:min(430px,46vw); flex:1; display:flex; flex-direction:column; min-height:0; }
  .phead { flex:none; padding:14px 16px 12px; border-bottom:1px solid var(--line); display:flex; align-items:flex-start; gap:11px; }
  .phead .ico { width:28px; height:28px; font-size:13px; border-radius:9px; }
  .phead .tt { min-width:0; flex:1; }
  .phead .t { font-size:14px; font-weight:700; line-height:1.4; }
  .phead .s { font-size:11px; color:var(--ink-faint); margin-top:3px; font-variant-numeric:tabular-nums; }
  .pnav { display:flex; gap:4px; flex:none; }
  .pnav button { width:26px; height:26px; border:1px solid var(--line); background:var(--panel); border-radius:8px;
                 color:var(--ink-mute); font-size:12px; cursor:pointer; display:grid; place-items:center; }
  .pnav button:disabled { opacity:.3; cursor:default; }
  .pbody { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:14px; }
  .plain { font-size:14px; line-height:1.7; }
  .plain .why { margin-top:8px; font-size:12.5px; color:var(--ink-mute); line-height:1.6; }
  .facts { display:flex; flex-wrap:wrap; gap:6px; }
  .fact { font-size:11px; font-weight:700; background:var(--bg); border:1px solid var(--line); color:var(--ink-mute); padding:4px 10px; border-radius:999px; }
  .fact.ok { background:var(--accent-soft); border-color:transparent; color:var(--accent); }
  details.techbox { border:1px solid var(--line); border-radius:12px; background:var(--bg); overflow:hidden; }
  details.techbox summary { list-style:none; cursor:pointer; padding:10px 14px; font-size:11.5px; font-weight:800;
          letter-spacing:.04em; text-transform:uppercase; color:var(--ink-faint); display:flex; align-items:center; gap:8px; }
  details.techbox summary::-webkit-details-marker { display:none; }
  details.techbox summary::after { content:"▸"; margin-left:auto; transition:transform .15s; }
  details.techbox[open] summary::after { transform:rotate(90deg); }
  .techlist { padding:0 12px 12px; display:flex; flex-direction:column; gap:8px; }
  .titem { border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow:hidden; }
  .titem .th { padding:8px 12px; font-size:11.5px; font-weight:700; color:var(--ink-mute); display:flex; align-items:center; gap:8px; }
  .titem .th .copy { margin-left:auto; border:none; background:none; color:var(--ink-ghost); font-size:11px; cursor:pointer; padding:2px 4px; border-radius:5px; }
  .titem .th .copy:hover { color:var(--ink); background:var(--line-soft); }
  .titem pre { margin:0; border-top:1px solid var(--line-soft); font-family:ui-monospace,Menlo,monospace; font-size:11.5px;
               line-height:1.55; color:#4a4236; padding:9px 12px; overflow:auto; max-height:240px; white-space:pre-wrap; word-break:break-word; }
  .d-text { font-size:13.5px; line-height:1.7; white-space:pre-wrap; }
  .pfoot { flex:none; border-top:1px solid var(--line); padding:9px 16px; font-size:11px; color:var(--ink-ghost); display:flex; gap:10px; }
  .kbd { font-family:ui-monospace,Menlo,monospace; font-size:10px; border:1px solid var(--line); border-bottom-width:2px;
         border-radius:5px; padding:1px 5px; background:var(--panel); color:var(--ink-mute); }

  /* ── boîte d'envoi + routage IA ── */
  .composer { flex:none; border-top:1px solid var(--line); background:var(--panel); padding:10px 14px; }
  .composer .cbar { display:flex; gap:8px; }
  .composer textarea { flex:1; resize:none; border:1px solid var(--line); border-radius:10px; padding:9px 12px; font:inherit; font-size:13px; max-height:110px; background:var(--bg); }
  .composer textarea:focus { outline:2px solid #241f1a22; }
  .composer textarea:disabled { opacity:.5; cursor:not-allowed; }
  .composer button { border:none; border-radius:10px; padding:0 16px; background:var(--ink); color:#fdf9f2; font-weight:700; font-size:13px; cursor:pointer; }
  .composer button:disabled { opacity:.4; cursor:not-allowed; }
  .composer .routing { font-size:11px; color:var(--ink-faint); padding:6px 2px 0; min-height:22px; }
  .composer .routing .r-cont { color:var(--blue); font-weight:700; }
  .composer .routing .r-newt { color:var(--gold); font-weight:700; }
  #statusbar { flex:none; padding:4px 20px; font-size:10.5px; color:var(--ink-ghost); border-top:1px solid var(--line-soft); }
</style>
</head>
<body>
<div id="pickerScreen">
  <h1>Choisis une session</h1>
  <div id="pickerList"><div class="pk-empty">Connexion&#8230;</div></div>
</div>

<div class="app hidden" id="storyScreen">
  <div class="hero">
    <div class="hero-top">
      <span class="pulse" id="pulse"></span>
      <div class="who">
        <div class="h1" id="heroTitle"></div>
        <div class="h2" id="heroSub"></div>
      </div>
      <div class="modewrap"><button id="modeSimple" class="on" type="button">Simple</button><button id="modeTech" type="button">Tech</button></div>
      <button class="sim" id="switchBtn" type="button">&#8646; changer</button>
    </div>
    <div class="plan" id="plan"></div>
  </div>

  <div class="body">
    <div class="feedcol">
      <div class="feed" id="feed"><div class="fspacer"></div><div id="rows"></div></div>
      <div class="composer">
        <div class="cbar">
          <textarea id="msgBox" rows="1" placeholder="Écris à l'agent… (la surcouche classe ton message : suite de la sous-tâche ou nouvelle sous-tâche)"></textarea>
          <button id="sendBtn" type="button">Envoyer</button>
        </div>
        <div class="routing" id="routing"></div>
      </div>
    </div>

    <aside class="panel" id="panel" aria-label="Détail de l'étape">
      <div class="panel-inner">
        <div class="phead">
          <span class="ico" id="pIco"></span>
          <div class="tt"><div class="t" id="pTitle"></div><div class="s" id="pSub"></div></div>
          <div class="pnav"><button id="pPrev" type="button">↑</button><button id="pNext" type="button">↓</button><button id="pClose" type="button">✕</button></div>
        </div>
        <div class="pbody" id="pBody"></div>
        <div class="pfoot"><span class="kbd">↑</span><span class="kbd">↓</span> naviguer · <span class="kbd">Esc</span> fermer</div>
      </div>
    </aside>
  </div>
  <div id="statusbar"></div>
</div>

<script>
var $=function(id){ return document.getElementById(id); };
var esc=function(s){ return String(s==null?"":s).replace(/[&<>]/g,function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); };

${panelBridgeScript("agentproto-session-story-panel")}
// Best-effort: some hosts forward the triggering tool call's arguments as
// a notification so the panel can auto-open the right session. Purely
// additive — the session picker is the reliable path when this never
// arrives.
var pendingSessionId=null;
onHostNotification(function(method, params){
  if(/tool-input|tool-call/.test(method)){
    var args=(params && (params.arguments || params.input)) || {};
    if(args && args.sessionId) pendingSessionId=args.sessionId;
  }
});

// ============================================================
// buildStory — vanilla-JS port of session-story.ts. Kept
// function-for-function identical so the two are easy to diff; the panel
// resource must be fully self-contained (no bundler/dynamic import), so it
// cannot import the TS module directly.
// ============================================================

var SALIENT_KEYS=["file_path","path","filePath","file","command","pattern","query","q","url","todos","description","prompt"];
function truncateStr(v,max){ var o=String(v).replace(/\\s+/g,' ').trim(); return o.length>max? o.slice(0,max-1)+'…':o; }
function formatArgValue(v){
  if(typeof v==='string') return v;
  if(Array.isArray(v)) return v.length+' item'+(v.length===1?'':'s');
  if(v && typeof v==='object') return JSON.stringify(v);
  return String(v);
}
function pickSalient(args){
  for(var i=0;i<SALIENT_KEYS.length;i++){
    var k=SALIENT_KEYS[i], v=args[k];
    if(v!==undefined && v!==null && v!=='') return formatArgValue(v);
  }
  return null;
}
function formatToolCall(name,args){
  name=name||'tool';
  args=(args && typeof args==='object' && !Array.isArray(args)) ? args : {};
  var salient=pickSalient(args);
  if(salient!==null){
    if(name.toLowerCase().indexOf(salient.toLowerCase())>=0) return truncateStr(name,120);
    return truncateStr(name+' '+salient,120);
  }
  if(Object.keys(args).length===0) return name;
  return truncateStr(name+' '+JSON.stringify(args),120);
}
function extractText(v){
  if(v==null) return null;
  if(typeof v==='string') return v;
  if(Array.isArray(v)){
    var parts=v.map(extractText).filter(function(x){ return x!=null; });
    return parts.length? parts.join('\\n') : null;
  }
  if(typeof v==='object'){
    if(typeof v.text==='string') return v.text;
    if(typeof v.message==='string') return v.message;
    if(Array.isArray(v.content)) return extractText(v.content);
    if(typeof v.error==='string') return v.error;
    if(v.error && typeof v.error==='object' && typeof v.error.message==='string') return v.error.message;
    return null;
  }
  return null;
}
function formatToolResult(toolName,result,isError){
  var text=extractText(result);
  if(isError){
    var message=text!=null? text : (result!=null? JSON.stringify(result) : 'failed');
    var firstLine=String(message).split(/\\r?\\n/)[0] || message;
    return truncateStr(firstLine,160);
  }
  if(text==null) return null;
  var trimmed=text.trim();
  if(!trimmed) return null;
  var lines=trimmed.split(/\\r?\\n/);
  if(lines.length>1){
    var bytes=new TextEncoder().encode(trimmed).length;
    return lines.length+' lines, '+bytes+'B';
  }
  return truncateStr(lines[0],160);
}

function classifyKind(toolCalls){
  if(!toolCalls || toolCalls.length===0) return 'text';
  var names=toolCalls.map(function(t){ return t.name.toLowerCase(); });
  if(names.some(function(n){ return /edit|write/.test(n); })) return 'edit';
  if(names.some(function(n){ return /bash|terminal|command/.test(n); })) return 'bash';
  if(names.some(function(n){ return /read|grep|glob/.test(n); })) return 'read';
  return 'text';
}
var NEW_CHAPTER_RE=/\\b(aussi|autre|ensuite|nouveau|nouvelle|plut[oô]t|maintenant|apr[eè]s ça|il faudrait|peux[- ]tu|on pourrait|ajoute|g[eè]re)\\b/iu;
function classifyRoute(text){
  var newt=NEW_CHAPTER_RE.test(text);
  if(!newt) return {route:'cont'};
  var title=text.replace(/[.?!].*$/,'').slice(0,42);
  return {route:'newt', title:title};
}
function formatTsJs(ts){
  if(ts===undefined || ts===null || isNaN(ts)) return '';
  return new Date(ts).toISOString().slice(11,19);
}
function firstMeaningfulLine(text){
  if(!text) return undefined;
  var lines=text.split('\\n').map(function(l){ return l.trim(); }).filter(function(l){ return l.length>0; });
  return lines[0];
}
function lineCountOf(text){
  var n=(text||'').split('\\n').filter(function(l){ return l.trim().length>0; }).length;
  return n||1;
}
function parseArgsJson(s){ try{ return JSON.parse(s); }catch(e){ return {}; } }

function foldToolStep(assistant,toolResults){
  var toolCalls=assistant.toolCalls||[];
  var kind=classifyKind(toolCalls);
  var count=toolCalls.length||1;
  var items=[], facts=[];
  if(assistant.text && assistant.text.trim()) items.push({text:assistant.text.trim()});
  toolCalls.forEach(function(tc,i){
    var args=parseArgsJson(tc.args);
    var h=formatToolCall(tc.name,args);
    var resultMsg=toolResults[i];
    var resultText=(resultMsg && resultMsg.text) || '';
    var isError=resultText.indexOf('[error]')===0;
    var r=isError? resultText.slice(7).trim() : resultText;
    items.push({h:h,r:r});
    var fact=formatToolResult(tc.name,r,isError);
    if(fact) facts.push(fact);
  });
  var firstLine=firstMeaningfulLine(assistant.text);
  var firstToolCall=toolCalls[0];
  var sum=firstLine!==undefined? firstLine : (firstToolCall? formatToolCall(firstToolCall.name,parseArgsJson(firstToolCall.args)) : '…');
  var raw1;
  if(toolCalls.length===0) raw1='assistant · '+lineCountOf(assistant.text)+' ligne(s)';
  else if(toolCalls.length===1) raw1=formatToolCall(firstToolCall.name,parseArgsJson(firstToolCall.args));
  else raw1=(firstToolCall? firstToolCall.name : 'tool')+' ×'+toolCalls.length;
  return {kind:kind, ts:formatTsJs(assistant.ts), sum:sum, raw1:raw1, count:count, facts:facts, items:items};
}
function foldUserStep(msg){
  var text=msg.text||'';
  return {kind:'user', ts:formatTsJs(msg.ts), sum:'« '+truncateStr(text,80)+' »', raw1:'user · '+lineCountOf(text)+' ligne(s)', count:1, facts:[], items:[{text:text}], userText:text};
}
function foldOrphanToolStep(msg){
  var text=msg.text||'';
  var isError=text.indexOf('[error]')===0;
  var r=isError? text.slice(7).trim() : text;
  var name=msg.toolName||'tool';
  var fact=formatToolResult(name,r,isError);
  return {kind:classifyKind([{name:name}]), ts:formatTsJs(msg.ts), sum: msg.toolName? (msg.toolName+' · résultat') : "Résultat d'outil", raw1: msg.toolName||'tool', count:1, facts: fact?[fact]:[], items:[{h:name,r:r}]};
}
function foldSystemStep(msg){
  var text=msg.text||'';
  var line=firstMeaningfulLine(text);
  return {kind:'text', ts:formatTsJs(msg.ts), sum: line!==undefined? line : text, raw1:'system', count:1, facts:[], items: text?[{text:text}]:[]};
}
function foldMessages(messages){
  var steps=[], i=0;
  while(i<messages.length){
    var msg=messages[i];
    if(msg.role==='user'){ steps.push(foldUserStep(msg)); i+=1; continue; }
    if(msg.role==='assistant'){
      var j=i+1, toolResults=[];
      while(j<messages.length && messages[j].role==='tool'){ toolResults.push(messages[j]); j+=1; }
      steps.push(foldToolStep(msg,toolResults)); i=j; continue;
    }
    if(msg.role==='tool'){ steps.push(foldOrphanToolStep(msg)); i+=1; continue; }
    steps.push(foldSystemStep(msg)); i+=1;
  }
  return steps;
}
function buildStoryJs(messages){
  var folded=foldMessages(messages||[]);
  var chapters=[], steps=[];
  var currentChapterId, sawFirstUser=false;
  function closeCurrent(){ var cur=chapters.filter(function(c){ return c.id===currentChapterId; })[0]; if(cur) cur.status='done'; }
  function openChapter(title){ var id='c'+(chapters.length+1); chapters.push({id:id,title:title,status:'cur'}); return id; }
  folded.forEach(function(step){
    var route;
    if(step.kind==='user' && step.userText!==undefined){
      if(!sawFirstUser){ sawFirstUser=true; currentChapterId=openChapter('Cadrage'); }
      else {
        var verdict=classifyRoute(step.userText);
        route=verdict.route;
        if(verdict.route==='newt'){ closeCurrent(); currentChapterId=openChapter(verdict.title||'Nouvelle sous-tâche'); }
      }
    } else if(currentChapterId===undefined){ currentChapterId=openChapter('Cadrage'); }
    var out={chap:currentChapterId, kind:step.kind, ts:step.ts, sum:step.sum, raw1:step.raw1, count:step.count, facts:step.facts, items:step.items};
    if(route) out.route=route;
    steps.push(out);
  });
  return {chapters:chapters, steps:steps};
}

// ============================================================
// App state
// ============================================================
var sessions=[];
var activeSessionId=null;
var story={chapters:[], steps:[]};
var open={};
var selected=-1;
var lastSeenOutputAt=null;
var pollTimer=null, polling=false;
var ICONS={text:["k-text","A"],edit:["k-edit","✎"],bash:["k-bash","▸"],read:["k-read","⌕"],user:["k-user","T"]};
var icoSpec=function(k){ return ICONS[k]||ICONS.text; };
var chapOf=function(id){ return story.chapters.filter(function(c){ return c.id===id; })[0]; };
var curChap=function(){ return story.chapters.filter(function(c){ return c.status==='cur'; })[0] || story.chapters[story.chapters.length-1]; };

function setStatus(msg){ $('statusbar').textContent=msg; }
function nowTs(){ return new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }

function titleOf(s){
  return s.label || s.name || (s.command? s.command.split(/\\s+/)[0].split('/').pop() : null) || s.id.slice(0,8);
}

// ============================================================
// Picker screen
// ============================================================
function renderPicker(){
  var el=$('pickerList');
  if(!sessions.length){ el.innerHTML='<div class="pk-empty">Aucune session</div>'; return; }
  var html='';
  sessions.forEach(function(s){
    html+='<div class="pk-item" data-id="'+esc(s.id)+'">'
        + '<span class="pk-name">'+esc(titleOf(s))+'</span>'
        + '<span class="badge '+esc(s.status)+'">'+esc(s.status)+'</span>'
        + '<span class="pk-meta">'+esc(s.kind||'')+'</span>'
        + '</div>';
  });
  el.innerHTML=html;
  Array.prototype.forEach.call(el.querySelectorAll('.pk-item'), function(row){
    row.onclick=function(){ openSession(row.getAttribute('data-id')); };
  });
}

function showPicker(){
  activeSessionId=null;
  $('pickerScreen').classList.remove('hidden');
  $('storyScreen').classList.add('hidden');
  renderPicker();
}

function openSession(id){
  activeSessionId=id;
  story={chapters:[], steps:[]};
  open={};
  selected=-1;
  lastSeenOutputAt=null;
  $('pickerScreen').classList.add('hidden');
  $('storyScreen').classList.remove('hidden');
  closePanel();
  loadStory().then(renderAll);
}

// ============================================================
// Story loading
// ============================================================
function activeSession(){ return sessions.filter(function(s){ return s.id===activeSessionId; })[0]; }

function loadStory(){
  return callTool('agent_export', {sessionId:activeSessionId, format:'json'}).then(function(data){
    var messages=(data && data.messages) || [];
    story=buildStoryJs(messages);
    // Default open state: only the last (current) chapter is expanded.
    var last=story.chapters[story.chapters.length-1];
    if(last && !(last.id in open)) open[last.id]=true;
  }).catch(function(e){
    setStatus('Erreur export : '+e.message);
  });
}

function canSend(){
  var s=activeSession();
  return !!s && s.kind==='agent-cli' && s.status==='running';
}

function renderComposer(){
  var s=activeSession();
  var box=$('msgBox'), btn=$('sendBtn');
  var enabled=canSend();
  box.disabled=!enabled;
  btn.disabled=!enabled;
  if(!s){ box.placeholder='Session introuvable.'; }
  else if(!enabled) box.placeholder='Lecture seule — session '+esc(s.status)+'.';
  else box.placeholder="Écris à l'agent… (la surcouche classe ton message : suite de la sous-tâche ou nouvelle sous-tâche)";
}

function renderHero(){
  var s=activeSession();
  $('heroTitle').textContent=s? titleOf(s) : (activeSessionId||'');
  var firstUser=story.steps.filter(function(st){ return st.kind==='user'; })[0];
  var mission=firstUser? firstUser.userText || (firstUser.items[0] && firstUser.items[0].text) : null;
  $('heroSub').textContent=mission? truncateStr(mission,200) : 'Aucun message pour le moment.';
  var p=$('pulse');
  p.classList.toggle('off', !(s && (s.status==='running' || s.status==='starting')));
  renderComposer();
}

function renderAll(){
  renderHero();
  renderPlan();
  renderRows('bottom');
}

// ============================================================
// big picture strip
// ============================================================
function renderPlan(){
  var done=story.chapters.filter(function(c){ return c.status==='done'; }).length;
  $('plan').innerHTML=story.chapters.map(function(c,i){
    return '<span class="pt '+c.status+'" data-c="'+esc(c.id)+'"><span class="st">'+(c.status==='done'?'✓':'●')+'</span>'+(i+1)+'. '+esc(c.title)+'</span>';
  }).join('') + '<span class="pt" style="cursor:default"><b>'+done+'/'+story.chapters.length+'</b>&nbsp;faites</span>';
  Array.prototype.forEach.call($('plan').querySelectorAll('.pt[data-c]'), function(el){
    el.onclick=function(){ open[el.getAttribute('data-c')]=true; renderRows(); jumpToChap(el.getAttribute('data-c')); };
  });
}
function jumpToChap(cid){
  var el=document.querySelector('.chap[data-c="'+cid+'"]');
  if(el) el.scrollIntoView({block:'start',behavior:'smooth'});
}

// ============================================================
// feed segmenté par chapitres
// ============================================================
function rowHtml(s,i,isNew){
  var spec=icoSpec(s.kind), cls=spec[0], ch=spec[1];
  var route=s.route? '<span class="route '+(s.route==='newt'?'newt':'cont')+'">'+(s.route==='newt'?'★ nouvelle sous-tâche':'↳ suite')+'</span>' : '';
  return '<div class="row '+(isNew?'new':'')+'" aria-selected="'+(i===selected)+'" data-i="'+i+'">'
    + '<span class="ico '+cls+'">'+ch+'</span>'
    + '<span class="mid"><span class="sum">'+esc(s.sum)+'</span><span class="raw1">'+esc(s.raw1||'')+'</span>'+route+'</span>'
    + (s.count>1? '<span class="cnt">×'+s.count+'</span>':'') + '<span class="ts">'+esc(s.ts||'')+'</span>'
    + '</div>';
}
function renderRows(keepScroll,newIdx){
  var feed=$('feed');
  var prevH=feed.scrollHeight, prevTop=feed.scrollTop;
  var html='';
  story.chapters.forEach(function(c,ci){
    var chapSteps=[];
    story.steps.forEach(function(s,i){ if(s.chap===c.id) chapSteps.push({s:s,i:i}); });
    if(!chapSteps.length) return;
    var isOpen=!!open[c.id];
    html+='<div class="chap '+c.status+' '+(isOpen?'open':'')+'" data-c="'+esc(c.id)+'">'
      + '<span class="cst">'+(c.status==='done'?'✓':'●')+'</span><span class="cnum">'+(ci+1)+'.</span>'
      + '<span class="csum">'+esc(c.title)+'</span>'
      + '<span class="cmeta">'+chapSteps.length+' étape'+(chapSteps.length>1?'s':'')+'</span><span class="cchev">▸</span>'
      + '</div>';
    if(isOpen) html += chapSteps.map(function(x){ return rowHtml(x.s,x.i,x.i===newIdx); }).join('');
  });
  $('rows').innerHTML=html;
  Array.prototype.forEach.call(document.querySelectorAll('.row'), function(el){
    el.onclick=function(){ selectStep(Number(el.getAttribute('data-i'))); };
  });
  Array.prototype.forEach.call(document.querySelectorAll('.chap'), function(el){
    el.onclick=function(){ var c=el.getAttribute('data-c'); open[c]=!open[c]; renderRows(); };
  });
  if(keepScroll==='bottom') feed.scrollTop=feed.scrollHeight;
  else if(keepScroll==='preserve') feed.scrollTop=feed.scrollHeight-prevH+prevTop;
}

// ============================================================
// panneau ancré
// ============================================================
function selectStep(i){
  selected=i;
  var s=story.steps[i]; if(!s) return;
  open[s.chap]=true;
  $('panel').classList.add('open');
  var spec=icoSpec(s.kind), cls=spec[0], ch=spec[1];
  var ico=$('pIco'); ico.className='ico '+cls; ico.textContent=ch;
  $('pTitle').textContent=s.sum;
  var c=chapOf(s.chap);
  $('pSub').textContent=(s.ts? s.ts+' · ':'')+(c? ('sous-tâche : '+c.title) : '');
  var facts=(s.facts||[]).map(function(f){
    return '<span class="fact '+(/✓|exit 0|passed|0 match/.test(f)?'ok':'')+'">'+esc(f)+'</span>';
  }).join('');
  var tech=(s.items||[]).map(function(it,k){
    return it.text!==undefined
      ? '<div class="d-text">'+esc(it.text)+'</div>'
      : '<div class="titem"><div class="th">'+esc(it.h)+'<button class="copy" data-k="'+k+'" type="button">⧉</button></div><pre>'+esc(it.r)+'</pre></div>';
  }).join('');
  $('pBody').innerHTML=''
    + '<div class="plain"><div>'+esc(s.sum)+'.</div><div class="why">'+esc(s.why||'')+'</div></div>'
    + (facts? '<div class="facts">'+facts+'</div>':'')
    + '<details class="techbox" '+(document.body.classList.contains('tech')?'open':'')+'>'
    + '<summary>Détail technique · '+(s.items||[]).length+'</summary><div class="techlist">'+tech+'</div>'
    + '</details>';
  Array.prototype.forEach.call($('pBody').querySelectorAll('.copy'), function(btn){
    btn.onclick=function(e){
      e.stopPropagation();
      var it=(s.items||[])[Number(btn.getAttribute('data-k'))];
      var payload=(it.h||'')+'\\n'+(it.r||it.text||'');
      if(navigator.clipboard) navigator.clipboard.writeText(payload).catch(function(){});
      btn.textContent='✓'; setTimeout(function(){ btn.textContent='⧉'; },900);
    };
  });
  $('pPrev').disabled=i<=0; $('pNext').disabled=i>=story.steps.length-1;
  renderRows();
  var el=document.querySelector('.row[data-i="'+i+'"]');
  if(el) el.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function closePanel(){ selected=-1; var p=$('panel'); if(p) p.classList.remove('open'); renderRows(); }
$('pClose').addEventListener('click',closePanel);
$('pPrev').addEventListener('click',function(){ if(selected>0) selectStep(selected-1); });
$('pNext').addEventListener('click',function(){ if(selected<story.steps.length-1) selectStep(selected+1); });
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){ closePanel(); return; }
  if($('storyScreen').classList.contains('hidden')) return;
  if(selected<0 || e.target.tagName==='TEXTAREA') return;
  if(e.key==='ArrowUp'){ e.preventDefault(); if(selected>0) selectStep(selected-1); }
  if(e.key==='ArrowDown'){ e.preventDefault(); if(selected<story.steps.length-1) selectStep(selected+1); }
});

// ============================================================
// Simple / Tech modes
// ============================================================
function setMode(tech){
  document.body.classList.toggle('tech',tech);
  $('modeTech').classList.toggle('on',tech);
  $('modeSimple').classList.toggle('on',!tech);
  if(selected>=0) selectStep(selected);
}
$('modeSimple').addEventListener('click',function(){ setMode(false); });
$('modeTech').addEventListener('click',function(){ setMode(true); });
$('switchBtn').addEventListener('click', function(){ if(pollTimer) clearTimeout(pollTimer); showPicker(); doPoll(); });

// ============================================================
// composer — local chapter-routing classification + agent_prompt
// ============================================================
$('sendBtn').addEventListener('click', sendMsg);
$('msgBox').addEventListener('keydown', function(e){
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMsg(); }
});
function sendMsg(){
  if(!canSend()) return;
  var box=$('msgBox'), text=box.value.trim();
  if(!text) return;
  box.value='';
  var cur=curChap();
  var r=cur? classifyRoute(text) : {route:'cont'};
  var chapId=cur? cur.id : null;
  if(r.route==='newt' && cur){
    cur.status='done';
    var id='c'+(story.chapters.length+1);
    story.chapters.push({id:id, title:r.title||'Nouvelle sous-tâche', status:'cur'});
    chapId=id; open[id]=true;
    $('routing').innerHTML='✦ classé : <span class="r-newt">★ nouvelle sous-tâche « '+esc(r.title||'')+' »</span>';
  } else {
    $('routing').innerHTML='✦ classé : <span class="r-cont">↳ suite de « '+esc(cur? cur.title : '')+' »</span>';
  }
  setTimeout(function(){ $('routing').textContent=''; },5000);
  story.steps.push({
    chap:chapId, kind:'user', ts:nowTs(),
    sum:'« '+text.slice(0,80)+(text.length>80?'…':'')+' »',
    raw1:'user · '+text.split('\\n').length+' ligne(s)',
    route:r.route, facts:[], items:[{text:text}], userText:text,
  });
  renderPlan(); renderRows('bottom', story.steps.length-1);
  callTool('agent_prompt', {sessionId:activeSessionId, prompt:text}).catch(function(e){
    setStatus('Envoi échoué : '+e.message);
  });
}

// ============================================================
// Poll — session_list every ~5s; re-fetch agent_export only on turn
// boundaries (lastOutputAt changed for the active session).
// ============================================================
var POLL_MS=5000;
function loadSessions(){
  return callTool('session_list', {kind:'all'}).then(function(data){
    sessions=data.sessions||[];
    if($('pickerScreen') && !$('pickerScreen').classList.contains('hidden')) renderPicker();
  }).catch(function(e){ setStatus('Erreur : '+e.message); });
}
function doPoll(){
  if(polling) return;
  polling=true;
  loadSessions().then(function(){
    if(!activeSessionId){ polling=false; pollTimer=setTimeout(doPoll,POLL_MS); return; }
    var s=activeSession();
    if(!s){ polling=false; pollTimer=setTimeout(doPoll,POLL_MS); return; }
    renderHero();
    var changed=s.lastOutputAt && s.lastOutputAt!==lastSeenOutputAt;
    if(changed){
      lastSeenOutputAt=s.lastOutputAt;
      loadStory().then(function(){ renderPlan(); renderRows('bottom'); polling=false; pollTimer=setTimeout(doPoll,POLL_MS); });
    } else {
      polling=false; pollTimer=setTimeout(doPoll,POLL_MS);
    }
  }).catch(function(){ polling=false; pollTimer=setTimeout(doPoll,POLL_MS); });
}

// ============================================================
// Boot
// ============================================================
initBridge().then(loadSessions).then(function(){
  setTimeout(function(){
    var target=pendingSessionId && sessions.some(function(s){ return s.id===pendingSessionId; })
      ? pendingSessionId
      : null;
    if(!target){
      var agentSessions=sessions.filter(function(s){ return s.kind==='agent-cli'; });
      if(agentSessions.length===1) target=agentSessions[0].id;
    }
    if(target) openSession(target); else showPicker();
    pollTimer=setTimeout(doPoll,POLL_MS);
  }, 50);
}).catch(function(e){
  setStatus('Bridge : '+e.message);
  $('pickerList').innerHTML='<div class="pk-empty">Échec connexion bridge : '+esc(e.message)+'</div>';
});
</script>
</body>
</html>`
