/**
 * `@agentproto/config` — a self-contained MCP App panel for daemon-wide
 * configuration. Its own app, not a section of `ops-panel` — that app is
 * referenced only for the mechanics this panel shares (
 * `window.McpApp.connect()` -> `app_tool_call { appId, tool, args }`, the
 * nested-envelope `unwrapText`, one card per entity, two-click confirm). See
 * its `ui.ts` for the pattern this file follows.
 *
 * Six sections, each independently loaded/rendered so one failing card never
 * blanks the others: Wallets (auth profiles + spend), Harnesses (adapters +
 * capabilities + presets + roles), Models (the vendor/product/route
 * catalog), Defaults & messaging (daemon config knobs), Remote & pairing,
 * and Advanced (raw config dump). This PR adds the write flows: wallet
 * lifecycle + curation, harness preset CRUD, a generic config_get/config_set
 * editor for Defaults/per-harness defaults/titler.model, and remote/pairing
 * lifecycle.
 *
 * Three daemon tools this panel wants (`config_get`, `config_set`, and
 * every write tool below) may not exist yet on the daemon it talks to
 * (parallel PRs) — `loadTool` turns an "unknown daemon tool" failure into a
 * muted, section-local notice instead of an error, and the Defaults section
 * falls back to `daemon_health`'s five effective knobs when `config_get` is
 * absent.
 *
 * Secret discipline: a credential (auth_profile_create's `credential`, a
 * remote bearer, a pairing offer URL) is read from a form field, used ONCE
 * in the same handler, and the DOM field is cleared before the async call
 * even starts. Nothing secret is ever stored in section state, written to
 * `updateModelContext`, or logged.
 *
 * Deep-link contract (plan section 3.4): `#<section>[/<id>[/<sub>]]`, parsed
 * by `parseConfigFragment` (`fragment.ts`) — embedded here via
 * `.toString()` so the exact function tested in `fragment.test.ts` is the
 * one that runs in the browser, not a second hand-copied version.
 */

import { parseConfigFragment, buildConfigFragment } from "./fragment.js"

export const CONFIG_TOOLS = [
  "auth_profile_list",
  "auth_profile_create",
  "auth_profile_delete",
  "auth_profile_set_enabled",
  "auth_profile_set_models",
  "auth_profile_refresh_models",
  "auth_profile_import",
  "auth_discover_credentials",
  "auth_profile_update",
  "adapter_list",
  "harness_capabilities",
  "harness_preset_list",
  "harness_preset_create",
  "harness_preset_delete",
  "harness_preset_set_default",
  "catalog_models",
  "catalog_provider_models",
  "role_list",
  "usage_rollup",
  "config_get",
  "config_set",
  "daemon_health",
  "remote_status",
  "remote_enable",
  "remote_disable",
  "pair_list",
  "pair_offer",
  "pair_revoke",
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

#pending-banner{margin:8px 14px 0;padding:6px 10px;background:var(--cfg-surface-2);border:1px solid var(--cfg-warning);color:var(--cfg-warning);border-radius:6px;font-size:11px;flex-shrink:0}

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

.sect-h{font-size:11px;font-weight:700;color:var(--cfg-ink-faint);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pillbar{display:flex;gap:4px}
.pillbar button{background:var(--cfg-surface-2);border:1px solid var(--cfg-border);color:var(--cfg-ink-faint);font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;cursor:pointer;font-family:inherit}
.pillbar button.active{color:var(--cfg-ink);border-color:var(--cfg-accent)}
label.inline{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--cfg-ink-faint)}
select,input[type=text],input[type=password],input[type=number],textarea{background:var(--cfg-surface-2);color:var(--cfg-ink);border:1px solid var(--cfg-border);border-radius:5px;padding:3px 7px;font-size:11px;font-family:inherit}
input:disabled,select:disabled,textarea:disabled{opacity:.5;cursor:not-allowed}

.tag{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;background:var(--cfg-surface-2);border:1px solid var(--cfg-border);border-radius:5px;padding:1px 6px;color:var(--cfg-ink-faint)}
.tag.ok{color:var(--cfg-success);border-color:var(--cfg-success)}
.tag.bad{color:var(--cfg-danger);border-color:var(--cfg-danger)}
.tag.warn-tag{color:var(--cfg-warning);border-color:var(--cfg-warning)}
a.link{color:var(--cfg-accent);text-decoration:none;cursor:pointer}
a.link:hover{text-decoration:underline}

table{width:100%;border-collapse:collapse}
th{font-size:10px;font-weight:700;color:var(--cfg-ink-faint);text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:4px 8px;border-bottom:1px solid var(--cfg-border)}
td{font-size:11.5px;padding:5px 8px;border-bottom:1px solid var(--cfg-surface-2);vertical-align:middle}
tr.hl td{background:var(--cfg-surface-2)}
td.matrix-cell{text-align:center;cursor:pointer}
td.matrix-cell.disabled{opacity:.35;cursor:default}

.btn-sm{background:var(--cfg-surface-2);border:1px solid var(--cfg-border);color:var(--cfg-ink);font-size:10.5px;font-weight:600;padding:3px 8px;border-radius:5px;cursor:pointer;font-family:inherit}
.btn-sm:hover{border-color:var(--cfg-accent)}
.btn-sm:disabled{opacity:.5;cursor:not-allowed}
.btn-sm.danger{color:var(--cfg-danger);border-color:var(--cfg-danger)}
.btn-sm.confirm{background:var(--cfg-danger);color:#fff;border-color:var(--cfg-danger)}
.btn-sm.primary{color:var(--cfg-accent);border-color:var(--cfg-accent)}

.cfg-row{display:contents}
.cfg-help{font-size:10.5px}
.cfg-err{color:var(--cfg-danger);font-size:10.5px}

.form-panel{background:var(--cfg-surface-2);border:1px solid var(--cfg-border);border-radius:8px;padding:10px;margin-top:6px;display:flex;flex-direction:column;gap:6px}
.form-panel .field{display:flex;flex-direction:column;gap:2px;font-size:11px}
.form-panel .field label{color:var(--cfg-ink-faint);font-size:10.5px}
.form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}

.reveal-box{background:var(--cfg-surface-2);border:1px dashed var(--cfg-warning);border-radius:8px;padding:10px;font-size:11px;display:flex;flex-direction:column;gap:6px}
.reveal-box code{display:block;word-break:break-all;background:var(--cfg-muted-bg);padding:4px 6px;border-radius:4px;font-family:Menlo,Monaco,monospace;font-size:10.5px}

.mm-list{max-height:160px;overflow-y:auto;margin-top:4px;padding:4px;background:var(--cfg-muted-bg);border-radius:5px}
.wallet-card-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}

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
  <div class="notice" id="pending-banner" style="display:none"></div>
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
var updateModelContext = null;
var onTeardownFn = null;
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
// never crash another card's render. An "unknown daemon tool" failure (a
// write tool, or config_get/config_set, on a daemon that predates them) is
// distinguished from any other failure so the caller can render a muted
// feature-detect note instead of an error. Used for BOTH reads and writes:
// every write tool here answers either a JSON object (success) or a plain
// string (its own error text), the same two shapes a read tool answers.
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

// Two-click confirm (ops-panel's pattern): first click arms the button
// ("sure?"), a second click within 4s fires the callback; anything else
// disarms it. Shared by every destructive action in this panel (delete
// wallet, delete preset, disable remote, revoke pairing).
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

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { toast("Copied.", false); }, function () { toast("Copy failed.", true); });
    return;
  }
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toast("Copied.", false);
  } catch (e) {
    toast("Copy failed.", true);
  }
}
function wireCopyButtons(container, valuesByKey) {
  var btns = container.querySelectorAll("[data-copy]");
  for (var i = 0; i < btns.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-copy");
        var value = valuesByKey[key];
        if (value) copyToClipboard(value);
      });
    })(btns[i]);
  }
}

// ============================================================
// generic config_get / config_set field editor — shared by Defaults,
// per-harness adapter defaults, and titler.model (Models section).
// ============================================================

// Last revision seen from ANY config_get/config_set response, reused on
// every write (the spec: "always pass the last revision"). A daemon that
// predates config_get/config_set never sets this; config_set is simply
// called without a revision then (server treats that as unconditional).
var configRevision = null;

// path -> true for every currently-known pending-restart key, merged from
// every config_get response seen anywhere in the app. Drives the persistent
// top banner — never restarts anything itself, only tells the user to.
var pendingRestartMap = {};

function notePendingRestart(rows) {
  var changed = false;
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (r.pendingRestart) {
      if (!pendingRestartMap[r.path]) changed = true;
      pendingRestartMap[r.path] = true;
    } else if (pendingRestartMap[r.path]) {
      delete pendingRestartMap[r.path];
      changed = true;
    }
  }
  if (changed) renderPendingBanner();
}

function renderPendingBanner() {
  var el = document.getElementById("pending-banner");
  if (!el) return;
  var keys = [];
  for (var k in pendingRestartMap) if (Object.prototype.hasOwnProperty.call(pendingRestartMap, k)) keys.push(k);
  if (keys.length === 0) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  keys.sort();
  el.style.display = "block";
  el.textContent = "Restart the daemon yourself to apply: " + keys.join(", ") + ". This app never restarts it for you.";
}

// Best-effort type inference for a config_get row: the wire shape today
// (config-tools.ts) does not yet carry valueType/enum/min/max, only the raw
// value/effective — so the control type is inferred from the JS type of
// whichever of effective/value/default is present. Forward-compatible: a
// row that DOES carry an explicit valueType (a future daemon) wins outright.
function inferValueType(row) {
  if (row.valueType) return row.valueType;
  var v = row.effective !== undefined ? row.effective : row.value;
  if (v === undefined) v = row.default;
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) {
    var allStr = true;
    for (var i = 0; i < v.length; i++) if (typeof v[i] !== "string") allStr = false;
    return allStr ? "string[]" : "object";
  }
  if (v && typeof v === "object") return "object";
  return "unknown";
}

// A handful of keys are known (from config-schema.ts) to be fixed enums;
// the wire doesn't say so yet, so this is a small hand-maintained hint
// table rather than an invented protocol field. Everything else with
// valueType "string" gets a plain text input — never a guessed dropdown.
function enumHintFor(path) {
  if (path === "worktrees.isolation") return ["always", "on-request", "never"];
  if (path === "spawn.attach") return ["always", "on-request"];
  if (path === "spawn.dedupe") return ["always", "on-request"];
  if (path === "defaults.messaging.agentInterrupt") return ["allow", "deny"];
  var parts = path.split(".");
  if (parts.length === 5 && parts[0] === "defaults" && parts[1] === "adapters" && parts[3] === "auth" && parts[4] === "mode") {
    return ["subscription", "api-key"];
  }
  return null;
}

// defaults.spawn.browser is "headless" or false, a checkbox whose two
// states are not plain true/false. A tiny special case rather than a
// general boolean-like-enum mechanism nothing else needs.
var BOOL_LIKE_FIELDS = {
  "defaults.spawn.browser": { on: "headless", off: false, onLabel: "headless" },
};

function pathId(path) { return "cfg-" + String(path).replace(/[^a-zA-Z0-9]/g, "-"); }

function writableReasonText(row) {
  if (row.secret) return "secret, set via wallets or the CLI";
  return "read-only, edit the config file by hand";
}

function configDisplayValue(row) {
  if (row.secret) {
    if (row.secret.set === false) return "not set";
    if (typeof row.secret.set === "boolean") {
      var bits = [];
      if (row.secret.fingerprint) bits.push(row.secret.fingerprint);
      if (row.secret.last4) bits.push(row.secret.last4);
      return bits.length ? bits.join(" / ") : "set";
    }
    var parts = [];
    for (var k in row.secret) {
      if (Object.prototype.hasOwnProperty.call(row.secret, k)) {
        parts.push(k + ": " + (row.secret[k] && row.secret[k].set ? "set" : "not set"));
      }
    }
    return parts.length ? parts.join(", ") : "no keys";
  }
  return row.effective !== undefined ? row.effective : row.value;
}

function configControlHtml(row) {
  var vt = inferValueType(row);
  var val = row.effective !== undefined ? row.effective : (row.value !== undefined ? row.value : row.default);
  var enumOpts = enumHintFor(row.path);
  var boolLike = BOOL_LIKE_FIELDS[row.path];
  var disabledAttr = row.writable ? "" : " disabled";
  var titleAttr = row.writable ? "" : ' title="' + escHtml(writableReasonText(row)) + '"';
  if (boolLike) {
    var checked = val === boolLike.on;
    return '<label class="inline"><input type="checkbox" data-cfg-bool-like="' + escHtml(row.path) + '"' + (checked ? " checked" : "") + disabledAttr + titleAttr + '> ' + escHtml(boolLike.onLabel || "on") + '</label>';
  }
  if (vt === "boolean") {
    return '<input type="checkbox" data-cfg-auto="' + escHtml(row.path) + '"' + (val ? " checked" : "") + disabledAttr + titleAttr + '>';
  }
  if (enumOpts) {
    var out = '<select data-cfg-auto="' + escHtml(row.path) + '"' + disabledAttr + titleAttr + '>';
    for (var i = 0; i < enumOpts.length; i++) {
      out += '<option value="' + escHtml(enumOpts[i]) + '"' + (enumOpts[i] === val ? " selected" : "") + '>' + escHtml(enumOpts[i]) + '</option>';
    }
    return out + '</select>';
  }
  if (vt === "number") {
    return '<input type="number" data-cfg-auto="' + escHtml(row.path) + '" value="' + escHtml(val == null ? "" : String(val)) + '"' + disabledAttr + titleAttr + '>';
  }
  if (vt === "string[]") {
    return '<input type="text" data-cfg-input="' + escHtml(row.path) + '" value="' + escHtml((val || []).join(", ")) + '" placeholder="comma, separated, list"' + disabledAttr + titleAttr + '>'
      + ' <button type="button" class="btn-sm" data-cfg-save="' + escHtml(row.path) + '"' + disabledAttr + '>save</button>';
  }
  if (vt === "object") {
    return '<div><textarea data-cfg-input="' + escHtml(row.path) + '" rows="4" style="width:100%;font-family:Menlo,Monaco,monospace;font-size:11px"' + disabledAttr + titleAttr + '>' + escHtml(JSON.stringify(val === undefined ? {} : val, null, 2)) + '</textarea>'
      + ' <button type="button" class="btn-sm" data-cfg-save="' + escHtml(row.path) + '"' + disabledAttr + '>save</button></div>';
  }
  return '<input type="text" data-cfg-auto="' + escHtml(row.path) + '" value="' + escHtml(val == null ? "" : String(val)) + '"' + disabledAttr + titleAttr + '>';
}

// One dl "row" for a config key. Wrapped in a display:contents div so the
// dt/dd pairs stay direct grid children (the 2-col dl grid) while still
// being addressable as one group for wiring/lookup. A writable:false row
// still renders a real control (checkbox/select/input), just disabled,
// with the reason in its title, never a second, ad hoc read-only widget.
function configFieldHtml(row) {
  var label = row.label || humanize(String(row.path).split(".").slice(-1)[0]);
  var badge = '<span class="tag">' + escHtml(row.apply) + '</span>';
  var extra = "";
  if (row.source === "env" && row.envOverride) extra += ' <span class="tag bad">env ' + escHtml(row.envOverride) + '</span>';
  if (row.pendingRestart) extra += ' <span class="tag warn-tag">restart pending</span>';

  var dd = "";
  if (row.secret) {
    dd += escHtml(String(configDisplayValue(row)));
  } else {
    dd += configControlHtml(row);
  }
  dd += " " + badge + extra;
  if (row.writable && !row.secret && row.value !== undefined) {
    dd += ' <button type="button" class="btn-sm" data-cfg-reset="' + escHtml(row.path) + '" title="Reset to default">reset</button>';
  }

  var html = '<div class="cfg-row" data-cfg-path="' + escHtml(row.path) + '">'
    + '<dt title="' + escHtml(row.path) + '">' + escHtml(label) + '</dt><dd>' + dd + '</dd>';
  if (row.help) html += '<dt></dt><dd class="cfg-help muted">' + escHtml(row.help) + '</dd>';
  html += '<dt></dt><dd class="cfg-err" data-cfg-err="' + escHtml(row.path) + '" style="display:none"></dd>';
  html += '</div>';
  return html;
}

function buildConfigCardHtml(cardId, title, rows) {
  var body = "";
  for (var i = 0; i < rows.length; i++) body += configFieldHtml(rows[i]);
  return '<div class="card" data-card-id="' + escHtml(cardId) + '"><div class="body"><dl>' + body + '</dl></div></div>';
}

function extractConfigSetErrorCode(message) {
  var s = String(message || "");
  var start = s.indexOf("[");
  var end = start === -1 ? -1 : s.indexOf("]", start);
  if (start === -1 || end === -1) return "";
  return s.slice(start + 1, end);
}

function describeConfigSetError(message) {
  var code = extractConfigSetErrorCode(message);
  var HUMAN = {
    invalid_input: "That request was not valid.",
    unknown_key: "This daemon does not know that setting.",
    not_writable: "This setting cannot be changed here.",
    invalid_value: "That value is not valid for this setting.",
    invalid_config: "That change would leave the config file invalid.",
    stale_revision: "This section changed elsewhere. Reloading.",
  };
  return HUMAN[code] || message;
}

// Attach listeners for every config control inside "container". rowsByPath
// supplies the row metadata a save/reset needs (valueType for parsing).
// onSaved(path) fires after a successful write (path just written);
// onStale() fires on a stale_revision rejection (reload the section).
function wireConfigRows(container, rowsByPath, onSaved, onStale) {
  function submit(path, value, isUnset) {
    var args = isUnset ? { key: path, unset: true, revision: configRevision } : { key: path, value: value, revision: configRevision };
    return loadTool("config_set", args).then(function (r) {
      if (!r.ok) {
        var stale = extractConfigSetErrorCode(r.message) === "stale_revision";
        toast(describeConfigSetError(r.message), true);
        if (stale && onStale) onStale();
        return;
      }
      var data = r.data;
      if (data && data.revision) configRevision = data.revision;
      var note = "Saved.";
      if (data && data.applied === "restart-required") note = "Saved. Restart required to apply.";
      if (data && data.shadowedByEnv) note += " Overridden by " + data.shadowedByEnv + ".";
      toast(note, false);
      if (onSaved) onSaved(path);
    });
  }

  var autos = container.querySelectorAll("[data-cfg-auto]");
  for (var i = 0; i < autos.length; i++) {
    (function (el) {
      el.addEventListener("change", function () {
        var path = el.getAttribute("data-cfg-auto");
        var value;
        if (el.type === "checkbox") value = el.checked;
        else if (el.type === "number") value = el.value === "" ? null : Number(el.value);
        else value = el.value;
        submit(path, value, false);
      });
    })(autos[i]);
  }

  var boolLikes = container.querySelectorAll("[data-cfg-bool-like]");
  for (var b = 0; b < boolLikes.length; b++) {
    (function (el) {
      el.addEventListener("change", function () {
        var path = el.getAttribute("data-cfg-bool-like");
        var spec = BOOL_LIKE_FIELDS[path];
        submit(path, el.checked ? spec.on : spec.off, false);
      });
    })(boolLikes[b]);
  }

  var saves = container.querySelectorAll("[data-cfg-save]");
  for (var s = 0; s < saves.length; s++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var path = btn.getAttribute("data-cfg-save");
        var row = rowsByPath[path];
        var input = container.querySelector('[data-cfg-input="' + cssEscape(path) + '"]');
        var errEl = container.querySelector('[data-cfg-err="' + cssEscape(path) + '"]');
        if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }
        var vt = row ? inferValueType(row) : "string";
        var value;
        if (vt === "string[]") {
          value = input.value.split(",").map(function (x) { return x.trim(); }).filter(function (x) { return x.length > 0; });
        } else if (vt === "object") {
          try {
            value = JSON.parse(input.value);
          } catch (e) {
            if (errEl) { errEl.style.display = "block"; errEl.textContent = "Invalid JSON: " + e.message; }
            return;
          }
        } else {
          value = input.value;
        }
        submit(path, value, false);
      });
    })(saves[s]);
  }

  var resets = container.querySelectorAll("[data-cfg-reset]");
  for (var r = 0; r < resets.length; r++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        submit(btn.getAttribute("data-cfg-reset"), undefined, true);
      });
    })(resets[r]);
  }
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

// Clears every secret this panel ever holds only in memory (a remote-enable
// reveal, a pairing offer) — called on navigating away from #remote and on
// host teardown. Never persisted, never in updateModelContext.
function clearRemoteSecrets() {
  remoteReveal = null;
  pairReveal = null;
  clearPairCountdown();
  // The #sec-remote DOM may still show a rendered reveal box from before
  // this call — clearing the variable alone does not touch it. Force the
  // next visit to re-fetch and re-render from scratch (remoteReveal is
  // null by then, so no reveal box comes back) instead of leaving the
  // stale secret sitting in a hidden .section until some other event
  // happens to re-render it.
  loaded.remote = false;
}

function route(pushBack) {
  var parsed = parseConfigFragment(location.hash);
  if (current.section === "remote" && parsed.section !== "remote") {
    clearRemoteSecrets();
  }
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

var walletsState = {
  window: "7d",
  profilesResult: null,
  rollupResult: null,
  presetsResult: null,
  discoveredResult: null,
  showAddForm: false,
  showDiscovered: false,
  expanded: {}, // profileId -> { edit: bool, curate: bool }
  providerModelsByEndpoint: {}, // endpoint -> catalog_provider_models rows
};

function loadWallets() {
  return Promise.all([
    loadTool("auth_profile_list", { full: true }),
    loadTool("usage_rollup", { window: walletsState.window, groupBy: ["profile"] }),
    loadTool("harness_preset_list", {}),
  ]).then(function (results) {
    walletsState.profilesResult = results[0];
    walletsState.rollupResult = results[1];
    walletsState.presetsResult = results[2];
    renderWallets();
  });
}

function reloadWalletsWindow(win) {
  walletsState.window = win;
  fetchRollup(false);
}

function fetchRollup(probe) {
  return loadTool("usage_rollup", { window: walletsState.window, groupBy: ["profile"], probe: !!probe }).then(function (r) {
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

function presetsReferencing(profileId) {
  var out = [];
  var pr = walletsState.presetsResult;
  if (!pr || !pr.ok) return out;
  var presets = (pr.data && pr.data.presets) || [];
  for (var i = 0; i < presets.length; i++) {
    if (presets[i].profileRef === profileId) out.push(presets[i]);
  }
  return out;
}

function getWalletExpanded(id) {
  if (!walletsState.expanded[id]) walletsState.expanded[id] = { edit: false, curate: false, curateMode: undefined };
  return walletsState.expanded[id];
}

function replaceProfileInState(profile) {
  var pr = walletsState.profilesResult;
  if (!pr || !pr.ok || !pr.data || !Array.isArray(pr.data.profiles)) return;
  var list = pr.data.profiles;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === profile.id) { list[i] = profile; return; }
  }
  list.push(profile);
}

function removeProfileFromState(id) {
  var pr = walletsState.profilesResult;
  if (!pr || !pr.ok || !pr.data || !Array.isArray(pr.data.profiles)) return;
  pr.data.profiles = pr.data.profiles.filter(function (p) { return p.id !== id; });
}

function renderWallets() {
  var el = document.getElementById("sec-wallets");
  var rr = walletsState.rollupResult;
  var html = '<div class="sect-h">Spend<span class="pillbar" id="wallet-window"></span>'
    + '<button type="button" class="btn-sm" id="spend-refresh-live">refresh live</button></div>'
    + '<div class="muted-note" style="padding:0 0 4px">Refreshing live consumes a small sliver of the rate budget for that wallet.</div>';

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

  html += '<div class="sect-h">Wallets'
    + '<button type="button" class="btn-sm" id="wallet-add-toggle">' + (walletsState.showAddForm ? "close" : "+ add wallet") + '</button>'
    + '<button type="button" class="btn-sm" id="wallet-scan-toggle">' + (walletsState.showDiscovered ? "close" : "find credentials") + '</button>'
    + '</div>';

  if (walletsState.showAddForm) html += addWalletFormHtml();
  if (walletsState.showDiscovered) html += discoveredCredentialsHtml();

  html += '<div class="grid" id="wallet-cards"></div>';

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
  document.getElementById("spend-refresh-live").addEventListener("click", function () { fetchRollup(true); });

  document.getElementById("wallet-add-toggle").addEventListener("click", function () {
    walletsState.showAddForm = !walletsState.showAddForm;
    renderWallets();
  });
  document.getElementById("wallet-scan-toggle").addEventListener("click", function () {
    walletsState.showDiscovered = !walletsState.showDiscovered;
    if (walletsState.showDiscovered && !walletsState.discoveredResult) {
      loadTool("auth_discover_credentials", {}).then(function (r) {
        walletsState.discoveredResult = r;
        renderWallets();
      });
      return;
    }
    renderWallets();
  });

  wireAddWalletForm(el);
  wireDiscoveredCredentials(el);
  renderWalletCards();
}

function addWalletFormHtml() {
  return '<div class="form-panel" id="wallet-add-form">'
    + '<div class="form-row">'
    + '<div class="field"><label>Id</label><input type="text" id="wf-id" placeholder="my-anthropic-key"></div>'
    + '<div class="field"><label>Endpoint</label><input type="text" id="wf-endpoint" list="wf-endpoint-list" placeholder="anthropic"><datalist id="wf-endpoint-list">'
    + '<option value="anthropic"><option value="openrouter"><option value="moonshot"><option value="openai"></datalist></div>'
    + '<div class="field"><label>Method</label><select id="wf-method"><option value="api-key">API key</option><option value="oauth-bearer">Subscription</option></select></div>'
    + '<div class="field"><label>Label (optional)</label><input type="text" id="wf-label"></div>'
    + '</div>'
    + '<div class="form-row">'
    + '<div class="field"><label>Credential</label><input type="password" id="wf-credential" placeholder="paste secret"></div>'
    + '<div class="field" id="wf-source-field" style="display:none"><label>Self-refreshing source (alternative)</label><input type="text" id="wf-source" placeholder="claude-code-oauth"></div>'
    + '<button type="button" class="btn-sm primary" id="wf-submit">Create wallet</button>'
    + '</div>'
    + '<div class="cfg-err" id="wf-err" style="display:none"></div>'
    + '</div>';
}

function wireAddWalletForm(container) {
  var methodEl = container.querySelector("#wf-method");
  var sourceField = container.querySelector("#wf-source-field");
  if (!methodEl) return;
  methodEl.addEventListener("change", function () {
    sourceField.style.display = methodEl.value === "oauth-bearer" ? "" : "none";
  });
  container.querySelector("#wf-submit").addEventListener("click", function () {
    var errEl = container.querySelector("#wf-err");
    errEl.style.display = "none";
    var id = container.querySelector("#wf-id").value.trim();
    var endpoint = container.querySelector("#wf-endpoint").value.trim();
    var method = methodEl.value;
    var label = container.querySelector("#wf-label").value.trim();
    var credentialInput = container.querySelector("#wf-credential");
    var sourceInput = container.querySelector("#wf-source");
    var credential = credentialInput.value;
    var source = method === "oauth-bearer" ? sourceInput.value.trim() : "";
    // Clear the secret from the DOM and this local scope's reference to it
    // immediately, before the async call even starts.
    credentialInput.value = "";
    if (!id || !endpoint) {
      errEl.style.display = "block";
      errEl.textContent = "Id and endpoint are required.";
      credential = "";
      return;
    }
    if (!credential && !source) {
      errEl.style.display = "block";
      errEl.textContent = "Give either a credential or a self-refreshing source.";
      credential = "";
      return;
    }
    var args = { id: id, endpoint: endpoint, method: method };
    if (label) args.label = label;
    if (credential) args.credential = credential;
    else if (source) args.source = source;
    credential = "";
    loadTool("auth_profile_create", args).then(function (r) {
      if (!r.ok) {
        errEl.style.display = "block";
        errEl.textContent = r.message;
        return;
      }
      toast("Wallet created.", false);
      walletsState.showAddForm = false;
      loadWallets();
    });
  });
}

function discoveredCredentialsHtml() {
  var dr = walletsState.discoveredResult;
  var html = '<div class="card"><div class="body">';
  if (!dr) {
    html += '<div class="muted-note">scanning&hellip;</div>';
  } else if (!dr.ok) {
    html += '<div class="muted-note">auth_discover_credentials: ' + escHtml(dr.message) + '</div>';
  } else {
    var creds = (dr.data && dr.data.credentials) || [];
    if (creds.length === 0) {
      html += '<div class="empty">No importable credentials found on this host.</div>';
    } else {
      html += '<table><thead><tr><th>Endpoint</th><th>Method</th><th>Origin</th><th>Hint</th><th></th></tr></thead><tbody>';
      for (var i = 0; i < creds.length; i++) {
        var c = creds[i];
        var defaultId = c.origin + "-" + c.endpoint;
        html += '<tr><td>' + escHtml(c.endpoint) + '</td><td>' + escHtml(BILLING_LABELS[c.method] || c.method) + '</td><td>' + escHtml(c.origin) + '</td><td>' + escHtml(c.hint) + '</td>'
          + '<td><input type="text" class="dc-id" data-dc-idx="' + i + '" value="' + escHtml(defaultId) + '" style="width:120px">'
          + ' <button type="button" class="btn-sm" data-dc-import="' + i + '">import</button></td></tr>';
      }
      html += '</tbody></table>';
    }
  }
  html += '</div></div>';
  return html;
}

function wireDiscoveredCredentials(container) {
  var btns = container.querySelectorAll("[data-dc-import]");
  for (var i = 0; i < btns.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var idx = Number(btn.getAttribute("data-dc-import"));
        var dr = walletsState.discoveredResult;
        var c = dr && dr.ok && dr.data.credentials[idx];
        if (!c) return;
        var idInput = container.querySelector('.dc-id[data-dc-idx="' + idx + '"]');
        var id = (idInput && idInput.value.trim()) || (c.origin + "-" + c.endpoint);
        loadTool("auth_profile_import", { origin: c.origin, endpoint: c.endpoint, id: id }).then(function (r) {
          if (!r.ok) { toast(r.message, true); return; }
          toast("Imported.", false);
          loadWallets();
        });
      });
    })(btns[i]);
  }
}

function renderWalletCards() {
  var cardsEl = document.getElementById("wallet-cards");
  if (!cardsEl) return;
  var pr = walletsState.profilesResult;
  if (!pr || !pr.ok) {
    cardsEl.innerHTML = '<div class="empty">' + (pr ? escHtml(pr.message) : "loading&hellip;") + '</div>';
    return;
  }
  var profiles = (pr.data && pr.data.profiles) || [];
  if (profiles.length === 0) {
    cardsEl.innerHTML = '<div class="empty">No auth profiles configured on this host.</div>';
    return;
  }
  var rr = walletsState.rollupResult;
  var spend = rr && rr.ok ? byProfileMap(rr) : {};
  var out = "";
  for (var i = 0; i < profiles.length; i++) {
    out += walletCardHtml(profiles[i], spend[profiles[i].id]);
  }
  cardsEl.innerHTML = out;
  wireWalletCards(cardsEl);
}

function walletCardHtml(p, spend) {
  var title = p.label || p.id;
  var exp = getWalletExpanded(p.id);
  var out = cardOpen(p.id, title, escHtml(p.endpoint));
  out += row("Method", escHtml(BILLING_LABELS[p.method] || humanize(p.method)));
  var keyLine = p.keyStatus === "stored"
    ? [p.fingerprint, p.last4].filter(Boolean).join(" &middot; ") || "stored"
    : p.keyStatus === "self-refreshing" ? "self-refreshing" : "unavailable";
  out += row("Key", escHtml(keyLine));
  if (p.origin) out += row("Imported from", escHtml(p.origin));
  out += '<dt>Enabled</dt><dd><label class="inline"><input type="checkbox" data-wallet-enabled="' + escHtml(p.id) + '"' + (p.disabled ? "" : " checked") + '></label></dd>';
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
  out += '<div class="wallet-card-actions">'
    + '<button type="button" class="btn-sm" data-wallet-edit-toggle="' + escHtml(p.id) + '">' + (exp.edit ? "close" : "rename / budget") + '</button>'
    + '<button type="button" class="btn-sm" data-wallet-curate-toggle="' + escHtml(p.id) + '">' + (exp.curate ? "close" : "manage models") + '</button>'
    + '<button type="button" class="btn-sm danger" data-wallet-delete="' + escHtml(p.id) + '">delete</button>'
    + '</div>';
  if (exp.edit) out += walletEditPanelHtml(p);
  if (exp.curate) out += walletModelsEditorHtml(p, walletsState.providerModelsByEndpoint[p.endpoint], exp.curateMode);
  out += cardClose();
  return out;
}

function walletEditPanelHtml(p) {
  var hasBudget = !!(p.costBudget && typeof p.costBudget.maxCostUsd === "number");
  return '<div class="form-panel" data-wallet-edit-panel="' + escHtml(p.id) + '">'
    + '<div class="field"><label>Label</label><input type="text" class="we-label" value="' + escHtml(p.label || "") + '"></div>'
    + '<label class="inline"><input type="checkbox" class="we-no-budget"' + (hasBudget ? "" : " checked") + '> no spend cap</label>'
    + '<div class="form-row we-budget-fields" style="' + (hasBudget ? "" : "display:none") + '">'
    + '<div class="field"><label>Max cost (USD)</label><input type="number" class="we-max-cost" value="' + escHtml(hasBudget ? String(p.costBudget.maxCostUsd) : "") + '"></div>'
    + '<div class="field"><label>Window</label><input type="text" class="we-window" value="' + escHtml(hasBudget ? p.costBudget.window : "7d") + '"></div>'
    + '<div class="field"><label>Scope</label><select class="we-scope"><option value="profile"' + (hasBudget && p.costBudget.scope === "profile" ? " selected" : "") + '>profile</option><option value="session"' + (hasBudget && p.costBudget.scope === "session" ? " selected" : "") + '>session</option></select></div>'
    + '</div>'
    + '<button type="button" class="btn-sm primary" data-wallet-edit-save="' + escHtml(p.id) + '">save</button>'
    + '</div>';
}

// pendingMode is the panel's OWN pending selection (getWalletExpanded's
// curateMode), not necessarily what the server has stored yet: switching to
// "curate" must reveal the checklist right away so there is something to
// check, without writing a destructive "curate to nothing" the instant the
// radio moves. The first checked model is what actually persists the
// mode=allow switch (see the .mm-id change handler).
function walletModelsEditorHtml(p, catalogRows, pendingMode) {
  var mode = pendingMode || (p.models && p.models.mode) || "all";
  var ids = (p.models && p.models.ids) || [];
  var html = '<div class="form-panel" data-wallet-models-panel="' + escHtml(p.id) + '">';
  html += '<label class="inline"><input type="radio" name="mm-mode-' + escHtml(p.id) + '" value="all" class="mm-mode" data-mm-profile="' + escHtml(p.id) + '"' + (mode === "all" ? " checked" : "") + '> service all eligible</label> ';
  html += '<label class="inline"><input type="radio" name="mm-mode-' + escHtml(p.id) + '" value="allow" class="mm-mode" data-mm-profile="' + escHtml(p.id) + '"' + (mode === "allow" ? " checked" : "") + '> curate</label>';
  if (mode === "allow") html += ' <button type="button" class="btn-sm" data-mm-refresh="' + escHtml(p.id) + '">refresh models</button>';
  html += '<div class="mm-list" data-mm-list="' + escHtml(p.id) + '" style="' + (mode === "allow" ? "" : "display:none") + '">';
  if (mode === "allow") {
    if (!catalogRows) {
      html += '<div class="muted-note">loading models&hellip;</div>';
    } else if (catalogRows.length === 0) {
      html += '<div class="empty">No models known for this endpoint.</div>';
    } else {
      for (var i = 0; i < catalogRows.length; i++) {
        var m = catalogRows[i];
        var checked = ids.indexOf(m.id) !== -1;
        html += '<label class="inline" style="display:block;margin:2px 0"><input type="checkbox" class="mm-id" data-mm-profile="' + escHtml(p.id) + '" value="' + escHtml(m.id) + '"' + (checked ? " checked" : "") + '> ' + escHtml(m.label || m.id) + '</label>';
      }
    }
  }
  html += '</div></div>';
  return html;
}

function wireWalletCards(container) {
  var enabledToggles = container.querySelectorAll("[data-wallet-enabled]");
  for (var i = 0; i < enabledToggles.length; i++) {
    (function (el) {
      el.addEventListener("change", function () {
        var id = el.getAttribute("data-wallet-enabled");
        var wantEnabled = el.checked;
        el.disabled = true;
        loadTool("auth_profile_set_enabled", { id: id, enabled: wantEnabled }).then(function (r) {
          el.disabled = false;
          if (!r.ok) { toast(r.message, true); el.checked = !wantEnabled; return; }
          replaceProfileInState(r.data.profile);
          toast(wantEnabled ? "Wallet enabled." : "Wallet disabled.", false);
          renderWalletCards();
        });
      });
    })(enabledToggles[i]);
  }

  var editToggles = container.querySelectorAll("[data-wallet-edit-toggle]");
  for (var e = 0; e < editToggles.length; e++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-wallet-edit-toggle");
        var exp = getWalletExpanded(id);
        exp.edit = !exp.edit;
        renderWalletCards();
      });
    })(editToggles[e]);
  }

  var editSaves = container.querySelectorAll("[data-wallet-edit-save]");
  for (var s = 0; s < editSaves.length; s++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-wallet-edit-save");
        var panel = container.querySelector('[data-wallet-edit-panel="' + cssEscape(id) + '"]');
        var label = panel.querySelector(".we-label").value.trim();
        var noBudget = panel.querySelector(".we-no-budget").checked;
        var patch = { id: id, label: label === "" ? null : label };
        if (noBudget) {
          patch.costBudget = null;
        } else {
          patch.costBudget = {
            maxCostUsd: Number(panel.querySelector(".we-max-cost").value) || 0,
            window: panel.querySelector(".we-window").value.trim() || "7d",
            scope: panel.querySelector(".we-scope").value,
          };
        }
        loadTool("auth_profile_update", patch).then(function (r) {
          if (!r.ok) { toast(r.message, true); return; }
          replaceProfileInState(r.data.profile);
          toast("Wallet updated.", false);
          getWalletExpanded(id).edit = false;
          renderWalletCards();
        });
      });
    })(editSaves[s]);
  }

  var noBudgetToggles = container.querySelectorAll(".we-no-budget");
  for (var nb = 0; nb < noBudgetToggles.length; nb++) {
    (function (el) {
      el.addEventListener("change", function () {
        var fields = el.parentElement.querySelector(".we-budget-fields");
        if (fields) fields.style.display = el.checked ? "none" : "";
      });
    })(noBudgetToggles[nb]);
  }

  var curateToggles = container.querySelectorAll("[data-wallet-curate-toggle]");
  for (var c = 0; c < curateToggles.length; c++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-wallet-curate-toggle");
        var exp = getWalletExpanded(id);
        exp.curate = !exp.curate;
        if (exp.curate) {
          var profile = findProfile(id);
          if (profile && !walletsState.providerModelsByEndpoint[profile.endpoint]) {
            loadTool("catalog_provider_models", { endpoint: profile.endpoint, limit: 200 }).then(function (r) {
              walletsState.providerModelsByEndpoint[profile.endpoint] = r.ok ? (r.data.models || []) : [];
              renderWalletCards();
            });
            return;
          }
        }
        renderWalletCards();
      });
    })(curateToggles[c]);
  }

  var mmModes = container.querySelectorAll(".mm-mode");
  for (var mm = 0; mm < mmModes.length; mm++) {
    (function (el) {
      el.addEventListener("change", function () {
        var id = el.getAttribute("data-mm-profile");
        if (el.value === "all") {
          getWalletExpanded(id).curateMode = undefined;
          loadTool("auth_profile_set_models", { id: id, mode: "all" }).then(function (r) {
            if (!r.ok) { toast(r.message, true); return; }
            replaceProfileInState(r.data.profile);
            renderWalletCards();
          });
        } else {
          // Reveal the checklist locally (a pending selection, independent
          // of what the server has stored); nothing is written until a
          // model is actually checked, so switching this radio alone can
          // never silently curate the wallet down to nothing.
          getWalletExpanded(id).curateMode = "allow";
          renderWalletCards();
        }
      });
    })(mmModes[mm]);
  }

  var mmIds = container.querySelectorAll(".mm-id");
  for (var mi = 0; mi < mmIds.length; mi++) {
    (function (el) {
      el.addEventListener("change", function () {
        var id = el.getAttribute("data-mm-profile");
        var list = container.querySelector('[data-mm-list="' + cssEscape(id) + '"]');
        var checked = list.querySelectorAll(".mm-id:checked");
        var ids = [];
        for (var i2 = 0; i2 < checked.length; i2++) ids.push(checked[i2].value);
        loadTool("auth_profile_set_models", { id: id, mode: "allow", ids: ids }).then(function (r) {
          if (!r.ok) { toast(r.message, true); return; }
          replaceProfileInState(r.data.profile);
        });
      });
    })(mmIds[mi]);
  }

  var mmRefresh = container.querySelectorAll("[data-mm-refresh]");
  for (var mr = 0; mr < mmRefresh.length; mr++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-mm-refresh");
        loadTool("auth_profile_refresh_models", { id: id }).then(function (r) {
          if (!r.ok) { toast(r.message, true); return; }
          replaceProfileInState(r.data.profile);
          var added = (r.data.added || []).length;
          var removed = (r.data.removed || []).length;
          toast("Refreshed models (+" + added + " / -" + removed + ").", false);
          renderWalletCards();
        });
      });
    })(mmRefresh[mr]);
  }

  var deleteBtns = container.querySelectorAll("[data-wallet-delete]");
  for (var d = 0; d < deleteBtns.length; d++) {
    (function (btn) {
      var id = btn.getAttribute("data-wallet-delete");
      btn.addEventListener("click", function () {
        confirmClick("wallet-delete-" + id, btn, function () {
          var blockedBy = presetsReferencing(id);
          if (blockedBy.length > 0) {
            var names = blockedBy.map(function (p) { return p.name || p.id; }).join(", ");
            toast("Cannot delete: still used by harness preset(s) " + names + ".", true);
            return;
          }
          loadTool("auth_profile_delete", { id: id }).then(function (r) {
            if (!r.ok) { toast(r.message, true); return; }
            removeProfileFromState(id);
            toast("Wallet deleted.", false);
            renderWalletCards();
          });
        });
      });
    })(deleteBtns[d]);
  }
}

function findProfile(id) {
  var pr = walletsState.profilesResult;
  if (!pr || !pr.ok) return null;
  var list = (pr.data && pr.data.profiles) || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

// ============================================================
// Harnesses
// ============================================================

var harnessesState = {
  adaptersResult: null,
  capsResult: null,
  presetsResult: null,
  rolesResult: null,
  profilesResult: null,
  expandedDefaults: {}, // slug -> bool
  defaultsCache: {}, // slug -> row[]
  showPresetForm: false,
};

function loadHarnesses() {
  return Promise.all([
    loadTool("adapter_list", {}),
    loadTool("harness_capabilities", {}),
    loadTool("harness_preset_list", {}),
    loadTool("role_list", {}),
    loadTool("auth_profile_list", {}),
  ]).then(function (results) {
    harnessesState.adaptersResult = results[0];
    harnessesState.capsResult = results[1];
    harnessesState.presetsResult = results[2];
    harnessesState.rolesResult = results[3];
    harnessesState.profilesResult = results[4];
    renderHarnesses();
  });
}

function adapterDefaultsPaths(slug) {
  return [
    "defaults.adapters." + slug + ".skills",
    "defaults.adapters." + slug + ".options",
    "defaults.adapters." + slug + ".contextContinuity",
    "defaults.adapters." + slug + ".auth.mode",
    "defaults.adapters." + slug + ".auth.source",
    "defaults.adapters." + slug + ".auth.provider",
    "defaults.adapters." + slug + ".auth.token",
    "defaults.adapters." + slug + ".auth.apiKey",
  ];
}

function renderHarnesses() {
  var el = document.getElementById("sec-harnesses");
  var adaptersR = harnessesState.adaptersResult;
  var capsR = harnessesState.capsResult;
  var presetsR = harnessesState.presetsResult;
  var rolesR = harnessesState.rolesResult;
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
  var allPresets = [];
  if (presetsR.ok) {
    allPresets = (presetsR.data && presetsR.data.presets) || [];
    for (var j = 0; j < allPresets.length; j++) {
      var slug = allPresets[j].harnessSlug;
      if (!presetsBySlug[slug]) presetsBySlug[slug] = [];
      presetsBySlug[slug].push(allPresets[j]);
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
    html += '<dt></dt><dd><button type="button" class="btn-sm" data-adapter-defaults-toggle="' + escHtml(a.slug) + '">' + (harnessesState.expandedDefaults[a.slug] ? "hide defaults" : "spawn defaults") + '</button></dd>';
    html += '<div id="adapter-defaults-' + escHtml(a.slug) + '"></div>';
    html += cardClose();
  }
  html += '</div>';

  html += '<div class="sect-h">Presets<button type="button" class="btn-sm" id="preset-add-toggle">' + (harnessesState.showPresetForm ? "close" : "+ new preset") + '</button></div>';
  if (harnessesState.showPresetForm) html += presetFormHtml(adapters);
  html += presetsTableHtml(allPresets);

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
  wireAdapterDefaultsToggles(el);
  wirePresetForm(el, adapters);
  wirePresetsTable(el);

  for (var slug2 in harnessesState.expandedDefaults) {
    if (harnessesState.expandedDefaults[slug2] && harnessesState.defaultsCache[slug2]) {
      renderAdapterDefaultsCard(slug2);
    }
  }
}

function presetsTableHtml(presets) {
  if (presets.length === 0) return '<div class="empty">No harness presets configured.</div>';
  var html = '<div class="card"><div class="body"><table><thead><tr><th>Id</th><th>Harness</th><th>Name</th><th>Wallet</th><th>Model</th><th>Default</th><th></th></tr></thead><tbody>';
  for (var i = 0; i < presets.length; i++) {
    var p = presets[i];
    html += '<tr data-row-id="' + escHtml(p.id) + '"><td>' + escHtml(p.id) + '</td><td>' + escHtml(p.harnessSlug) + '</td><td>' + escHtml(p.name) + '</td>'
      + '<td><a class="link" data-goto="wallets/' + encodeURIComponent(p.profileRef) + '">' + escHtml(p.profileRef) + '</a>' + (p.profileDisabled ? ' <span class="tag bad">disabled/missing</span>' : '') + '</td>'
      + '<td>' + escHtml(p.defaultModel) + '</td>'
      + '<td>' + (p.isDefault ? '<span class="tag ok">default</span>' : '<button type="button" class="btn-sm" data-preset-set-default="' + escHtml(p.id) + '" data-preset-harness="' + escHtml(p.harnessSlug) + '">set default</button>') + '</td>'
      + '<td><button type="button" class="btn-sm danger" data-preset-delete="' + escHtml(p.id) + '">delete</button></td></tr>';
  }
  html += '</tbody></table></div></div>';
  return html;
}

function presetFormHtml(adapters) {
  var profiles = (harnessesState.profilesResult && harnessesState.profilesResult.ok && harnessesState.profilesResult.data.profiles) || [];
  var html = '<div class="form-panel">'
    + '<div class="form-row">'
    + '<div class="field"><label>Id</label><input type="text" id="pf-id"></div>'
    + '<div class="field"><label>Harness</label><select id="pf-harness">';
  for (var i = 0; i < adapters.length; i++) html += '<option value="' + escHtml(adapters[i].slug) + '">' + escHtml(adapters[i].slug) + '</option>';
  html += '</select></div>'
    + '<div class="field"><label>Name</label><input type="text" id="pf-name"></div>'
    + '</div><div class="form-row">'
    + '<div class="field"><label>Wallet</label><select id="pf-profile">';
  for (var j = 0; j < profiles.length; j++) html += '<option value="' + escHtml(profiles[j].id) + '">' + escHtml(profiles[j].label || profiles[j].id) + '</option>';
  html += '</select></div>'
    + '<div class="field"><label>Default model</label><input type="text" id="pf-model" placeholder="vendor/model"></div>'
    + '<label class="inline"><input type="checkbox" id="pf-default"> make default for this harness</label>'
    + '<button type="button" class="btn-sm primary" id="pf-submit">Create preset</button>'
    + '</div><div class="cfg-err" id="pf-err" style="display:none"></div></div>';
  return html;
}

function wirePresetForm(container, adapters) {
  var toggle = container.querySelector("#preset-add-toggle");
  if (toggle) toggle.addEventListener("click", function () {
    harnessesState.showPresetForm = !harnessesState.showPresetForm;
    renderHarnesses();
  });
  var submit = container.querySelector("#pf-submit");
  if (!submit) return;
  submit.addEventListener("click", function () {
    var errEl = container.querySelector("#pf-err");
    errEl.style.display = "none";
    var id = container.querySelector("#pf-id").value.trim();
    var harnessSlug = container.querySelector("#pf-harness").value;
    var name = container.querySelector("#pf-name").value.trim();
    var profileRef = container.querySelector("#pf-profile").value;
    var defaultModel = container.querySelector("#pf-model").value.trim();
    var isDefault = container.querySelector("#pf-default").checked;
    if (!id || !name || !defaultModel || !profileRef) {
      errEl.style.display = "block";
      errEl.textContent = "Id, name, wallet, and default model are required.";
      return;
    }
    loadTool("harness_preset_create", { id: id, harnessSlug: harnessSlug, name: name, profileRef: profileRef, defaultModel: defaultModel, isDefault: isDefault }).then(function (r) {
      if (!r.ok) { errEl.style.display = "block"; errEl.textContent = r.message; return; }
      toast("Preset saved.", false);
      harnessesState.showPresetForm = false;
      loadHarnesses();
    });
  });
}

function wirePresetsTable(container) {
  var setDefaults = container.querySelectorAll("[data-preset-set-default]");
  for (var i = 0; i < setDefaults.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var presetId = btn.getAttribute("data-preset-set-default");
        var harnessSlug = btn.getAttribute("data-preset-harness");
        loadTool("harness_preset_set_default", { harnessSlug: harnessSlug, presetId: presetId }).then(function (r) {
          if (!r.ok) { toast(r.message, true); return; }
          toast("Default preset updated.", false);
          loadHarnesses();
        });
      });
    })(setDefaults[i]);
  }
  var deletes = container.querySelectorAll("[data-preset-delete]");
  for (var d = 0; d < deletes.length; d++) {
    (function (btn) {
      var presetId = btn.getAttribute("data-preset-delete");
      btn.addEventListener("click", function () {
        confirmClick("preset-delete-" + presetId, btn, function () {
          loadTool("harness_preset_delete", { id: presetId }).then(function (r) {
            if (!r.ok) { toast(r.message, true); return; }
            toast("Preset deleted.", false);
            loadHarnesses();
          });
        });
      });
    })(deletes[d]);
  }
}

function wireAdapterDefaultsToggles(container) {
  var toggles = container.querySelectorAll("[data-adapter-defaults-toggle]");
  for (var i = 0; i < toggles.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var slug = btn.getAttribute("data-adapter-defaults-toggle");
        harnessesState.expandedDefaults[slug] = !harnessesState.expandedDefaults[slug];
        if (harnessesState.expandedDefaults[slug] && !harnessesState.defaultsCache[slug]) {
          loadTool("config_get", { keys: adapterDefaultsPaths(slug) }).then(function (r) {
            if (r.ok && r.data.revision) configRevision = r.data.revision;
            harnessesState.defaultsCache[slug] = r.ok ? (r.data.keys || []) : [];
            if (r.ok) notePendingRestart(r.data.keys);
            if (!r.ok && r.unknown) {
              var host = document.getElementById("adapter-defaults-" + slug);
              if (host) host.innerHTML = '<div class="muted-note">Per-harness defaults need a newer agentproto daemon.</div>';
              return;
            }
            if (!r.ok) {
              var host2 = document.getElementById("adapter-defaults-" + slug);
              if (host2) host2.innerHTML = '<div class="muted-note">config_get: ' + escHtml(r.message) + '</div>';
              return;
            }
            renderAdapterDefaultsCard(slug);
          });
        }
        btn.textContent = harnessesState.expandedDefaults[slug] ? "hide defaults" : "spawn defaults";
        var host3 = document.getElementById("adapter-defaults-" + slug);
        if (host3 && !harnessesState.expandedDefaults[slug]) host3.innerHTML = "";
        else if (host3 && harnessesState.defaultsCache[slug]) renderAdapterDefaultsCard(slug);
      });
    })(toggles[i]);
  }
}

function renderAdapterDefaultsCard(slug) {
  var host = document.getElementById("adapter-defaults-" + slug);
  if (!host) return;
  var rows = harnessesState.defaultsCache[slug] || [];
  var rowsByPath = {};
  for (var i = 0; i < rows.length; i++) rowsByPath[rows[i].path] = rows[i];
  host.innerHTML = '<dl>' + rows.map(configFieldHtml).join("") + '</dl>';
  wireConfigRows(host, rowsByPath, function (path) {
    loadTool("config_get", { keys: adapterDefaultsPaths(slug) }).then(function (r) {
      if (!r.ok) { toast("config_get: " + r.message, true); return; }
      if (r.data.revision) configRevision = r.data.revision;
      harnessesState.defaultsCache[slug] = r.data.keys || [];
      notePendingRestart(r.data.keys);
      renderAdapterDefaultsCard(slug);
    });
  }, function () {
    loadHarnesses();
  });
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

var modelsState = { routes: [], runnableOnly: false, walletFilter: "", titlerRow: null };

function loadModels() {
  return Promise.all([
    loadTool("catalog_models", { full: true }),
    loadTool("auth_profile_list", { full: true }),
    loadTool("config_get", { keys: ["titler.model"] }),
  ]).then(function (results) {
    modelsState.routesResult = results[0];
    modelsState.profilesResult = results[1];
    modelsState.titlerResult = results[2];
    if (results[2].ok && results[2].data.revision) configRevision = results[2].data.revision;
    if (results[2].ok) notePendingRestart(results[2].data.keys);
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

  var html = '<div class="sect-h">Titler model</div><div id="titler-model-card"></div>';

  html += '<div class="sect-h">Catalog<label class="inline"><input type="checkbox" id="runnable-only"' + (modelsState.runnableOnly ? " checked" : "") + '> runnable only</label>'
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

  html += '<div class="sect-h">Wallet &times; model matrix</div>' + walletModelMatrixHtml(routes, profiles);

  el.innerHTML = html;
  wireGotoLinks(el);
  wireModelMatrix(el, routes, profiles);
  renderTitlerModelCard();

  var runnableEl = document.getElementById("runnable-only");
  if (runnableEl) runnableEl.addEventListener("change", function (e) { modelsState.runnableOnly = e.target.checked; renderModels(); });
  var walletEl = document.getElementById("wallet-filter");
  if (walletEl) walletEl.addEventListener("change", function (e) { modelsState.walletFilter = e.target.value; renderModels(); });
}

function walletModelMatrixHtml(routes, profiles) {
  if (profiles.length === 0) return '<div class="empty">No wallets configured.</div>';
  var eligibleRoutes = routes.filter(function (r) { return r.eligibleProfiles && r.eligibleProfiles.length > 0; }).slice(0, 40);
  if (eligibleRoutes.length === 0) return '<div class="empty">No wallet-reachable models yet.</div>';
  var html = '<div class="card"><div class="body" style="overflow-x:auto"><table><thead><tr><th>Wallet</th>';
  for (var c = 0; c < eligibleRoutes.length; c++) html += '<th title="' + escHtml(eligibleRoutes[c].route) + '">' + escHtml(eligibleRoutes[c].product) + '</th>';
  html += '</tr></thead><tbody>';
  for (var i = 0; i < profiles.length; i++) {
    var p = profiles[i];
    html += '<tr><td>' + escHtml(p.label || p.id) + '</td>';
    for (var j = 0; j < eligibleRoutes.length; j++) {
      var route = eligibleRoutes[j];
      var modelId = route.ref || (route.vendor + "/" + route.product);
      var reachable = route.eligibleProfiles.indexOf(p.id) !== -1;
      if (!reachable) {
        html += '<td class="matrix-cell disabled">&ndash;</td>';
        continue;
      }
      var mode = (p.models && p.models.mode) || "all";
      var checked = mode === "all" || (p.models.ids || []).indexOf(modelId) !== -1;
      html += '<td class="matrix-cell" data-matrix-profile="' + escHtml(p.id) + '" data-matrix-model="' + escHtml(modelId) + '" data-matrix-mode="' + escHtml(mode) + '">' + (checked ? "&#10003;" : "&#8211;") + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div></div><div class="muted-note">Click a checked cell in an "all eligible" wallet to start curating it; click a cell to toggle curation once curating.</div>';
  return html;
}

function wireModelMatrix(container, routes, profiles) {
  var cells = container.querySelectorAll("[data-matrix-profile]");
  for (var i = 0; i < cells.length; i++) {
    (function (cell) {
      cell.addEventListener("click", function () {
        var id = cell.getAttribute("data-matrix-profile");
        var modelId = cell.getAttribute("data-matrix-model");
        var p = null;
        for (var k = 0; k < profiles.length; k++) if (profiles[k].id === id) p = profiles[k];
        if (!p) return;
        var mode = (p.models && p.models.mode) || "all";
        var currentIds = (p.models && p.models.ids) || [];
        var nextIds;
        if (mode === "all") {
          // Start curating from just this one model.
          nextIds = [modelId];
        } else if (currentIds.indexOf(modelId) !== -1) {
          nextIds = currentIds.filter(function (x) { return x !== modelId; });
        } else {
          nextIds = currentIds.concat([modelId]);
        }
        loadTool("auth_profile_set_models", { id: id, mode: "allow", ids: nextIds }).then(function (r) {
          if (!r.ok) { toast(r.message, true); return; }
          for (var k2 = 0; k2 < profiles.length; k2++) if (profiles[k2].id === id) profiles[k2] = r.data.profile;
          if (modelsState.profilesResult && modelsState.profilesResult.ok) {
            for (var k3 = 0; k3 < modelsState.profilesResult.data.profiles.length; k3++) {
              if (modelsState.profilesResult.data.profiles[k3].id === id) modelsState.profilesResult.data.profiles[k3] = r.data.profile;
            }
          }
          renderModels();
        });
      });
    })(cells[i]);
  }
}

function renderTitlerModelCard() {
  var host = document.getElementById("titler-model-card");
  if (!host) return;
  var tr = modelsState.titlerResult;
  if (!tr.ok && tr.unknown) {
    host.innerHTML = '<div class="muted-note">Editing titler.model needs a newer agentproto daemon (config_get).</div>';
    return;
  }
  if (!tr.ok) {
    host.innerHTML = '<div class="muted-note">config_get: ' + escHtml(tr.message) + '</div>';
    return;
  }
  var rows = tr.data.keys || [];
  var rowsByPath = {};
  for (var i = 0; i < rows.length; i++) rowsByPath[rows[i].path] = rows[i];
  host.innerHTML = '<div class="card"><div class="body"><dl>' + rows.map(configFieldHtml).join("") + '</dl></div></div>';
  wireConfigRows(host, rowsByPath, function () {
    loadTool("config_get", { keys: ["titler.model"] }).then(function (r) {
      if (!r.ok) { toast("config_get: " + r.message, true); return; }
      if (r.data.revision) configRevision = r.data.revision;
      modelsState.titlerResult = r;
      notePendingRestart(r.data.keys);
      renderTitlerModelCard();
    });
  }, function () {
    loadModels();
  });
}

// ============================================================
// Defaults & messaging
// ============================================================

var DEFAULTS_GROUPS = [
  {
    id: "messaging", title: "Messaging and prompts",
    match: function (p) {
      return p.indexOf("defaults.messaging.") === 0 || p === "defaults.agentPromptInterrupt"
        || p === "defaults.backgroundTaskWake.enabled" || p === "defaults.backgroundTaskWake.graceMs";
    },
  },
  {
    id: "spawn", title: "Spawn",
    match: function (p) {
      return p.indexOf("spawn.") === 0 || p.indexOf("worktrees.") === 0 || p.indexOf("defaults.spawn.") === 0
        || p === "defaults.skills" || p === "defaults.options" || p === "defaults.defaultRoleDepthCutoff"
        || p === "defaults.maxGrantableDelegation" || p === "provenance.wrapGh" || p === "agentsMd.inlineMaxKb";
    },
  },
  { id: "context-continuity", title: "Context continuity", match: function (p) { return p === "defaults.contextContinuity"; } },
  {
    id: "observability", title: "Observability",
    match: function (p) {
      return p.indexOf("titler.") === 0 || p === "defaults.langfuseTracing" || p === "defaults.traceRedactor"
        || p === "sessions.attentionDelaySec" || p === "defaults.mcp.deferredTools";
    },
  },
  {
    id: "daemon", title: "Daemon",
    match: function (p) {
      return p.indexOf("daemon.") === 0 || p === "sessions.eventsDir" || p === "features.pty" || p === "features.llmEndpoint"
        || p === "profiles" || p === "activeProfile";
    },
  },
];

function classifyDefaultsGroup(path) {
  for (var i = 0; i < DEFAULTS_GROUPS.length; i++) if (DEFAULTS_GROUPS[i].match(path)) return DEFAULTS_GROUPS[i];
  return { id: "other", title: "Other" };
}

var defaultsState = { rowsByPath: {}, healthFallback: null };

function loadDefaults() {
  return Promise.all([
    loadTool("config_get", { section: "defaults" }),
    loadTool("config_get", { section: "daemon" }),
    loadTool("daemon_health", {}),
  ]).then(function (results) {
    renderDefaults(results[0], results[1], results[2]);
  });
}

function renderDefaults(defR, daemonR, healthR) {
  var el = document.getElementById("sec-defaults");

  if (!defR.ok && defR.unknown) {
    // Feature-detect fallback for a daemon that predates config_get: the
    // five effective knobs daemon_health already reports, read-only.
    var html = '<div class="notice">Full defaults editor needs a newer agentproto daemon (config_get). Showing the knobs daemon_health reports.</div>';
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
    el.innerHTML = html;
    return;
  }
  if (!defR.ok) {
    el.innerHTML = '<div class="empty">config_get: ' + escHtml(defR.message) + '</div>';
    return;
  }

  if (defR.data.revision) configRevision = defR.data.revision;
  var rows = (defR.data.keys || []).concat(daemonR.ok ? (daemonR.data.keys || []) : []);
  notePendingRestart(rows);
  defaultsState.rowsByPath = {};
  for (var i = 0; i < rows.length; i++) defaultsState.rowsByPath[rows[i].path] = rows[i];

  el.innerHTML = renderDefaultsGroupsHtml();
  wireConfigRows(el, defaultsState.rowsByPath, function (path) {
    refreshDefaultsGroupFor(path);
  }, function () {
    loadDefaults();
  });
}

function objectValues(obj) {
  var out = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out.push(obj[k]);
  return out;
}

function renderDefaultsGroupsHtml() {
  var byId = {};
  var order = [];
  var rows = objectValues(defaultsState.rowsByPath);
  for (var i = 0; i < rows.length; i++) {
    var g = classifyDefaultsGroup(rows[i].path);
    if (!byId[g.id]) { byId[g.id] = { id: g.id, title: g.title, rows: [] }; order.push(g.id); }
    byId[g.id].rows.push(rows[i]);
  }
  var html = "";
  for (var j = 0; j < order.length; j++) {
    var group = byId[order[j]];
    html += '<div class="sect-h">' + escHtml(group.title) + '</div>' + buildConfigCardHtml(group.id, group.title, group.rows);
  }
  return html;
}

function refreshDefaultsGroupFor(path) {
  var group = classifyDefaultsGroup(path);
  var groupPaths = [];
  for (var k in defaultsState.rowsByPath) {
    if (Object.prototype.hasOwnProperty.call(defaultsState.rowsByPath, k) && classifyDefaultsGroup(k).id === group.id) groupPaths.push(k);
  }
  loadTool("config_get", { keys: groupPaths }).then(function (r) {
    if (!r.ok) { toast("config_get: " + r.message, true); return; }
    if (r.data.revision) configRevision = r.data.revision;
    var newRows = r.data.keys || [];
    for (var i = 0; i < newRows.length; i++) defaultsState.rowsByPath[newRows[i].path] = newRows[i];
    notePendingRestart(newRows);
    var el = document.getElementById("sec-defaults");
    var cardEl = el.querySelector('[data-card-id="' + cssEscape(group.id) + '"]');
    if (!cardEl) return;
    cardEl.outerHTML = buildConfigCardHtml(group.id, group.title, newRows);
    var freshEl = el.querySelector('[data-card-id="' + cssEscape(group.id) + '"]');
    wireConfigRows(freshEl, defaultsState.rowsByPath, function (p2) { refreshDefaultsGroupFor(p2); }, function () { loadDefaults(); });
  });
}

// ============================================================
// Remote & pairing
// ============================================================

// Held ONLY in memory, never in section state that survives a re-render
// across sections, never in updateModelContext. Cleared on navigating away
// from #remote (route()) and on host teardown (see boot, below).
var remoteReveal = null;
var pairReveal = null;
var pairCountdownTimer = null;

function clearPairCountdown() {
  if (pairCountdownTimer) { clearInterval(pairCountdownTimer); pairCountdownTimer = null; }
}

function startPairCountdown(expiresAtIso) {
  clearPairCountdown();
  pairCountdownTimer = setInterval(function () {
    var el = document.getElementById("pair-offer-countdown");
    if (!el) { clearPairCountdown(); return; }
    var ms = new Date(expiresAtIso).getTime() - Date.now();
    if (ms <= 0) { el.textContent = "expired"; clearPairCountdown(); return; }
    el.textContent = Math.ceil(ms / 1000) + "s remaining";
  }, 1000);
}

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
      + '</dl>'
      + '<div class="wallet-card-actions">'
      + (rs.enabled
          ? '<button type="button" class="btn-sm danger" id="remote-disable-btn">disable</button>'
          : '<button type="button" class="btn-sm primary" id="remote-enable-btn">enable</button>')
      + '</div>';
    if (remoteReveal) {
      html += '<div class="reveal-box">'
        + '<div>Shown once. Store it now, it will not be shown again.</div>'
        + (remoteReveal.bearerToken ? '<div>Bearer token<code>' + escHtml(remoteReveal.bearerToken) + '</code><button type="button" class="btn-sm" data-copy="bearer">copy token</button></div>' : '')
        + (remoteReveal.phoneUrl ? '<div>Phone link<code>' + escHtml(remoteReveal.phoneUrl) + '</code><button type="button" class="btn-sm" data-copy="phoneUrl">copy link</button></div>' : '')
        + (remoteReveal.mcpConfigSnippet ? '<div>.mcp.json<code>' + escHtml(remoteReveal.mcpConfigSnippet) + '</code><button type="button" class="btn-sm" data-copy="snippet">copy snippet</button></div>' : '')
        + '</div>';
    }
    html += '</div></div>';
  } else {
    html += '<div class="muted-note">remote_status: ' + escHtml(remoteR.message) + '</div>';
  }

  html += '<div class="sect-h">Pairing<button type="button" class="btn-sm" id="pair-offer-btn">+ new pairing</button></div>';
  if (pairReveal) {
    html += '<div class="reveal-box">'
      + '<div>Offer URL. Shown once, expires <span id="pair-offer-countdown"></span>.</div>'
      + '<code>' + escHtml(pairReveal.url) + '</code>'
      + '<button type="button" class="btn-sm" data-copy="pairOffer">copy URL</button>'
      + '<div class="muted">fingerprint ' + escHtml(pairReveal.fingerprint) + '</div>'
      + '</div>';
  }
  if (pairR.ok) {
    var pairings = (pairR.data && pairR.data.pairings) || [];
    html += '<div class="card" data-card-id="pairing"><div class="body">';
    if (pairings.length === 0) {
      html += '<div class="empty">No paired clients.</div>';
    } else {
      html += '<table><thead><tr><th>Name</th><th>Fingerprint</th><th>Created</th><th>Last seen</th><th>Rendezvous</th><th></th></tr></thead><tbody>';
      for (var i = 0; i < pairings.length; i++) {
        var p = pairings[i];
        html += '<tr data-row-id="' + escHtml(p.fingerprint) + '"><td>' + escHtml(p.name) + '</td><td>' + escHtml(p.fingerprint) + '</td>'
          + '<td>' + escHtml(fmtRelative(p.createdAt)) + '</td><td>' + escHtml(fmtRelative(p.lastSeen)) + '</td><td>' + escHtml(p.rendezvous || "") + '</td>'
          + '<td><button type="button" class="btn-sm danger" data-pair-revoke="' + escHtml(p.fingerprint) + '">revoke</button></td></tr>';
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
  wireRemote(el);
  if (remoteReveal) {
    wireCopyButtons(el, { bearer: remoteReveal.bearerToken, phoneUrl: remoteReveal.phoneUrl, snippet: remoteReveal.mcpConfigSnippet });
  }
  if (pairReveal) {
    wireCopyButtons(el, { pairOffer: pairReveal.url });
    startPairCountdown(pairReveal.expiresAt);
  }
}

function wireRemote(container) {
  var enableBtn = container.querySelector("#remote-enable-btn");
  if (enableBtn) {
    enableBtn.addEventListener("click", function () {
      confirmClick("remote-enable", enableBtn, function () {
        loadTool("remote_enable", {}).then(function (r) {
          if (!r.ok) { toast(r.message, true); return; }
          remoteReveal = { bearerToken: r.data.bearerToken, phoneUrl: r.data.phoneUrl, mcpConfigSnippet: r.data.mcpConfigSnippet };
          toast("Remote enabled.", false);
          loadRemote();
        });
      });
    });
  }
  var disableBtn = container.querySelector("#remote-disable-btn");
  if (disableBtn) {
    disableBtn.addEventListener("click", function () {
      confirmClick("remote-disable", disableBtn, function () {
        loadTool("remote_disable", {}).then(function (r) {
          if (!r.ok) { toast(r.message, true); return; }
          remoteReveal = null;
          toast("Remote disabled.", false);
          loadRemote();
        });
      });
    });
  }
  var offerBtn = container.querySelector("#pair-offer-btn");
  if (offerBtn) {
    offerBtn.addEventListener("click", function () {
      loadTool("pair_offer", {}).then(function (r) {
        if (!r.ok) { toast(r.message, true); return; }
        pairReveal = { url: r.data.url, fingerprint: r.data.fingerprint, expiresAt: r.data.expiresAt };
        toast("Pairing offer created.", false);
        loadRemote();
      });
    });
  }
  var revokeBtns = container.querySelectorAll("[data-pair-revoke]");
  for (var i = 0; i < revokeBtns.length; i++) {
    (function (btn) {
      var fp = btn.getAttribute("data-pair-revoke");
      btn.addEventListener("click", function () {
        confirmClick("pair-revoke-" + fp, btn, function () {
          loadTool("pair_revoke", { target: fp }).then(function (r) {
            if (!r.ok) { toast(r.message, true); return; }
            toast("Pairing revoked.", false);
            pairReveal = null;
            loadRemote();
          });
        });
      });
    })(revokeBtns[i]);
  }
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
    updateModelContext = bridge.updateModelContext;
    if (bridge.onTeardown) {
      onTeardownFn = bridge.onTeardown;
      onTeardownFn(function () { clearRemoteSecrets(); });
    }
    renderNav();
    loadHealthChip();
    route(true);
  })
  .catch(function (err) {
    document.getElementById("body").innerHTML =
      '<div class="empty">Standalone mode: no host bridge (' + escHtml(err.message) + ')</div>';
  });
</script>
</body>
</html>`
