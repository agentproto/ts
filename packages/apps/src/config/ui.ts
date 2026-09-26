/**
 * `@agentproto/config` — a self-contained MCP App panel for daemon-wide
 * configuration (READ-ONLY v1). Its own app, not a section of `ops-panel` —
 * that app is referenced only for the mechanics this panel shares (
 * `window.McpApp.connect()` -> `app_tool_call { appId, tool, args }`, the
 * nested-envelope `unwrapText`, one card per entity). See its `ui.ts` for
 * the pattern this file follows.
 *
 * Six sections, each independently loaded/rendered so one failing card never
 * blanks the others: Wallets (auth profiles + spend), Harnesses (adapters +
 * capabilities + presets + roles), Models (the vendor/product/route
 * catalog), Defaults & messaging (daemon config knobs), Remote & pairing,
 * and Advanced (raw config dump). No write actions in this PR — every
 * control that would mutate state is simply absent.
 *
 * Two daemon tools this panel wants (`config_get`, `provider_key_list`) may
 * not exist yet on the daemon it talks to (parallel PRs) — `loadTool` below
 * turns an "unknown daemon tool" failure into a muted, section-local notice
 * instead of an error, and the Defaults section falls back to
 * `daemon_health`'s five effective knobs when `config_get` is absent.
 *
 * Deep-link contract (plan §3.4): `#<section>[/<id>[/<sub>]]`, parsed by
 * `parseConfigFragment` (`fragment.ts`) — embedded here via
 * `.toString()` so the exact function tested in `fragment.test.ts` is the
 * one that runs in the browser, not a second hand-copied version.
 */

import { parseConfigFragment, buildConfigFragment } from "./fragment.js"

export const CONFIG_TOOLS = [
  "auth_profile_list",
  "provider_key_list",
  "adapter_list",
  "harness_capabilities",
  "harness_preset_list",
  "catalog_models",
  "catalog_provider_models",
  "role_list",
  "usage_rollup",
  "config_get",
  "daemon_health",
  "remote_status",
  "pair_list",
  "tunnel_list",
  "tunnel_status",
] as const

const APP_ID = "@agentproto/config"

const SECTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "wallets", label: "Wallets" },
  { id: "harnesses", label: "Harnesses" },
  { id: "models", label: "Models" },
  { id: "defaults", label: "Defaults" },
  { id: "remote", label: "Remote" },
  { id: "advanced", label: "Advanced" },
]

export const CONFIG_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>agentproto config</title>
<style>
/* Theme tokens: prefer a live --vscode-* var (VS Code webview host), else
   the brand-neutral standalone default, split light/dark by
   prefers-color-scheme — same mapping convention as work-board/ui/style.css.
   No JS theme detection: a host that swaps its theme live is never frozen. */
:root{
  --cfg-bg: var(--vscode-editor-background, #f5f6f3);
  --cfg-surface: var(--vscode-sideBar-background, #ffffff);
  --cfg-surface-2: var(--vscode-editorWidget-background, #eef0ec);
  --cfg-ink: var(--vscode-editor-foreground, #171a1e);
  --cfg-ink-faint: var(--vscode-descriptionForeground, #6b7280);
  --cfg-border: var(--vscode-panel-border, #dde0da);
  --cfg-accent: var(--vscode-button-background, #0f62fe);
  --cfg-warning: var(--vscode-charts-yellow, #b45309);
  --cfg-danger: var(--vscode-charts-red, #b91c1c);
  --cfg-success: var(--vscode-charts-green, #15803d);
  --cfg-muted-bg: var(--vscode-input-background, #e5e7eb);
}
@media (prefers-color-scheme: dark){
  :root{
    --cfg-bg: var(--vscode-editor-background, #0f1115);
    --cfg-surface: var(--vscode-sideBar-background, #161a20);
    --cfg-surface-2: var(--vscode-editorWidget-background, #1c2129);
    --cfg-ink: var(--vscode-editor-foreground, #e6e9ee);
    --cfg-ink-faint: var(--vscode-descriptionForeground, #8b93a1);
    --cfg-border: var(--vscode-panel-border, #2a2f38);
    --cfg-accent: var(--vscode-button-background, #4589ff);
    --cfg-warning: var(--vscode-charts-yellow, #d29922);
    --cfg-danger: var(--vscode-charts-red, #f85149);
    --cfg-success: var(--vscode-charts-green, #3fb950);
    --cfg-muted-bg: var(--vscode-input-background, #262b33);
  }
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;background:var(--cfg-bg);color:var(--cfg-ink)}
#app{display:flex;flex-direction:column;height:100%;overflow:hidden}

#topbar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--cfg-surface);border-bottom:1px solid var(--cfg-border);flex-shrink:0}
#topbar h1{font-size:13px;font-weight:700;letter-spacing:.02em}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;background:var(--cfg-surface-2);border:1px solid var(--cfg-border);color:var(--cfg-ink-faint);padding:3px 9px;border-radius:999px}
.chip .d{width:7px;height:7px;border-radius:50%;background:var(--cfg-ink-faint);flex:none}
.chip.ok .d{background:var(--cfg-success)}
.chip.bad .d{background:var(--cfg-danger)}
#refresh-btn{margin-left:auto;background:none;border:1px solid var(--cfg-border);cursor:pointer;color:var(--cfg-ink-faint);font-size:13px;line-height:1;padding:4px 8px;border-radius:6px;font-family:inherit}
#refresh-btn:hover{color:var(--cfg-ink);background:var(--cfg-surface-2)}

#nav{display:flex;gap:4px;padding:8px 14px 0;background:var(--cfg-surface);border-bottom:1px solid var(--cfg-border);flex-shrink:0}
#nav button{background:none;border:none;border-bottom:2px solid transparent;color:var(--cfg-ink-faint);font-size:12px;font-weight:600;font-family:inherit;padding:7px 10px;cursor:pointer}
#nav button:hover{color:var(--cfg-ink)}
#nav button.active{color:var(--cfg-ink);border-bottom-color:var(--cfg-accent)}

#body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
.section{display:none;flex-direction:column;gap:12px}
.section.active{display:flex}

.notice{font-size:11.5px;color:var(--cfg-warning);background:var(--cfg-surface-2);border:1px solid var(--cfg-border);border-radius:6px;padding:6px 10px}
.muted{color:var(--cfg-ink-faint)}
.muted-note{color:var(--cfg-ink-faint);font-size:11px;padding:6px 10px}
.empty{color:var(--cfg-ink-faint);font-size:11.5px;padding:8px}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}
.card{background:var(--cfg-surface);border:1px solid var(--cfg-border);border-radius:8px;overflow:hidden;scroll-margin-top:12px}
.card.hl{outline:2px solid var(--cfg-accent);outline-offset:-1px}
.card .title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;font-size:12px;font-weight:700;background:var(--cfg-surface-2);border-bottom:1px solid var(--cfg-border)}
.card .title .aside{font-weight:400;color:var(--cfg-ink-faint);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:50%}
.card .body{padding:8px 10px}
.card dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;align-items:baseline}
.card dt{color:var(--cfg-ink-faint);white-space:nowrap;font-size:11.5px}
.card dd{text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11.5px}
.bar{grid-column:1/3;height:4px;background:var(--cfg-muted-bg);border-radius:2px;overflow:hidden;margin:2px 0 4px}
.bar>span{display:block;height:100%;background:var(--cfg-accent)}
.bar.warn>span{background:var(--cfg-warning)}

.sect-h{font-size:11px;font-weight:700;color:var(--cfg-ink-faint);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:8px}
.pillbar{display:flex;gap:4px}
.pillbar button{background:var(--cfg-surface-2);border:1px solid var(--cfg-border);color:var(--cfg-ink-faint);font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;cursor:pointer;font-family:inherit}
.pillbar button.active{color:var(--cfg-ink);border-color:var(--cfg-accent)}
label.inline{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--cfg-ink-faint)}
select,input[type=text]{background:var(--cfg-surface-2);color:var(--cfg-ink);border:1px solid var(--cfg-border);border-radius:5px;padding:3px 7px;font-size:11px;font-family:inherit}

.tag{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;background:var(--cfg-surface-2);border:1px solid var(--cfg-border);border-radius:5px;padding:1px 6px;color:var(--cfg-ink-faint)}
.tag.ok{color:var(--cfg-success);border-color:var(--cfg-success)}
.tag.bad{color:var(--cfg-danger);border-color:var(--cfg-danger)}
a.link{color:var(--cfg-accent);text-decoration:none;cursor:pointer}
a.link:hover{text-decoration:underline}

table{width:100%;border-collapse:collapse}
th{font-size:10px;font-weight:700;color:var(--cfg-ink-faint);text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:4px 8px;border-bottom:1px solid var(--cfg-border)}
td{font-size:11.5px;padding:5px 8px;border-bottom:1px solid var(--cfg-surface-2);vertical-align:middle}
tr.hl td{background:var(--cfg-surface-2)}

#toast{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:var(--cfg-surface-2);border:1px solid var(--cfg-border);border-radius:8px;padding:8px 14px;font-size:11.5px;display:none;max-width:80%;z-index:10}
#toast.err{border-color:var(--cfg-danger);color:var(--cfg-danger)}
</style>
</head>
<body>
<div id="app">
  <div id="topbar">
    <h1>agentproto config</h1>
    <span class="chip" id="daemon-chip"><span class="d"></span><span id="daemon-txt">daemon&hellip;</span></span>
    <button id="refresh-btn" title="Refresh" type="button">&#8635; refresh</button>
  </div>
  <div id="nav"></div>
  <div id="body">
    <div class="notice" id="notfound" style="display:none"></div>
    <div class="section" data-section="wallets" id="sec-wallets"></div>
    <div class="section" data-section="harnesses" id="sec-harnesses"></div>
    <div class="section" data-section="models" id="sec-models"></div>
    <div class="section" data-section="defaults" id="sec-defaults"></div>
    <div class="section" data-section="remote" id="sec-remote"></div>
    <div class="section" data-section="advanced" id="sec-advanced"></div>
  </div>
</div>
<div id="toast"></div>
<script>
var callTool = null;
var APP_ID = ${JSON.stringify(APP_ID)};
var SECTIONS = ${JSON.stringify(SECTIONS)};

// ── deep-link fragment parser (fragment.ts, embedded verbatim so the
// browser runs the exact function fragment.test.ts exercises) ──
${parseConfigFragment.toString()}
${buildConfigFragment.toString()}

// app_tool_call wraps its dispatch result at least once (its own text-result
// body is the JSON-stringified inner MCP tool result); peel back through
// nested {content:[{type:"text",text:...}]} shells until the payload stops
// looking like one — same convention as ops-panel/session-viewer.
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

// Never throws: every card loads independently, so one failing tool must
// never crash another card's render. An "unknown daemon tool" failure
// (config_get / provider_key_list on a daemon that predates them) is
// distinguished from any other failure so the caller can render a muted
// feature-detect note instead of an error.
function loadTool(tool, args) {
  return callApp(tool, args).then(function (d) {
    if (typeof d === "string") {
      return { ok: false, message: d, unknown: /unknown daemon tool/.test(d) };
    }
    if (d && typeof d === "object" && typeof d.error === "string") {
      return { ok: false, message: d.error, unknown: /unknown daemon tool/.test(d.error) };
    }
    return { ok: true, data: d };
  }).catch(function (e) {
    var msg = (e && e.message) || String(e);
    return { ok: false, message: msg, unknown: false };
  });
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function humanize(s) { return String(s || "").replace(/[-_]+/g, " "); }

function formatTokens(n) {
  if (n == null || !isFinite(n)) return "";
  var trim = function (t) { return t.replace(/\\.0$/, ""); };
  if (n >= 1000000) return trim((n / 1000000).toFixed(1)) + "M";
  if (n >= 1000) return trim((n / 1000).toFixed(1)) + "k";
  return String(n);
}

function formatCost(usd) {
  if (usd == null || !isFinite(usd)) return "";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return "$" + usd.toFixed(2);
}

function formatDate(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function formatMs(ms) {
  if (ms == null || !isFinite(ms)) return "";
  if (ms >= 60000) return Math.round(ms / 60000) + "m";
  if (ms >= 1000) return Math.round(ms / 1000) + "s";
  return ms + "ms";
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

var BILLING_LABELS = { "oauth-bearer": "Subscription", "api-key": "API key" };

// ── card builders (session-header-cards.tsx visual language: card surface,
// title strip w/ muted aside, two-col dl grid, 4px progress bar) ──
function cardOpen(id, title, aside) {
  return '<div class="card" data-card-id="' + escHtml(id) + '">'
    + '<div class="title"><span>' + escHtml(title) + '</span>'
    + (aside ? '<span class="aside">' + aside + '</span>' : '')
    + '</div><div class="body"><dl>';
}
function cardClose() { return '</dl></div></div>'; }
function row(label, value, title) {
  return '<dt>' + escHtml(label) + '</dt><dd' + (title ? ' title="' + escHtml(title) + '"' : '') + '>' + value + '</dd>';
}
function bar(pct) {
  var p = Math.max(0, Math.min(100, pct));
  return '<div class="bar' + (p >= 80 ? ' warn' : '') + '"><span style="width:' + p + '%"></span></div>';
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

// ============================================================
// nav + deep-link routing
// ============================================================

var current = { section: SECTIONS[0].id, id: undefined, sub: undefined };
var loaded = {}; // section -> true once its data has been fetched at least once

function renderNav() {
  var el = document.getElementById("nav");
  var html = "";
  for (var i = 0; i < SECTIONS.length; i++) {
    html += '<button data-section="' + SECTIONS[i].id + '" class="' + (SECTIONS[i].id === current.section ? "active" : "") + '">' + escHtml(SECTIONS[i].label) + '</button>';
  }
  el.innerHTML = html;
  var btns = el.querySelectorAll("button[data-section]");
  for (var k = 0; k < btns.length; k++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        location.hash = buildConfigFragment(btn.getAttribute("data-section"));
      });
    })(btns[k]);
  }
}

function showSection(sectionId) {
  var els = document.querySelectorAll(".section");
  for (var i = 0; i < els.length; i++) {
    els[i].classList.toggle("active", els[i].getAttribute("data-section") === sectionId);
  }
  var btns = document.querySelectorAll("#nav button[data-section]");
  for (var j = 0; j < btns.length; j++) {
    btns[j].classList.toggle("active", btns[j].getAttribute("data-section") === sectionId);
  }
}

// Scroll to + highlight the card matching 'id' within the active section's
// container. Unknown id means the "not found" banner (never a blank page).
function applyDeepLink(sectionId, id, sub) {
  var notfound = document.getElementById("notfound");
  notfound.style.display = "none";
  var prevHl = document.querySelectorAll(".card.hl, tr.hl");
  for (var p = 0; p < prevHl.length; p++) prevHl[p].classList.remove("hl");
  if (id === undefined) return;
  var container = document.getElementById("sec-" + sectionId);
  if (!container) return;
  var targetId = sectionId === "remote" && id === "pairing" ? "pairing" : id;
  var target = container.querySelector('[data-card-id="' + cssEscape(targetId) + '"]');
  if (!target) {
    notfound.textContent = "not found: " + id + (sub ? "/" + sub : "");
    notfound.style.display = "block";
    return;
  }
  target.classList.add("hl");
  scrollIntoViewSafe(target);
  if (sub) {
    var row = target.querySelector('[data-row-id="' + cssEscape(sub) + '"]');
    if (row) {
      row.classList.add("hl");
      scrollIntoViewSafe(row);
    }
  }
}

// Not every embedding host implements scrollIntoView on a sandboxed/minimal
// DOM — highlighting must still work even when scrolling can't.
function scrollIntoViewSafe(el) {
  if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
}

// CSS.escape isn't guaranteed in every sandboxed webview — a minimal,
// dependency-free fallback for the characters our own ids ever contain.
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
    return "\\\\" + c.charCodeAt(0).toString(16) + " ";
  });
}

function route(pushBack) {
  var parsed = parseConfigFragment(location.hash);
  current = parsed;
  showSection(parsed.section);
  renderNav();
  ensureLoaded(parsed.section).then(function () {
    applyDeepLink(parsed.section, parsed.id, parsed.sub);
  });
  if (pushBack) location.hash = buildConfigFragment(parsed.section, parsed.id, parsed.sub);
}

window.addEventListener("hashchange", function () { route(false); });

// ============================================================
// section data + render dispatch
// ============================================================

var SECTION_LOADERS = {
  wallets: loadWallets,
  harnesses: loadHarnesses,
  models: loadModels,
  defaults: loadDefaults,
  remote: loadRemote,
  advanced: loadAdvanced,
};

function ensureLoaded(sectionId) {
  if (loaded[sectionId]) return Promise.resolve();
  var fn = SECTION_LOADERS[sectionId];
  if (!fn) return Promise.resolve();
  return fn().then(function () { loaded[sectionId] = true; });
}

function reloadCurrent() {
  loaded[current.section] = false;
  return ensureLoaded(current.section).then(function () {
    applyDeepLink(current.section, current.id, current.sub);
  });
}

// ============================================================
// Wallets
// ============================================================

var walletsState = { window: "7d", profiles: [], rollup: null };

function loadWallets() {
  return Promise.all([
    loadTool("auth_profile_list", { full: true }),
    loadTool("usage_rollup", { window: walletsState.window, groupBy: ["profile"] }),
    loadTool("provider_key_list", {}),
  ]).then(function (results) {
    walletsState.profilesResult = results[0];
    walletsState.rollupResult = results[1];
    walletsState.providerKeysResult = results[2];
    renderWallets();
  });
}

function reloadWalletsWindow(win) {
  walletsState.window = win;
  loadTool("usage_rollup", { window: win, groupBy: ["profile"] }).then(function (r) {
    walletsState.rollupResult = r;
    renderWallets();
  });
}

function byProfileMap(rollupResult) {
  var map = {};
  if (rollupResult.ok && rollupResult.data && Array.isArray(rollupResult.data.byProfile)) {
    for (var i = 0; i < rollupResult.data.byProfile.length; i++) {
      map[rollupResult.data.byProfile[i].profileRef] = rollupResult.data.byProfile[i];
    }
  }
  return map;
}

function renderWallets() {
  var el = document.getElementById("sec-wallets");
  var pr = walletsState.profilesResult;
  var rr = walletsState.rollupResult;
  var html = '<div class="sect-h">Spend<span class="pillbar" id="wallet-window"></span></div>';

  if (rr && rr.ok) {
    var t = rr.data.total || {};
    html += '<div class="card"><div class="body"><dl>'
      + row("Window", escHtml(rr.data.window))
      + (typeof t.spentUsd === "number" ? row("Spend", formatCost(t.spentUsd)) : "")
      + (typeof t.tokensIn === "number" || typeof t.tokensOut === "number"
          ? row("Tokens", (typeof t.tokensIn === "number" ? formatTokens(t.tokensIn) + " in" : "") + (typeof t.tokensIn === "number" && typeof t.tokensOut === "number" ? " &middot; " : "") + (typeof t.tokensOut === "number" ? formatTokens(t.tokensOut) + " out" : ""))
          : "")
      + (typeof t.unpricedTokens === "number" && t.unpricedTokens > 0 ? row("Unpriced tokens", formatTokens(t.unpricedTokens)) : "")
      + '</dl></div></div>';
  } else if (rr) {
    html += '<div class="muted-note">usage_rollup: ' + escHtml(rr.message) + '</div>';
  }

  html += '<div class="sect-h">Wallets</div><div class="grid" id="wallet-cards"></div>';

  if (walletsState.providerKeysResult) {
    var pk = walletsState.providerKeysResult;
    html += '<div class="sect-h">Legacy provider keys</div>';
    if (pk.ok) {
      var rows = (pk.data && pk.data.providers) || [];
      if (rows.length === 0) {
        html += '<div class="empty">No legacy provider keys on this host.</div>';
      } else {
        html += '<div class="card"><div class="body"><table><thead><tr><th>Provider</th><th>Env var</th><th>Set</th><th>Key</th><th>Base URL</th></tr></thead><tbody>';
        for (var i = 0; i < rows.length; i++) {
          var p = rows[i];
          html += '<tr><td>' + escHtml(p.provider) + '</td><td>' + escHtml(p.envVar) + '</td>'
            + '<td>' + (p.set ? '<span class="tag ok">set</span>' : '<span class="tag">not set</span>') + '</td>'
            + '<td>' + escHtml([p.fingerprint, p.last4].filter(Boolean).join(" &middot; ")) + '</td>'
            + '<td>' + escHtml(p.baseUrl || "") + '</td></tr>';
        }
        html += '</tbody></table></div></div><div class="muted-note">Legacy per-provider keys are read-only here &mdash; migrate to a wallet (auth profile) to manage curation and budget.</div>';
      }
    } else if (pk.unknown) {
      html += '<div class="muted-note">Legacy provider keys need a newer agentproto daemon.</div>';
    } else {
      html += '<div class="muted-note">provider_key_list: ' + escHtml(pk.message) + '</div>';
    }
  }

  el.innerHTML = html;

  var pillEl = document.getElementById("wallet-window");
  var windows = ["5h", "7d", "30d"];
  var pillHtml = "";
  for (var w = 0; w < windows.length; w++) {
    pillHtml += '<button data-win="' + windows[w] + '" class="' + (windows[w] === walletsState.window ? "active" : "") + '">' + windows[w] + '</button>';
  }
  pillEl.innerHTML = pillHtml;
  var pillBtns = pillEl.querySelectorAll("button");
  for (var pb = 0; pb < pillBtns.length; pb++) {
    (function (btn) {
      btn.addEventListener("click", function () { reloadWalletsWindow(btn.getAttribute("data-win")); });
    })(pillBtns[pb]);
  }

  var cardsEl = document.getElementById("wallet-cards");
  if (!pr || !pr.ok) {
    cardsEl.innerHTML = '<div class="empty">' + (pr ? escHtml(pr.message) : "loading&hellip;") + '</div>';
    return;
  }
  var profiles = (pr.data && pr.data.profiles) || [];
  if (profiles.length === 0) {
    cardsEl.innerHTML = '<div class="empty">No auth profiles configured on this host.</div>';
    return;
  }
  var spend = rr && rr.ok ? byProfileMap(rr) : {};
  var out = "";
  for (var i2 = 0; i2 < profiles.length; i2++) {
    out += walletCardHtml(profiles[i2], spend[profiles[i2].id]);
  }
  cardsEl.innerHTML = out;
}

function walletCardHtml(p, spend) {
  var title = p.label || p.id;
  var out = cardOpen(p.id, title, escHtml(p.endpoint));
  out += row("Method", escHtml(BILLING_LABELS[p.method] || humanize(p.method)));
  var keyLine = p.keyStatus === "stored"
    ? [p.fingerprint, p.last4].filter(Boolean).join(" &middot; ") || "stored"
    : p.keyStatus === "self-refreshing" ? "self-refreshing" : "unavailable";
  out += row("Key", escHtml(keyLine));
  if (p.origin) out += row("Imported from", escHtml(p.origin));
  out += row("Enabled", p.disabled ? "No" : "Yes");
  var curated = !p.models || p.models.mode === "all" ? "All eligible" : (p.models.ids || []).length + " curated";
  out += row("Models", escHtml(curated));
  if (spend) {
    if (typeof spend.spentUsd === "number") out += row("Spend (window)", formatCost(spend.spentUsd));
    if (p.costBudget && typeof p.costBudget.maxCostUsd === "number") {
      var pct = p.costBudget.maxCostUsd > 0 ? ((spend.spentUsd || 0) / p.costBudget.maxCostUsd) * 100 : 0;
      out += row("Budget", formatCost(p.costBudget.maxCostUsd) + " / " + escHtml(p.costBudget.window));
      out += bar(pct);
    }
    if (spend.remaining) {
      out += row("Remaining quota", String(spend.remaining.remaining), "resets " + formatDate(spend.remaining.resetsAt));
    }
    if (spend.credits && typeof spend.credits.balanceUsd === "number") {
      out += row("Credit balance", formatCost(spend.credits.balanceUsd), spend.credits.asOf ? "as of " + formatDate(spend.credits.asOf) : undefined);
    }
  } else if (p.costBudget && typeof p.costBudget.maxCostUsd === "number") {
    out += row("Budget", formatCost(p.costBudget.maxCostUsd) + " / " + escHtml(p.costBudget.window));
  }
  out += cardClose();
  return out;
}

// ============================================================
// Harnesses
// ============================================================

function loadHarnesses() {
  return Promise.all([
    loadTool("adapter_list", {}),
    loadTool("harness_capabilities", {}),
    loadTool("harness_preset_list", {}),
    loadTool("role_list", {}),
  ]).then(function (results) {
    renderHarnesses(results[0], results[1], results[2], results[3]);
  });
}

function renderHarnesses(adaptersR, capsR, presetsR, rolesR) {
  var el = document.getElementById("sec-harnesses");
  if (!adaptersR.ok) {
    el.innerHTML = '<div class="empty">adapter_list: ' + escHtml(adaptersR.message) + '</div>';
    return;
  }
  var adapters = (adaptersR.data && adaptersR.data.adapters) || [];
  var capsBySlug = {};
  if (capsR.ok) {
    var caps = (capsR.data && capsR.data.capabilities) || [];
    for (var i = 0; i < caps.length; i++) capsBySlug[caps[i].adapter] = caps[i];
  }
  var presetsBySlug = {};
  if (presetsR.ok) {
    var presets = (presetsR.data && presetsR.data.presets) || [];
    for (var j = 0; j < presets.length; j++) {
      var slug = presets[j].harnessSlug;
      if (!presetsBySlug[slug]) presetsBySlug[slug] = [];
      presetsBySlug[slug].push(presets[j]);
    }
  }

  var html = '<div class="sect-h">Adapters</div>';
  if (!capsR.ok && capsR.unknown) html += '<div class="muted-note">Capability detail needs a newer agentproto daemon.</div>';
  else if (!capsR.ok) html += '<div class="muted-note">harness_capabilities: ' + escHtml(capsR.message) + '</div>';
  if (!presetsR.ok) html += '<div class="muted-note">harness_preset_list: ' + escHtml(presetsR.message) + '</div>';

  html += '<div class="grid">';
  if (adapters.length === 0) {
    html += '<div class="empty">No adapters installed on this host.</div>';
  }
  for (var k = 0; k < adapters.length; k++) {
    var a = adapters[k];
    var cap = capsBySlug[a.slug];
    var slugPresets = presetsBySlug[a.slug] || [];
    var def = null;
    for (var d = 0; d < slugPresets.length; d++) if (slugPresets[d].isDefault) def = slugPresets[d];
    html += cardOpen(a.slug, a.name || a.slug, escHtml(a.slug));
    if (a.version) html += row("Version", escHtml(a.version));
    if (a.protocol) html += row("Protocol", escHtml(a.protocol));
    html += row("Models", String((a.models || []).length));
    if (cap && Array.isArray(cap.providers) && cap.providers.length > 0) {
      var chips = "";
      for (var pi = 0; pi < cap.providers.length; pi++) {
        var prov = cap.providers[pi];
        chips += '<span class="tag ' + (prov.cred && prov.cred.present ? "ok" : "") + '">' + escHtml(prov.billingEndpoint) + '</span> ';
      }
      html += '<dt>Billing</dt><dd>' + chips + '</dd>';
    }
    if (def) {
      html += row("Default preset", escHtml(def.name) + ' &rarr; <a class="link" data-goto="wallets/' + encodeURIComponent(def.profileRef) + '">' + escHtml(def.profileRef) + '</a> / ' + escHtml(def.defaultModel));
    } else if (slugPresets.length > 0) {
      html += row("Presets", String(slugPresets.length) + " (no default)");
    }
    html += cardClose();
  }
  html += '</div>';

  html += '<div class="sect-h">Roles</div>';
  if (rolesR.ok) {
    var roles = (rolesR.data && rolesR.data.roles) || [];
    if (roles.length === 0) {
      html += '<div class="empty">No roles registered.</div>';
    } else {
      html += '<div class="card"><div class="body"><table><thead><tr><th>Role</th><th>Level</th><th>Delegation</th><th>Can spawn</th></tr></thead><tbody>';
      for (var r = 0; r < roles.length; r++) {
        var role = roles[r];
        html += '<tr><td>' + escHtml(role.name) + '</td><td>' + escHtml(String(role.level)) + '</td><td>' + escHtml(role.delegation) + '</td><td>' + escHtml((role.spawnable || []).join(", ")) + '</td></tr>';
      }
      html += '</tbody></table></div></div>';
    }
  } else {
    html += '<div class="muted-note">role_list: ' + escHtml(rolesR.message) + '</div>';
  }

  el.innerHTML = html;
  wireGotoLinks(el);
}

function wireGotoLinks(container) {
  var links = container.querySelectorAll("a[data-goto]");
  for (var i = 0; i < links.length; i++) {
    (function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        location.hash = "#" + a.getAttribute("data-goto");
      });
    })(links[i]);
  }
}

// ============================================================
// Models
// ============================================================

var modelsState = { routes: [], runnableOnly: false, walletFilter: "" };

function loadModels() {
  return Promise.all([
    loadTool("catalog_models", { full: true }),
    loadTool("auth_profile_list", {}),
  ]).then(function (results) {
    modelsState.routesResult = results[0];
    modelsState.profilesResult = results[1];
    renderModels();
  });
}

function renderModels() {
  var el = document.getElementById("sec-models");
  var rr = modelsState.routesResult;
  if (!rr.ok) {
    el.innerHTML = '<div class="empty">catalog_models: ' + escHtml(rr.message) + '</div>';
    return;
  }
  var routes = (rr.data && rr.data.routes) || [];
  var profiles = (modelsState.profilesResult && modelsState.profilesResult.ok && modelsState.profilesResult.data && modelsState.profilesResult.data.profiles) || [];

  var html = '<div class="sect-h">Catalog<label class="inline"><input type="checkbox" id="runnable-only"' + (modelsState.runnableOnly ? " checked" : "") + '> runnable only</label>'
    + '<label class="inline">wallet <select id="wallet-filter"><option value="">any</option>';
  for (var i = 0; i < profiles.length; i++) {
    html += '<option value="' + escHtml(profiles[i].id) + '"' + (profiles[i].id === modelsState.walletFilter ? " selected" : "") + '>' + escHtml(profiles[i].label || profiles[i].id) + '</option>';
  }
  html += '</select></label></div>';

  var filtered = routes.filter(function (r) {
    if (modelsState.runnableOnly && !r.runnable) return false;
    if (modelsState.walletFilter && (!r.eligibleProfiles || r.eligibleProfiles.indexOf(modelsState.walletFilter) === -1)) return false;
    return true;
  });

  var byVendor = {};
  var vendorOrder = [];
  for (var f = 0; f < filtered.length; f++) {
    var v = filtered[f].vendor;
    if (!byVendor[v]) { byVendor[v] = []; vendorOrder.push(v); }
    byVendor[v].push(filtered[f]);
  }
  vendorOrder.sort();

  if (vendorOrder.length === 0) {
    html += '<div class="empty">No models match the current filters.</div>';
  }
  for (var vi = 0; vi < vendorOrder.length; vi++) {
    var vendor = vendorOrder[vi];
    var vendorRows = byVendor[vendor];
    var byProduct = {};
    var productOrder = [];
    for (var pr2 = 0; pr2 < vendorRows.length; pr2++) {
      var prod = vendorRows[pr2].product;
      if (!byProduct[prod]) { byProduct[prod] = []; productOrder.push(prod); }
      byProduct[prod].push(vendorRows[pr2]);
    }
    productOrder.sort();
    html += '<div class="sect-h">' + escHtml(vendor) + '</div><div class="grid">';
    for (var pi2 = 0; pi2 < productOrder.length; pi2++) {
      var product = productOrder[pi2];
      var productRoutes = byProduct[product];
      var modelRef = vendor + "/" + product;
      html += cardOpen(modelRef, product, "");
      for (var ri = 0; ri < productRoutes.length; ri++) {
        var route = productRoutes[ri];
        var priceStr = route.pricing ? "$" + route.pricing.inPer1M + "/$" + route.pricing.outPer1M + " per 1M" : "";
        var elig = (route.eligibleProfiles || []).map(function (id) {
          return '<a class="link" data-goto="wallets/' + encodeURIComponent(id) + '">' + escHtml(id) + '</a>';
        }).join(" ");
        html += row(route.route, (route.runnable ? '<span class="tag ok">runnable</span>' : '<span class="tag">not runnable</span>') + (route.curated ? ' <span class="tag">curated</span>' : ""));
        if (priceStr) html += row("Price", escHtml(priceStr));
        if (route.contextWindow) html += row("Context", escHtml(route.contextWindow) + (route.maxOutput ? " / " + escHtml(route.maxOutput) + " out" : ""));
        if (elig) html += '<dt>Wallets</dt><dd>' + elig + '</dd>';
      }
      html += cardClose();
    }
    html += '</div>';
  }

  el.innerHTML = html;
  wireGotoLinks(el);

  var runnableEl = document.getElementById("runnable-only");
  if (runnableEl) runnableEl.addEventListener("change", function (e) { modelsState.runnableOnly = e.target.checked; renderModels(); });
  var walletEl = document.getElementById("wallet-filter");
  if (walletEl) walletEl.addEventListener("change", function (e) { modelsState.walletFilter = e.target.value; renderModels(); });
}

// ============================================================
// Defaults & messaging
// ============================================================

function loadDefaults() {
  return Promise.all([
    loadTool("config_get", {}),
    loadTool("daemon_health", {}),
  ]).then(function (results) {
    renderDefaults(results[0], results[1]);
  });
}

function renderDefaults(configR, healthR) {
  var el = document.getElementById("sec-defaults");
  var html = "";

  if (configR.ok) {
    // Forward-compatible generic render: config_get's exact wire shape lands
    // in a later PR, so this tolerates {keys:[...]}, a bare array, or
    // {entries:[...]} and groups rows by the first path segment.
    var keys = Array.isArray(configR.data) ? configR.data
      : (configR.data && (configR.data.keys || configR.data.entries)) || [];
    var byGroup = {};
    var groupOrder = [];
    for (var i = 0; i < keys.length; i++) {
      var entry = keys[i];
      var group = String(entry.path || "").split(".")[0] || "other";
      if (!byGroup[group]) { byGroup[group] = []; groupOrder.push(group); }
      byGroup[group].push(entry);
    }
    for (var g = 0; g < groupOrder.length; g++) {
      var group = groupOrder[g];
      html += '<div class="sect-h">' + escHtml(group) + '</div><div class="card" data-card-id="' + escHtml(group) + '"><div class="body"><dl>';
      var rows = byGroup[group];
      for (var r = 0; r < rows.length; r++) {
        var e = rows[r];
        var badge = '<span class="tag">' + escHtml(e.apply || "") + '</span>';
        var value = e.secret ? (e.secret.set ? "set" : "not set") : escHtml(JSON.stringify(e.effective !== undefined ? e.effective : e.value));
        var extra = "";
        if (e.source === "env" && e.envOverride) extra += ' <span class="tag bad">overridden by ' + escHtml(e.envOverride) + '</span>';
        if (e.pendingRestart) extra += ' <span class="tag">pending restart</span>';
        html += '<dt title="' + escHtml(e.path) + '">' + escHtml(e.path) + '</dt><dd>' + value + ' ' + badge + extra + '</dd>';
      }
      html += '</dl></div></div>';
    }
    if (groupOrder.length === 0) html += '<div class="empty">config_get returned no keys.</div>';
  } else if (configR.unknown) {
    html += '<div class="notice">Full defaults editor needs a newer agentproto daemon (config_get). Showing the knobs daemon_health reports.</div>';
    if (healthR.ok) {
      var hd = healthR.data;
      var restartBadge = ' <span class="tag">restart</span>';
      html += '<div class="card" data-card-id="daemon"><div class="title"><span>Daemon</span>'
        + (hd.version ? '<span class="aside">' + escHtml(hd.version) + '</span>' : '') + '</div><div class="body"><dl>'
        + row("Resume sessions on boot", (hd.resumeSessionsOnBoot ? "Yes" : "No") + restartBadge)
        + row("Idle reap after", (hd.idleReapAfterMs ? formatMs(hd.idleReapAfterMs) : "off") + restartBadge)
        + row("Crash detect interval", (hd.crashDetectIntervalMs ? formatMs(hd.crashDetectIntervalMs) : "off") + restartBadge)
        + row("Restart sweep interval", (hd.restartSweepIntervalMs ? formatMs(hd.restartSweepIntervalMs) : "off") + restartBadge)
        + row("Turn stall after", (hd.turnStallAfterMs ? formatMs(hd.turnStallAfterMs) : "off") + restartBadge)
        + (hd.build && hd.build.sha ? row("Build", escHtml(hd.build.sha)) : "")
        + '</dl></div></div>';
    } else {
      html += '<div class="muted-note">daemon_health: ' + escHtml(healthR.message) + '</div>';
    }
  } else {
    html += '<div class="muted-note">config_get: ' + escHtml(configR.message) + '</div>';
  }

  el.innerHTML = html;
}

// ============================================================
// Remote & pairing
// ============================================================

function loadRemote() {
  return Promise.all([
    loadTool("remote_status", {}),
    loadTool("pair_list", {}),
    loadTool("tunnel_list", {}),
  ]).then(function (results) {
    renderRemote(results[0], results[1], results[2]);
  });
}

function renderRemote(remoteR, pairR, tunnelR) {
  var el = document.getElementById("sec-remote");
  var html = '<div class="sect-h">Remote gateway</div>';
  if (remoteR.ok) {
    var rs = remoteR.data;
    html += '<div class="card" data-card-id="remote"><div class="body"><dl>'
      + row("Enabled", rs.enabled ? "Yes" : "No")
      + (rs.provider ? row("Provider", escHtml(rs.provider)) : "")
      + (rs.publicUrl ? row("Public URL", escHtml(rs.publicUrl)) : "")
      + (rs.pid != null ? row("PID", String(rs.pid)) : "")
      + (rs.createdAt ? row("Created", fmtRelative(rs.createdAt)) : "")
      + (rs.lastError ? row("Last error", escHtml(rs.lastError)) : "")
      + '</dl></div></div>';
  } else {
    html += '<div class="muted-note">remote_status: ' + escHtml(remoteR.message) + '</div>';
  }

  html += '<div class="sect-h">Pairing</div>';
  if (pairR.ok) {
    var pairings = (pairR.data && pairR.data.pairings) || [];
    html += '<div class="card" data-card-id="pairing"><div class="body">';
    if (pairings.length === 0) {
      html += '<div class="empty">No paired clients.</div>';
    } else {
      html += '<table><thead><tr><th>Name</th><th>Fingerprint</th><th>Created</th><th>Last seen</th><th>Rendezvous</th></tr></thead><tbody>';
      for (var i = 0; i < pairings.length; i++) {
        var p = pairings[i];
        html += '<tr data-row-id="' + escHtml(p.fingerprint) + '"><td>' + escHtml(p.name) + '</td><td>' + escHtml(p.fingerprint) + '</td>'
          + '<td>' + escHtml(fmtRelative(p.createdAt)) + '</td><td>' + escHtml(fmtRelative(p.lastSeen)) + '</td><td>' + escHtml(p.rendezvous || "") + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div></div>';
  } else {
    html += '<div class="muted-note">pair_list: ' + escHtml(pairR.message) + '</div>';
  }

  html += '<div class="sect-h">Tunnels</div>';
  if (tunnelR.ok) {
    var tunnels = (tunnelR.data && tunnelR.data.tunnels) || [];
    if (tunnels.length === 0) {
      html += '<div class="empty">No tunnels tracked by this daemon.</div>';
    } else {
      html += '<div class="card"><div class="body"><table><thead><tr><th>Name</th><th>Provider</th><th>Port</th><th>URL</th><th>Status</th></tr></thead><tbody>';
      for (var t = 0; t < tunnels.length; t++) {
        var tn = tunnels[t];
        html += '<tr><td>' + escHtml(tn.label || tn.name) + '</td><td>' + escHtml(tn.provider) + '</td><td>' + escHtml(String(tn.targetPort)) + '</td>'
          + '<td>' + escHtml(tn.publicUrl || "") + '</td><td>' + escHtml(tn.status) + '</td></tr>';
      }
      html += '</tbody></table></div></div>';
    }
  } else {
    html += '<div class="muted-note">tunnel_list: ' + escHtml(tunnelR.message) + '</div>';
  }

  el.innerHTML = html;
}

// ============================================================
// Advanced
// ============================================================

function loadAdvanced() {
  return Promise.all([
    loadTool("config_get", {}),
    loadTool("daemon_health", {}),
  ]).then(function (results) {
    renderAdvanced(results[0], results[1]);
  });
}

function renderAdvanced(configR, healthR) {
  var el = document.getElementById("sec-advanced");
  var html = '<div class="sect-h">Raw config dump</div>';
  if (configR.ok) {
    html += '<div class="card"><div class="body"><pre style="white-space:pre-wrap;font-size:11px;font-family:Menlo,Monaco,monospace">' + escHtml(JSON.stringify(configR.data, null, 2)) + '</pre></div></div>';
  } else if (configR.unknown) {
    html += '<div class="notice">Full config dump needs a newer agentproto daemon (config_get). See Defaults for the knobs daemon_health reports.</div>';
  } else {
    html += '<div class="muted-note">config_get: ' + escHtml(configR.message) + '</div>';
  }
  html += '<div class="sect-h">Daemon health</div>';
  if (healthR.ok) {
    html += '<div class="card"><div class="body"><pre style="white-space:pre-wrap;font-size:11px;font-family:Menlo,Monaco,monospace">' + escHtml(JSON.stringify(healthR.data, null, 2)) + '</pre></div></div>';
  } else {
    html += '<div class="muted-note">daemon_health: ' + escHtml(healthR.message) + '</div>';
  }
  el.innerHTML = html;
}

// ============================================================
// boot
// ============================================================

function loadHealthChip() {
  return loadTool("daemon_health", {}).then(function (r) {
    var chip = document.getElementById("daemon-chip");
    if (r.ok) {
      chip.className = "chip ok";
      var v = r.data.version || (r.data.build && r.data.build.sha) || r.data.status || "ok";
      document.getElementById("daemon-txt").textContent = "daemon " + String(v).slice(0, 16);
    } else {
      chip.className = "chip bad";
      document.getElementById("daemon-txt").textContent = "daemon unreachable";
    }
  });
}

document.getElementById("refresh-btn").addEventListener("click", function () {
  loadHealthChip();
  reloadCurrent().catch(function (e) { toast(String(e && e.message || e), true); });
});

window.McpApp.connect()
  .then(function (bridge) {
    callTool = bridge.callTool;
    renderNav();
    loadHealthChip();
    route(true);
  })
  .catch(function (err) {
    document.getElementById("body").innerHTML =
      '<div class="empty">Standalone mode &mdash; no host bridge (' + escHtml(err.message) + ')</div>';
  });
</script>
</body>
</html>`
