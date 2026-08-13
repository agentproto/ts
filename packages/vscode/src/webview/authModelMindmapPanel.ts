/**
 * Auth / model mind map — the VS Code editor-tab webview (viewType
 * `agentproto.authModel`, opened by `agentproto.openAuthModel`).
 *
 * The real, live successor to the approved design mock: harnesses on the left,
 * providers + their wallets on the right, a local-router relay between them,
 * and a computed `reach` classification on every edge. All data is LIVE from
 * the daemon via {@link DaemonClient} — adapters, harness capabilities, auth
 * profiles, llm-endpoint status — shaped by the pure {@link buildAuthModel}.
 *
 * This is a READ-ONLY visualisation first: it explains the configuration. The
 * one mutating affordance in the mock — "+ add wallet" — is rendered as a
 * clearly-disabled seam here; wiring it to the existing `auth_profile_create`
 * flow is a follow-up, deliberately out of this task's scope.
 *
 * HTML is an inline, self-contained string (CSP `default-src 'none'` + a
 * per-open nonce on the single inline script), following the sessions/transcript
 * webview convention. `buildAuthModelHtml` is exported so a jsdom test can drive
 * the exact shipped renderer.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type {
  AdapterInfo,
  AuthProfileSummary,
  HarnessCapabilities,
  LlmEndpointStatusResult,
} from "../client/types.js"
import { buildAuthModel, type AuthModelView } from "./authModelMindmap.logic.js"

const VIEW_TYPE = "agentproto.authModel"

/** A specific node to select on open — mirrors the map's own click-to-focus
 *  (`focusHarness`/`focusProvider`), driven from outside instead of a click.
 *  Used by the Harnesses webview's wallet badge to land on a harness's
 *  billing provider instead of the default overview drawer. */
export interface AuthModelFocusTarget {
  kind: "harness" | "provider"
  key: string
}

/** host → webview */
type HostMessage = { type: "model"; view: AuthModelView } | { type: "focus"; target: AuthModelFocusTarget }
/** webview → host */
type WebviewToHostMessage = { type: "ready" } | { type: "refresh" }

function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  )
}

export interface AuthModelPanel {
  open(focus?: AuthModelFocusTarget): void
}

export function registerAuthModelMindmap(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
): AuthModelPanel {
  let panel: vscode.WebviewPanel | undefined
  // Set by open() when the panel doesn't exist yet — the webview isn't ready
  // to receive a `focus` message until its first `ready`/model round-trip, so
  // this rides along with the first post() rather than firing blind.
  let pendingFocus: AuthModelFocusTarget | undefined

  async function fetchView(): Promise<AuthModelView> {
    const [adapters, capabilities, profiles, router] = await Promise.all([
      client.listAdapters().catch((): AdapterInfo[] => []),
      client.harnessCapabilities().catch((): HarnessCapabilities[] => []),
      client.listAuthProfiles().catch((): AuthProfileSummary[] => []),
      client.llmEndpointStatus().catch((): LlmEndpointStatusResult | null => null),
    ])
    return buildAuthModel({ adapters, capabilities, profiles, router })
  }

  async function post(): Promise<void> {
    if (!panel) return
    const view = await fetchView()
    void panel.webview.postMessage({ type: "model", view } satisfies HostMessage)
  }

  function postFocus(target: AuthModelFocusTarget): void {
    if (!panel) return
    void panel.webview.postMessage({ type: "focus", target } satisfies HostMessage)
  }

  return {
    open(focus?: AuthModelFocusTarget): void {
      if (panel) {
        panel.reveal(vscode.ViewColumn.One, false)
        if (focus) postFocus(focus)
        return
      }
      pendingFocus = focus
      panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        "Auth & model map",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      )

      panel.webview.onDidReceiveMessage(
        (raw: unknown) => {
          if (!isWebviewToHostMessage(raw)) return
          if (raw.type === "ready" || raw.type === "refresh") {
            void post().then(() => {
              if (raw.type === "ready" && pendingFocus) {
                postFocus(pendingFocus)
                pendingFocus = undefined
              }
            })
          }
        },
        undefined,
        ctx.subscriptions,
      )

      panel.onDidDispose(() => {
        panel = undefined
      })

      panel.webview.html = buildAuthModelHtml(randomNonce())
    },
  }
}

function randomNonce(): string {
  // CSP nonce — must be unguessable, so use a CSPRNG, not Math.random().
  return randomBytes(16).toString("hex")
}

/**
 * The self-contained mind-map document. Inline CSS + a single nonce'd script
 * that renders whatever `{ type: "model" }` the host posts. Exported for tests.
 */
export function buildAuthModelHtml(nonce: string): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>agentproto auth &amp; model map</title>
  <style>
    :root{
      --ink:#1b1b1c; --ink-2:#232324; --ink-3:#1f1f20; --ink-4:#191919;
      --edge:#333335; --edge-soft:#2a2a2b;
      --paper:#f4f0e6; --paper-70:rgba(244,240,230,.72); --paper-45:rgba(244,240,230,.45);
      --paper-28:rgba(244,240,230,.28); --paper-tint:rgba(244,240,230,.055);
      --phosphor:#2f9e63; --phosphor-tint:rgba(47,158,99,.12); --phosphor-line:rgba(47,158,99,.42);
      --ochre:#c2a05c; --ochre-tint:rgba(194,160,92,.12); --ochre-line:rgba(194,160,92,.45);
      --clay:#bd6a5f; --clay-tint:rgba(189,106,95,.12); --clay-line:rgba(189,106,95,.4);
      --steel:#7d95ad; --steel-tint:rgba(125,149,173,.12); --steel-line:rgba(125,149,173,.4);
      --mono:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,monospace;
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{margin:0;background:var(--ink);color:var(--paper);font:13px/1.5 var(--mono);overflow:hidden}
    button{font-family:var(--mono);cursor:pointer}
    .top{display:flex;align-items:baseline;gap:16px;padding:14px 20px 11px;border-bottom:1px solid var(--edge-soft)}
    .top h1{font-size:13px;font-weight:700;margin:0}
    .top h1 .dim{color:var(--paper-28);font-weight:400}
    .top .sub{font-size:10.5px;color:var(--paper-45)}
    .top .spacer{margin-left:auto}
    .btn{font:600 10px var(--mono);padding:5px 11px;border-radius:6px;border:1px solid var(--edge);background:transparent;color:var(--paper-45)}
    .btn:hover{color:var(--paper);border-color:var(--paper-45)}
    .stage{display:flex;height:calc(100vh - 48px)}
    .canvaswrap{position:relative;flex:1 1 auto;min-width:0;overflow:hidden}
    #wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}
    .lanes{position:absolute;inset:0;display:flex;z-index:2;padding:14px 8px}
    .lane{flex:1 1 0;display:flex;flex-direction:column;justify-content:center;gap:12px;padding:0 10px;position:relative;overflow-y:auto}
    .lane.mid{flex:0 0 158px}
    .lane .cap{position:absolute;top:2px;font-size:8px;font-weight:700;letter-spacing:.15em;color:var(--paper-28)}
    .cap.l{left:12px}.cap.r{right:12px}.cap.c{left:0;width:100%;text-align:center}
    .node{border:1px solid var(--edge);border-radius:9px;background:var(--ink-3);padding:9px 11px;position:relative;transition:border-color .16s,background .16s,opacity .16s;user-select:none}
    .node:hover{border-color:var(--paper-45)}
    .node .nm{font-size:12px;font-weight:700;display:flex;align-items:center;gap:7px}
    .node .meta{font-size:9px;color:var(--paper-45);margin-top:3px;line-height:1.5}
    .node .meta b{color:var(--paper-70);font-weight:600}
    .node.dim{opacity:.24;filter:saturate(.4)}
    .node.sel{border-color:var(--phosphor);background:var(--phosphor-tint)}
    .node .badge{margin-left:auto;font-size:7.5px;font-weight:700;letter-spacing:.06em;padding:2px 6px;border-radius:99px;border:1px solid var(--edge);color:var(--paper-45)}
    .kinds{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}
    .pill{font-size:7.5px;font-weight:700;letter-spacing:.05em;padding:2px 6px;border-radius:99px;border:1px solid var(--edge);color:var(--paper-45);white-space:nowrap}
    .pill.sub{color:var(--phosphor);border-color:var(--phosphor-line);background:var(--phosphor-tint)}
    .pill.key{color:var(--steel);border-color:var(--steel-line);background:var(--steel-tint)}
    .router{border-style:dashed;border-color:var(--ochre-line);background:transparent;text-align:center;opacity:.5}
    .router.active{opacity:1;background:var(--ochre-tint);border-style:solid}
    .router .nm{justify-content:center;color:var(--ochre)}
    .node .rtag{position:absolute;top:-8px;right:9px;font-size:7px;font-weight:700;letter-spacing:.09em;padding:1px 6px;border-radius:99px;background:var(--ink);border:1px solid var(--edge)}
    .rtag.native{color:var(--phosphor);border-color:var(--phosphor-line)}
    .rtag.router{color:var(--ochre);border-color:var(--ochre-line)}
    .rtag.fixed{color:var(--steel);border-color:var(--steel-line)}
    .rtag.blocked{color:var(--clay);border-color:var(--clay-line)}
    .drawer{flex:0 0 330px;border-left:1px solid var(--edge-soft);background:var(--ink-4);padding:16px 16px 40px;overflow-y:auto}
    .drawer h2{font-size:8px;font-weight:700;letter-spacing:.17em;color:var(--paper-28);margin:0 0 10px}
    .dh{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
    .dsub{font-size:10px;color:var(--paper-45);margin-top:5px;line-height:1.6}
    .drawer code{background:var(--ink-2);border:1px solid var(--edge);padding:1px 5px;border-radius:4px;color:var(--paper-70);font-size:10px}
    .fact{display:flex;gap:10px;margin-top:8px;font-size:10.5px;line-height:1.5}
    .fact .k{flex:0 0 84px;color:var(--paper-28);font-size:8.5px;letter-spacing:.08em;font-weight:700;padding-top:1px}
    .fact .v{color:var(--paper-70)}
    .divider{height:1px;background:var(--edge-soft);margin:14px 0}
    .grp{font-size:8px;font-weight:700;letter-spacing:.13em;margin:12px 0 7px;display:flex;align-items:center;gap:7px}
    .grp .dot{width:7px;height:7px;border-radius:50%}
    .grp.native{color:var(--phosphor)}.grp.native .dot{background:var(--phosphor)}
    .grp.router{color:var(--ochre)}.grp.router .dot{background:var(--ochre)}
    .grp.fixed{color:var(--steel)}.grp.fixed .dot{background:var(--steel)}
    .row{display:flex;align-items:baseline;gap:8px;font-size:10.5px;padding:3px 0;color:var(--paper-70)}
    .row .why{color:var(--paper-28);font-size:9px;margin-left:auto;text-align:right;max-width:150px;line-height:1.4}
    .wcard{border:1px solid var(--edge);border-radius:8px;background:var(--ink-3);padding:9px 10px;margin-top:8px}
    .wcard .wtop{display:flex;align-items:center;gap:8px}
    .wcard .wname{font-size:11px;font-weight:700}
    .wcard .kchip{margin-left:auto;font-size:7.5px;font-weight:700;letter-spacing:.05em;padding:2px 7px;border-radius:99px;border:1px solid var(--edge)}
    .kchip.sub{color:var(--phosphor);border-color:var(--phosphor-line);background:var(--phosphor-tint)}
    .kchip.key{color:var(--steel);border-color:var(--steel-line);background:var(--steel-tint)}
    .wcard .wmeta{font-size:9px;color:var(--paper-45);margin-top:5px;line-height:1.6}
    .wcard .wmeta b{color:var(--paper-70);font-weight:600}
    .kdot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:middle}
    .kdot.refresh{background:var(--phosphor)}.kdot.stored{background:var(--ochre)}.kdot.unavailable{background:var(--clay)}
    .addslot{border:1px dashed var(--edge);border-radius:8px;padding:8px 10px;margin-top:8px;color:var(--paper-28);font-size:9.5px;text-align:center}
    .morebtn{width:100%;margin-top:10px;font:600 10px var(--mono);padding:7px;border-radius:8px;border:1px dashed var(--edge);background:transparent;color:var(--paper-45)}
    .morebtn:hover{color:var(--paper);border-color:var(--paper-45)}
    .legend{display:flex;flex-direction:column;gap:6px;margin-top:6px}
    .legend .li{display:flex;align-items:center;gap:7px;font-size:9.5px;color:var(--paper-45)}
    .legend .sw{width:16px;height:0;border-top:2px solid}
    .seam{font-size:9px;color:var(--paper-28);line-height:1.6;margin-top:8px;padding-left:10px;border-left:2px solid var(--edge)}
    .empty{color:var(--paper-45);font-size:11px;padding:20px}
    .foot{font-size:8.5px;color:var(--paper-28);padding:7px 20px;border-top:1px solid var(--edge-soft)}
  </style>
</head>
<body>
  <div class="top">
    <h1>auth &amp; model <span class="dim">/ configuration map</span></h1>
    <span class="sub">harnesses ⇢ router ⇢ providers &amp; wallets · live</span>
    <span class="spacer"></span>
    <button class="btn" id="refresh">⟲ refresh</button>
  </div>
  <div class="stage">
    <div class="canvaswrap">
      <svg id="wires"></svg>
      <div class="lanes">
        <div class="lane" id="lane-h"><div class="cap l">HARNESSES</div></div>
        <div class="lane mid" id="lane-r"><div class="cap c">RELAY</div></div>
        <div class="lane" id="lane-p"><div class="cap r">PROVIDERS &amp; WALLETS</div></div>
      </div>
    </div>
    <aside class="drawer" id="drawer"></aside>
  </div>
  <div class="foot" id="foot">Click a harness to see what it can reach · click a provider to open its wallets · click the relay for the local router.</div>

  <script nonce="${nonce}">
  (function(){
    var vscode = acquireVsCodeApi();
    var laneH = document.getElementById('lane-h');
    var laneR = document.getElementById('lane-r');
    var laneP = document.getElementById('lane-p');
    var wires = document.getElementById('wires');
    var drawer = document.getElementById('drawer');
    var SVGNS = 'http://www.w3.org/2000/svg';
    var view = null;
    var nodeEls = {};   // key -> element  (h:<slug>, p:<endpoint>, router)
    var routerEl = null;
    var showAllProviders = false;

    function el(tag, cls, text){ var e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
    function COL(s){ return s==='native'?'var(--phosphor)':s==='via-router'?'var(--ochre)':s==='fixed'?'var(--steel)':'var(--clay)'; }
    function kindClass(k){ return k==='api-key'?'key':'sub'; }
    function kindLabel(k){ return k==='subscription-refreshing'?'SUB · SELF-REFRESH':k==='subscription-stored'?'SUB · STORED':'API KEY'; }
    function keyDot(s){ return s==='self-refreshing'?'refresh':s==='unavailable'?'unavailable':'stored'; }
    function reachLabel(s){ return s==='native'?'NATIVE':s==='via-router'?'ROUTER':s==='fixed'?'FIXED':'BLOCKED'; }

    // ---- render nodes from the live view ----
    function render(){
      laneH.querySelectorAll('.node').forEach(function(n){ n.remove(); });
      laneR.querySelectorAll('.node').forEach(function(n){ n.remove(); });
      laneP.querySelectorAll('.node').forEach(function(n){ n.remove(); });
      nodeEls = {};
      if(!view){ return; }

      view.harnesses.forEach(function(h){
        var n = el('div','node harness');
        var nm = el('div','nm'); nm.appendChild(el('span',null,h.slug));
        var badge = el('span','badge', h.route); nm.appendChild(badge);
        n.appendChild(nm);
        n.appendChild(el('div','meta','speaks ' + h.speaks + (h.acceptsBaseUrl?' · base_url ✓':'')));
        n.onclick = function(e){ e.stopPropagation(); focusHarness(h.slug); };
        laneH.appendChild(n);
        nodeEls['h:'+h.slug] = n;
      });

      routerEl = el('div','node router');
      var rnm = el('div','nm'); rnm.appendChild(el('span',null,'local router'));
      routerEl.appendChild(rnm);
      var rstate = view.router.running ? (view.router.healthy?'running':'starting') : 'stopped';
      routerEl.appendChild(el('div','meta','llm-endpoint · ' + rstate + (view.router.port?(' · :'+view.router.port):'')));
      routerEl.onclick = function(e){ e.stopPropagation(); focusRouter(); };
      laneR.appendChild(routerEl);
      nodeEls['router'] = routerEl;

      var provs = view.providers.filter(function(p){ return showAllProviders || p.primary; });
      provs.forEach(function(p){ laneP.appendChild(providerNode(p)); });
      var hidden = view.providers.length - provs.length;
      if(hidden > 0 || (showAllProviders && view.providers.length > 6)){
        var more = el('button','morebtn', showAllProviders ? '▲ fewer providers' : ('▾ ' + hidden + ' more provider' + (hidden===1?'':'s')));
        more.onclick = function(e){ e.stopPropagation(); showAllProviders = !showAllProviders; render(); resetFocus(); };
        laneP.appendChild(more);
      }
      resetFocus();
    }

    function providerNode(p){
      var n = el('div','node provider');
      var nm = el('div','nm'); nm.appendChild(el('span',null,p.endpoint));
      if(p.wallets.length > 1){ nm.appendChild(el('span','badge', p.wallets.length + ' wallets')); }
      n.appendChild(nm);
      n.appendChild(el('div','meta','native ' + p.native));
      var kinds = el('div','kinds');
      if(p.subscriptionCount){ kinds.appendChild(el('span','pill sub','SUB ×' + p.subscriptionCount)); }
      if(p.apiKeyCount){ kinds.appendChild(el('span','pill key','API KEY ×' + p.apiKeyCount)); }
      n.appendChild(kinds);
      n.onclick = function(e){ e.stopPropagation(); focusProvider(p.endpoint); };
      nodeEls['p:'+p.endpoint] = n;
      return n;
    }

    // ---- edges (SVG) ----
    function center(node){
      var c = wires.getBoundingClientRect(); var r = node.getBoundingClientRect();
      return { l:{x:r.left-c.left, y:r.top-c.top+r.height/2}, r:{x:r.right-c.left, y:r.top-c.top+r.height/2} };
    }
    function path(a,b,color,dash,w){
      var dx=(b.x-a.x)*0.5; var p=document.createElementNS(SVGNS,'path');
      p.setAttribute('d','M '+a.x+' '+a.y+' C '+(a.x+dx)+' '+a.y+', '+(b.x-dx)+' '+b.y+', '+b.x+' '+b.y);
      p.setAttribute('fill','none'); p.setAttribute('stroke',color); p.setAttribute('stroke-width',w||2);
      if(dash){ p.setAttribute('stroke-dasharray',dash); } p.setAttribute('opacity','0.9'); wires.appendChild(p);
    }
    function clearWires(){ while(wires.firstChild){ wires.removeChild(wires.firstChild); } }

    function drawEdges(pairs){
      clearWires(); var routed=false;
      pairs.forEach(function(pr){
        var hn=nodeEls['h:'+pr.h], pn=nodeEls['p:'+pr.p];
        if(!hn||!pn){ return; }
        if(pr.state==='via-router'){
          routed=true;
          path(center(hn).r, center(routerEl).l, COL('via-router'), '5 4', 2);
          path(center(routerEl).r, center(pn).l, COL('via-router'), '5 4', 2);
        } else {
          path(center(hn).r, center(pn).l, COL(pr.state), pr.state==='blocked'?'2 4':null, 2);
        }
      });
      routerEl.classList.toggle('active', routed);
      return routed;
    }

    // ---- focus states ----
    function clearStates(){
      Object.keys(nodeEls).forEach(function(k){
        var n=nodeEls[k]; n.classList.remove('dim','sel','reach-native','reach-router','reach-fixed');
        var t=n.querySelector('.rtag'); if(t){ t.remove(); }
      });
      if(routerEl){ routerEl.classList.remove('active','sel','dim'); }
    }
    function tag(node,state){ var t=el('div','rtag '+ (state==='via-router'?'router':state), reachLabel(state)); node.appendChild(t); }

    function focusHarness(slug){
      clearStates();
      var h = view.harnesses.find(function(x){ return x.slug===slug; });
      if(!h){ return; }
      nodeEls['h:'+slug].classList.add('sel');
      view.harnesses.forEach(function(o){ if(o.slug!==slug){ nodeEls['h:'+o.slug].classList.add('dim'); } });
      var pairs=[]; var routed=false;
      currentProviders().forEach(function(p){
        var st = h.reach[p.endpoint];
        if(!st){ nodeEls['p:'+p.endpoint].classList.add('dim'); return; }
        if(st==='via-router'){ routed=true; }
        tag(nodeEls['p:'+p.endpoint], st);
        pairs.push({h:slug, p:p.endpoint, state:st});
      });
      if(!routed && routerEl){ routerEl.classList.add('dim'); }
      drawEdges(pairs);
      renderHarnessDrawer(h);
    }

    function focusProvider(endpoint){
      clearStates();
      var p = view.providers.find(function(x){ return x.endpoint===endpoint; });
      if(!p){ return; }
      nodeEls['p:'+endpoint].classList.add('sel');
      currentProviders().forEach(function(o){ if(o.endpoint!==endpoint){ nodeEls['p:'+o.endpoint].classList.add('dim'); } });
      var pairs=[]; var routed=false;
      view.harnesses.forEach(function(h){
        var st = h.reach[endpoint];
        if(!st){ nodeEls['h:'+h.slug].classList.add('dim'); return; }
        if(st==='via-router'){ routed=true; }
        tag(nodeEls['h:'+h.slug], st);
        pairs.push({h:h.slug, p:endpoint, state:st});
      });
      if(!routed && routerEl){ routerEl.classList.add('dim'); }
      drawEdges(pairs);
      renderProviderDrawer(p);
    }

    function focusRouter(){
      clearStates();
      routerEl.classList.add('sel');
      var pairs=[];
      view.harnesses.forEach(function(h){
        var uses=false;
        currentProviders().forEach(function(p){ if(h.reach[p.endpoint]==='via-router'){ uses=true; pairs.push({h:h.slug,p:p.endpoint,state:'via-router'}); } });
        if(!uses){ nodeEls['h:'+h.slug].classList.add('dim'); }
      });
      currentProviders().forEach(function(p){
        var used = view.harnesses.some(function(h){ return h.reach[p.endpoint]==='via-router'; });
        if(!used){ nodeEls['p:'+p.endpoint].classList.add('dim'); }
      });
      drawEdges(pairs);
      renderRouterDrawer();
    }

    function currentProviders(){ return view.providers.filter(function(p){ return showAllProviders || p.primary; }); }
    function resetFocus(){ clearStates(); clearWires(); defaultDrawer(); }

    // ---- drawers ----
    function defaultDrawer(){
      if(!view){ drawer.innerHTML=''; drawer.appendChild(el('div','empty','Loading live configuration…')); return; }
      drawer.innerHTML='';
      drawer.appendChild(el('h2','','HOW TO READ THIS'));
      drawer.appendChild(el('div','dh','The whole config, one picture'));
      var s=el('div','dsub'); s.innerHTML='Three columns: the <b>harnesses</b> you run, the optional <b>local router</b>, and the <b>providers</b> that hold your wallets. A line means "can reach". Click any node to focus it.'; drawer.appendChild(s);
      drawer.appendChild(el('div','divider'));
      drawer.appendChild(el('h2','','COMPATIBILITY'));
      var lg=el('div','legend');
      lg.appendChild(legendItem('var(--phosphor)',false,'native — interfaces match'));
      lg.appendChild(legendItem('var(--ochre)',true,'via local router'));
      lg.appendChild(legendItem('var(--steel)',false,'fixed single-provider'));
      drawer.appendChild(lg);
      drawer.appendChild(el('div','divider'));
      drawer.appendChild(el('h2','','THE KEY IDEA'));
      var k=el('div','dsub'); k.innerHTML='A provider is <b>not one credential</b>. It can hold several <b>wallets</b> side by side — a self-refreshing <b>subscription</b>, a stored bearer, an <b>API key</b> — each a distinct billing identity. Click a provider to see its wallet stack.'; drawer.appendChild(k);
      drawer.appendChild(el('div','divider'));
      drawer.appendChild(el('h2','','KNOWN SEAMS'));
      view.seams.forEach(function(t){ drawer.appendChild(el('div','seam',t)); });
    }
    function legendItem(color,dashed,text){ var li=el('div','li'); var sw=el('span','sw'); sw.style.borderColor=color; if(dashed){ sw.style.borderTopStyle='dashed'; } li.appendChild(sw); li.appendChild(el('span',null,text)); return li; }

    function renderHarnessDrawer(h){
      drawer.innerHTML='';
      drawer.appendChild(el('h2','','HARNESS'));
      drawer.appendChild(el('div','dh',h.slug));
      drawer.appendChild(el('div','divider'));
      drawer.appendChild(el('h2','','MANIFEST FACTS'));
      drawer.appendChild(fact('SPEAKS', h.speaks));
      drawer.appendChild(fact('ROUTE', h.route));
      drawer.appendChild(fact('BASE_URL', h.acceptsBaseUrl?'accepts a custom base_url':'no base_url override'));
      drawer.appendChild(el('div','divider'));
      drawer.appendChild(el('h2','','CAN REACH'));
      var groups={native:[],'via-router':[],fixed:[]};
      currentProviders().forEach(function(p){ var st=h.reach[p.endpoint]; if(st && groups[st]){ groups[st].push(p.endpoint); } });
      section(groups.native,'native','NATIVE','native Anthropic/OpenAI interface');
      section(groups['via-router'],'router','VIA LOCAL ROUTER','base_url → local router pack');
      section(groups.fixed,'fixed','FIXED','constrained to a fixed model set');
      if(!groups.native.length && !groups['via-router'].length && !groups.fixed.length){
        drawer.appendChild(el('div','dsub','No reachable providers with a wallet configured.'));
      }
    }
    function section(list,cls,label,why){
      if(!list.length){ return; }
      var g=el('div','grp '+cls); g.appendChild(el('span','dot')); g.appendChild(el('span',null,label)); drawer.appendChild(g);
      list.forEach(function(ep){ var r=el('div','row'); r.appendChild(el('b',null,ep)); r.appendChild(el('span','why',why)); drawer.appendChild(r); });
    }

    function renderProviderDrawer(p){
      drawer.innerHTML='';
      drawer.appendChild(el('h2','','PROVIDER / ENDPOINT'));
      drawer.appendChild(el('div','dh',p.endpoint));
      var s=el('div','dsub'); s.innerHTML='Native interface: <b>'+p.native+'</b>. '+(p.wallets.length>1?'This provider carries <b>several wallets side by side</b> — different billing identities and access kinds.':'One wallet configured for this endpoint.'); drawer.appendChild(s);
      drawer.appendChild(el('div','divider'));
      drawer.appendChild(el('h2','','WALLETS · '+p.wallets.length+' · ACCESS KINDS'));
      p.wallets.forEach(function(w){ drawer.appendChild(walletCard(w)); });
      var add=el('div','addslot','＋ add wallet (subscription or API key) — coming soon'); add.title='Read-only view — wallet creation lands in a follow-up.'; drawer.appendChild(add);
      drawer.appendChild(el('div','divider'));
      drawer.appendChild(el('h2','','REACHED BY'));
      var any=false;
      view.harnesses.forEach(function(h){ var st=h.reach[p.endpoint]; if(!st){ return; } any=true; var r=el('div','row'); r.appendChild(el('b',null,h.slug)); var why=el('span','why',reachLabel(st)); why.style.color=COL(st); r.appendChild(why); drawer.appendChild(r); });
      if(!any){ drawer.appendChild(el('div','dsub','No harness can reach this endpoint.')); }
    }
    function walletCard(w){
      var c=el('div','wcard');
      var top=el('div','wtop'); top.appendChild(el('span','wname',w.label)); top.appendChild(el('span','kchip '+kindClass(w.accessKind), kindLabel(w.accessKind))); c.appendChild(top);
      var m=el('div','wmeta');
      m.innerHTML='id <b>'+w.id+'</b><br/>method <b>'+w.method+'</b> · <span class="kdot '+keyDot(w.keyStatus)+'"></span><b>'+(w.keyStatus||'—')+'</b><br/>'+w.credential+'<br/>models: <b>'+w.models+'</b>'+(w.disabled?' · <b style="color:var(--clay)">disabled</b>':'');
      c.appendChild(m); return c;
    }

    function renderRouterDrawer(){
      drawer.innerHTML='';
      drawer.appendChild(el('h2','','LOCAL ROUTER'));
      var dh=el('div','dh','llm-endpoint'); dh.style.color='var(--ochre)'; drawer.appendChild(dh);
      var s=el('div','dsub'); s.innerHTML='An Anthropic-shaped front door for any upstream. A harness that speaks Anthropic points <code>ANTHROPIC_BASE_URL</code> here; a <b>pack</b> rewrites the request to the real provider.'; drawer.appendChild(s);
      drawer.appendChild(el('div','divider'));
      drawer.appendChild(el('h2','','STATUS (LIVE)'));
      drawer.appendChild(fact('RUNNING', view.router.running?'yes':'no'));
      drawer.appendChild(fact('STATE', view.router.status));
      if(view.router.baseUrl){ drawer.appendChild(fact('BASE URL', view.router.baseUrl)); }
      drawer.appendChild(el('div','divider'));
      drawer.appendChild(el('h2','','WHY IT MATTERS'));
      var w=el('div','dsub'); w.innerHTML='Harnesses that speak only Anthropic reach non-Anthropic models (Kimi, Grok, Gemini) ONLY through this relay. <code>derived-from-model</code> harnesses route natively and skip it.'; drawer.appendChild(w);
      drawer.appendChild(el('div','seam', view.seams[1] || ''));
    }
    function fact(k,v){ var f=el('div','fact'); f.appendChild(el('div','k',k)); f.appendChild(el('div','v',v)); return f; }

    // ---- wire-up ----
    document.getElementById('refresh').onclick = function(){ vscode.postMessage({ type:'refresh' }); };
    document.querySelector('.canvaswrap').onclick = function(){ resetFocus(); };
    window.addEventListener('resize', function(){
      var sel = document.querySelector('.node.sel');
      if(!sel){ clearWires(); return; }
      if(sel === routerEl){ focusRouter(); return; }
      var slug = Object.keys(nodeEls).find(function(k){ return nodeEls[k]===sel; });
      if(!slug){ return; }
      if(slug.indexOf('h:')===0){ focusHarness(slug.slice(2)); } else if(slug.indexOf('p:')===0){ focusProvider(slug.slice(2)); }
    });
    window.addEventListener('message', function(evt){
      var msg = evt.data;
      if(msg && msg.type === 'model'){ view = msg.view; render(); }
      else if(msg && msg.type === 'focus' && msg.target && view){
        if(msg.target.kind === 'harness'){ focusHarness(msg.target.key); }
        else if(msg.target.kind === 'provider'){
          // A focus target can name a folded (non-primary) provider — expand
          // before focusing so its node actually exists in nodeEls.
          var isPrimary = view.providers.some(function(p){ return p.endpoint === msg.target.key && p.primary; });
          var exists = view.providers.some(function(p){ return p.endpoint === msg.target.key; });
          if(!isPrimary && exists && !showAllProviders){ showAllProviders = true; render(); }
          focusProvider(msg.target.key);
        }
      }
    });

    defaultDrawer();
    vscode.postMessage({ type:'ready' });
  })();
  </script>
</body>
</html>`
}
