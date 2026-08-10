/**
 * Mail Triage — a self-contained MCP App dashboard for `mail-triage`.
 *
 * Talks to the daemon only through the `window.McpApp.connect()` bridge
 * (never a direct `fetch`): every action round-trips through the app's own
 * `app_tool_call` gateway tool, `{ appId, tool, args }`. Mailbox access goes
 * through an imported agentpush MCP server (`imported:<alias>/<tool>` ids);
 * running the triager agent itself goes through the daemon's own
 * `app_run` / `app_status` / `agent_output` — a second path alongside the
 * deterministic plan/apply tools, so the panel can either drive the mailbox
 * tools directly or hand the whole job to the agent and watch it work.
 *
 * The agentpush alias is NOT hardcoded to one server: `app_tool_call`
 * enforces an exact-match allowlist (`ui.tools`), so every candidate alias
 * must be baked into `MAIL_TRIAGE_TOOLS` at emit time. The candidate list
 * comes from `MAIL_TRIAGE_MCP_ALIASES` (overridable via the
 * `MAIL_TRIAGE_MCP_ALIASES` env var, comma-separated, read when this module
 * is evaluated — i.e. at emit). At runtime the panel probes each candidate's
 * `mailbox_list` and activates the first alias that answers with mailboxes;
 * a selector appears in the toolbar when several respond.
 */

const ALIAS_TOOL_NAMES = [
  "mailbox_list",
  "mailbox_search",
  "mailbox_triage_plan",
  "mailbox_triage_apply",
] as const

const DEFAULT_MCP_ALIASES = ["agentpush-prod", "agentpush"] as const

function envAliases(): string[] | null {
  if (typeof process === "undefined" || !process.env) return null
  const raw = process.env["MAIL_TRIAGE_MCP_ALIASES"]
  if (!raw) return null
  const list = raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  return list.length > 0 ? list : null
}

/** Candidate imported-MCP aliases the dashboard may reach mailboxes through. */
export const MAIL_TRIAGE_MCP_ALIASES: readonly string[] = envAliases() ?? [...DEFAULT_MCP_ALIASES]

export const MAIL_TRIAGE_TOOLS: readonly string[] = [
  ...MAIL_TRIAGE_MCP_ALIASES.flatMap(alias => ALIAS_TOOL_NAMES.map(t => `imported:${alias}/${t}`)),
  "app_run",
  "app_status",
  "agent_output",
  "app_list",
]

const APP_ID = "@agentproto/mail-triage"
const AGENT_ID = "@agentproto/triager"
const CATEGORIES = ["urgent", "needs-reply", "newsletter", "notification"]

export const MAIL_TRIAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mail Triage</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#e6edf3;--text2:#8b949e;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;background:var(--bg);color:var(--text)}
#app{display:flex;flex-direction:column;height:100%;overflow-y:auto}
#toolbar{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;background:var(--bg2);flex-shrink:0;flex-wrap:wrap}
#toolbar .title{font-size:13px;font-weight:600;flex:1}
select,input[type=text]{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px;font-family:inherit}
.abtn{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}
.abtn:hover{background:var(--border)}
.abtn:disabled{opacity:.4;cursor:default}
.abtn.primary{background:var(--blue);border-color:var(--blue);color:#04101c}
.abtn.primary:hover{opacity:.9}
#caps{padding:6px 14px;display:flex;gap:6px;align-items:center;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);color:var(--text2)}
.badge.on{color:var(--green);border-color:var(--green)}
.badge.off{opacity:.5;text-decoration:line-through}
#content{padding:14px;display:flex;flex-direction:column;gap:16px}
section{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:12px}
section h3{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
#summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.tile{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px;text-align:center}
.tile .count{font-size:22px;font-weight:700}
.tile .label{font-size:11px;color:var(--text2);text-transform:capitalize}
.tile.unread .count{color:var(--green)}
.tile.urgent .count{color:var(--red)}
.tile.needs-reply .count{color:var(--yellow)}
.tile.newsletter .count{color:var(--blue)}
.tile.notification .count{color:var(--purple)}
#plan-list,#search-results,#log-events,#runs-list,#connect-hint-list{max-height:260px;overflow-y:auto;font-size:12px}
.plan-item{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)}
.plan-item .subj{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.plan-item .tag{color:var(--text2);font-size:11px;white-space:nowrap}
.runs-item{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer}
.runs-item:hover{background:var(--bg3)}
.runs-item .rid{font-family:Menlo,Monaco,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.runs-item .st{font-size:11px;white-space:nowrap}
.runs-item .st.running{color:var(--yellow)}
.runs-item .st.ended{color:var(--green)}
.runs-item .meta{color:var(--text2);font-size:11px;white-space:nowrap}
#log-tail{font-family:Menlo,Monaco,monospace;white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px;max-height:260px;overflow-y:auto}
.searchbar{display:flex;gap:8px;margin-bottom:8px}
.searchbar input{flex:1}
.actions{display:flex;gap:8px;margin-top:10px}
#status{padding:6px 14px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
.empty{color:var(--text2);padding:8px 0}
.mini{font-size:10px;text-transform:none;letter-spacing:0;cursor:pointer;color:var(--blue);background:none;border:none;font-family:inherit}
.caps-hint{font-size:11px;color:var(--yellow)}
.snippet{color:var(--text2);font-size:11px;margin-top:2px}
</style>
</head>
<body>
<div id="app">
  <div id="toolbar">
    <span class="title">Mail Triage</span>
    <select id="alias-select" style="display:none" title="MCP server"></select>
    <select id="mailbox-select"></select>
    <button class="abtn" id="refresh-btn">Refresh</button>
  </div>
  <div id="caps" style="display:none"></div>
  <div id="content">
    <section id="connect-hint" style="display:none">
      <h3>Connect a mailbox</h3>
      <div id="connect-hint-list"></div>
      <div class="empty">Import/start an agentpush MCP server and connect a Gmail account in agentpush, then retry.</div>
      <div class="actions">
        <button class="abtn primary" id="connect-retry-btn">Retry</button>
      </div>
    </section>

    <section>
      <h3>Inbox summary</h3>
      <div id="summary"></div>
    </section>

    <section>
      <h3>Search</h3>
      <div class="searchbar">
        <input type="text" id="search-input" placeholder="e.g. is:unread">
        <button class="abtn" id="search-btn">Search</button>
      </div>
      <div id="search-results"><div class="empty">No search run yet.</div></div>
    </section>

    <section>
      <h3>Triage plan</h3>
      <div class="searchbar">
        <input type="text" id="plan-query" placeholder="criteria query" value="is:unread category:promotions older_than:7d">
        <select id="plan-action">
          <option value="markRead">mark read</option>
          <option value="archive">archive</option>
          <option value="label">label&#8230;</option>
          <option value="trash">trash</option>
        </select>
        <input type="text" id="plan-label" placeholder="label name" style="display:none">
      </div>
      <div class="actions">
        <button class="abtn primary" id="triage-btn">Build plan</button>
        <button class="abtn" id="apply-btn" disabled>Apply</button>
      </div>
      <div id="plan-list" style="margin-top:10px"><div class="empty">No plan yet — click Build plan.</div></div>
    </section>

    <section>
      <h3>Triager agent</h3>
      <div class="actions">
        <button class="abtn" id="run-agent-btn">Run Triager Agent</button>
      </div>
      <div id="log-events" style="margin-top:10px"><div class="empty">Agent has not run yet.</div></div>
      <div id="log-tail" style="margin-top:6px"></div>
    </section>

    <section>
      <h3><span>Past runs</span><button class="mini" id="runs-refresh-btn">refresh</button></h3>
      <div id="runs-list"><div class="empty">No runs yet.</div></div>
    </section>
  </div>
  <div id="status">Connecting&#8230;</div>
</div>
<script>
var APP_ID = ${JSON.stringify(APP_ID)};
var AGENT_ID = ${JSON.stringify(AGENT_ID)};
var CATEGORIES = ${JSON.stringify(CATEGORIES)};
var ALIASES = ${JSON.stringify(MAIL_TRIAGE_MCP_ALIASES)};
var POLL_TIMEOUT_MS = 10 * 60 * 1000;
var callTool = null;
var currentPlan = null;
var pollHandle = null;
var planExpiryHandle = null;
var activeAlias = ALIASES[0];
var currentMailboxes = [];
var categoryCounts = null;
var unreadCount = null;
var aliasStates = {};

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

// See media-viewer/ui.ts for why this loop exists: app_tool_call wraps its
// dispatch result in at least one more {content:[{type:"text",text:...}]}
// shell than the underlying tool returned.
function unwrapText(result) {
  var cur = result;
  for (var i = 0; i < 4; i++) {
    if (typeof cur === "string") {
      try {
        cur = JSON.parse(cur);
        continue;
      } catch (e) {
        return cur;
      }
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
  if (!callTool) {
    return Promise.reject(new Error("Not connected to host bridge (standalone mode)."));
  }
  return callTool("app_tool_call", { appId: APP_ID, tool: tool, args: args || {} }).then(function (result) {
    var value = unwrapText(result);
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.error === "string") {
      throw new Error(value.error);
    }
    return value;
  });
}

function aliasTool(name) {
  return "imported:" + activeAlias + "/" + name;
}

// Disables a button and swaps its label to an ellipsis while a call is in
// flight, so double-submit is impossible; restores the original label after.
function setBusy(btn, busy) {
  if (busy) {
    if (btn.getAttribute("data-label") === null) btn.setAttribute("data-label", btn.textContent);
    btn.disabled = true;
    btn.textContent = "\\u2026";
  } else {
    btn.disabled = false;
    var label = btn.getAttribute("data-label");
    if (label !== null) btn.textContent = label;
  }
}

function clearPlanExpiry() {
  if (planExpiryHandle) {
    clearTimeout(planExpiryHandle);
    planExpiryHandle = null;
  }
}

function onPlanExpired() {
  planExpiryHandle = null;
  currentPlan = null;
  document.getElementById("apply-btn").disabled = true;
  setStatus("Plan expired \\u2014 rebuild it.");
}

// Arms a timeout that invalidates the plan at its server-declared expires_at
// (plans expire after 15 minutes) so Apply never fires against a stale plan.
function armPlanExpiry(expiresAt) {
  clearPlanExpiry();
  if (!expiresAt) return;
  var ms = new Date(expiresAt).getTime() - Date.now();
  if (isNaN(ms)) return;
  if (ms <= 0) {
    onPlanExpired();
    return;
  }
  planExpiryHandle = setTimeout(onPlanExpired, ms);
}

function asList(value, keys) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(value[keys[i]])) return value[keys[i]];
    }
  }
  return [];
}

function renderSummary() {
  var el = document.getElementById("summary");
  el.innerHTML = "";
  var tiles = [{ key: "unread", count: unreadCount }].concat(
    CATEGORIES.map(function (cat) {
      return { key: cat, count: categoryCounts ? categoryCounts[cat] : undefined };
    })
  );
  tiles.forEach(function (t) {
    var tile = document.createElement("div");
    tile.className = "tile " + t.key;
    tile.innerHTML = '<div class="count"></div><div class="label"></div>';
    tile.querySelector(".count").textContent = t.count === undefined || t.count === null ? "\\u2013" : String(t.count);
    tile.querySelector(".label").textContent = t.key.replace("-", " ");
    el.appendChild(tile);
  });
}

function mailboxId(mb) {
  if (typeof mb === "string") return mb;
  return mb.id || mb.name || JSON.stringify(mb);
}

function mailboxText(mb) {
  if (typeof mb === "string") return mb;
  var name = mb.address || mb.label || mb.name || mb.id || JSON.stringify(mb);
  var caps = mb.capabilities;
  if (caps && typeof caps === "object") {
    return name + (caps.triage ? " \\u2014 triage \\u2713" : " \\u2014 read-only");
  }
  return name;
}

function selectedMailbox() {
  var id = document.getElementById("mailbox-select").value;
  for (var i = 0; i < currentMailboxes.length; i++) {
    if (mailboxId(currentMailboxes[i]) === id) return currentMailboxes[i];
  }
  return null;
}

function renderCaps(mb) {
  var el = document.getElementById("caps");
  var caps = mb && typeof mb === "object" ? mb.capabilities : null;
  if (!caps || typeof caps !== "object") {
    el.style.display = "none";
    return;
  }
  el.style.display = "flex";
  el.innerHTML = "";
  ["read", "send", "triage", "compose"].forEach(function (cap) {
    var b = document.createElement("span");
    b.className = "badge " + (caps[cap] ? "on" : "off");
    b.textContent = cap;
    el.appendChild(b);
  });
  if (!caps.triage) {
    var hint = document.createElement("span");
    hint.className = "caps-hint";
    hint.textContent = "triage scope missing \\u2014 grant it via agentpush (mailbox_request_elevation)";
    el.appendChild(hint);
  }
}

// Gmail category labels -> the dashboard's triage buckets. IMPORTANT wins,
// so an important promo counts as urgent, not newsletter.
function categoryOf(labelIds) {
  var l = labelIds || [];
  if (l.indexOf("IMPORTANT") !== -1) return "urgent";
  if (l.indexOf("CATEGORY_PROMOTIONS") !== -1) return "newsletter";
  if (l.indexOf("CATEGORY_UPDATES") !== -1 || l.indexOf("CATEGORY_SOCIAL") !== -1 || l.indexOf("CATEGORY_FORUMS") !== -1) return "notification";
  return "needs-reply";
}

function onMailboxChange() {
  clearPlanExpiry();
  var mb = selectedMailbox();
  renderCaps(mb);
  var caps = mb && typeof mb === "object" ? mb.capabilities : null;
  var noTriage = !!(caps && typeof caps === "object" && !caps.triage);
  var scopeHint = noTriage ? "Mailbox lacks triage capability \\u2014 grant it via agentpush (mailbox_request_elevation)" : "";
  document.getElementById("triage-btn").disabled = noTriage;
  document.getElementById("triage-btn").title = scopeHint;
  document.getElementById("apply-btn").disabled = true;
  document.getElementById("apply-btn").title = scopeHint;
  currentPlan = null;
  categoryCounts = null;
  unreadCount = null;
  renderSummary();
  if (!mb) return;
  callApp(aliasTool("mailbox_search"), { mailbox: mailboxId(mb), query: "is:unread", limit: 50 })
    .then(function (result) {
      var items = asList(result, ["items", "messages", "results"]);
      if (result && typeof result === "object" && typeof result.resultSizeEstimate === "number") {
        unreadCount = result.resultSizeEstimate;
      } else {
        unreadCount = items.length;
      }
      // Category breakdown over the newest page of unread — a sample when
      // the mailbox has more unread than one page.
      var counts = {};
      items.forEach(function (item) {
        var cat = categoryOf(item && item.labelIds);
        counts[cat] = (counts[cat] || 0) + 1;
      });
      categoryCounts = items.length > 0 ? counts : null;
      renderSummary();
    })
    .catch(function () { /* KPI is best-effort — leave the dash */ });
}

function renderMailboxes(mailboxes) {
  currentMailboxes = mailboxes;
  var select = document.getElementById("mailbox-select");
  select.innerHTML = "";
  if (mailboxes.length === 0) {
    var opt = document.createElement("option");
    opt.textContent = "no mailboxes";
    opt.value = "";
    select.appendChild(opt);
    renderCaps(null);
    return;
  }
  mailboxes.forEach(function (mb) {
    var opt = document.createElement("option");
    opt.value = mailboxId(mb);
    opt.textContent = mailboxText(mb);
    select.appendChild(opt);
  });
  onMailboxChange();
}

function renderAliasSelect(liveAliases) {
  var select = document.getElementById("alias-select");
  select.innerHTML = "";
  var shown = liveAliases.length > 0 ? liveAliases : ALIASES;
  shown.forEach(function (alias) {
    var opt = document.createElement("option");
    opt.value = alias;
    opt.textContent = alias;
    select.appendChild(opt);
  });
  select.value = activeAlias;
  select.style.display = shown.length > 1 ? "" : "none";
}

function loadMailboxes() {
  setStatus("Loading mailboxes from " + activeAlias + "\\u2026");
  return callApp(aliasTool("mailbox_list"), {})
    .then(function (result) {
      renderMailboxes(asList(result, ["mailboxes", "items"]));
      setStatus("Ready \\u2014 " + activeAlias);
    })
    .catch(function (err) {
      setStatus("Error loading mailboxes: " + err.message);
    });
}

function renderConnectHint() {
  var el = document.getElementById("connect-hint");
  var anyLive = false;
  for (var i = 0; i < ALIASES.length; i++) {
    if (aliasStates[ALIASES[i]] && aliasStates[ALIASES[i]].state === "live") anyLive = true;
  }
  if (anyLive) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  var list = document.getElementById("connect-hint-list");
  list.innerHTML = "";
  ALIASES.forEach(function (alias) {
    var st = aliasStates[alias];
    var row = document.createElement("div");
    row.className = "plan-item";
    var text;
    if (!st) text = alias + " \\u2014 not probed yet";
    else if (st.state === "unreachable") text = alias + " \\u2014 unreachable: " + st.message;
    else if (st.state === "empty") text = alias + " \\u2014 connected, no mailboxes";
    else text = alias + " \\u2014 live";
    row.textContent = text;
    list.appendChild(row);
  });
}

function probeAliases() {
  setStatus("Detecting mail servers\\u2026");
  return Promise.all(
    ALIASES.map(function (alias) {
      return callApp("imported:" + alias + "/mailbox_list", {})
        .then(function (result) {
          var mailboxes = asList(result, ["mailboxes", "items"]);
          aliasStates[alias] = { state: mailboxes.length > 0 ? "live" : "empty" };
          return { alias: alias, mailboxes: mailboxes };
        })
        .catch(function (err) {
          aliasStates[alias] = { state: "unreachable", message: err && err.message ? err.message : String(err) };
          return { alias: alias, mailboxes: [] };
        });
    })
  ).then(function (results) {
    var live = results.filter(function (r) { return r.mailboxes.length > 0; });
    if (live.length > 0) {
      activeAlias = live[0].alias;
      renderAliasSelect(live.map(function (r) { return r.alias; }));
      renderMailboxes(live[0].mailboxes);
      renderConnectHint();
      setStatus("Ready \\u2014 " + activeAlias + (live.length > 1 ? " (" + live.length + " servers available)" : ""));
    } else {
      renderAliasSelect([]);
      renderMailboxes([]);
      renderConnectHint();
      setStatus("No mailboxes reachable \\u2014 see connection panel below.");
    }
  });
}

function renderSearchResults(items, raw) {
  var el = document.getElementById("search-results");
  el.innerHTML = "";
  if (raw && typeof raw === "object" && typeof raw.resultSizeEstimate === "number") {
    var count = document.createElement("div");
    count.className = "empty";
    count.textContent = items.length + " shown \\u00b7 ~" + raw.resultSizeEstimate + " total";
    el.appendChild(count);
  }
  if (items.length === 0) {
    var none = document.createElement("div");
    none.className = "empty";
    none.textContent = "No results.";
    el.appendChild(none);
    return;
  }
  items.forEach(function (item) {
    var row = document.createElement("div");
    row.className = "plan-item";
    row.style.flexDirection = "column";
    row.style.alignItems = "stretch";
    var subj = typeof item === "string" ? item : item.subject || item.title || JSON.stringify(item);
    var from = item && item.from ? item.from : "";
    var snippet = item && item.snippet ? item.snippet : "";
    var top = document.createElement("div");
    top.style.display = "flex";
    top.style.justifyContent = "space-between";
    top.style.gap = "10px";
    top.innerHTML = '<span class="subj"></span><span class="tag"></span>';
    top.querySelector(".subj").textContent = subj;
    top.querySelector(".tag").textContent = from;
    row.appendChild(top);
    if (snippet) {
      var sn = document.createElement("div");
      sn.className = "snippet";
      sn.textContent = snippet;
      row.appendChild(sn);
    }
    el.appendChild(row);
  });
}

// Renders a mailbox_triage_plan result: { plan_id, action, count, sample,
// truncated, expires_at }. The sample rows are search-shaped messages.
function renderPlan(plan) {
  var el = document.getElementById("plan-list");
  el.innerHTML = "";
  if (!plan || typeof plan !== "object" || !plan.plan_id) {
    el.innerHTML = '<div class="empty">Plan failed \\u2014 unexpected response.</div>';
    return;
  }
  var head = document.createElement("div");
  head.className = "plan-item";
  head.innerHTML = '<span class="subj"></span><span class="tag"></span>';
  head.querySelector(".subj").textContent =
    plan.count + " message" + (plan.count === 1 ? "" : "s") + " \\u2192 " + (plan.action && plan.action.type);
  head.querySelector(".tag").textContent = plan.expires_at ? "expires " + fmtDate(plan.expires_at) : "";
  el.appendChild(head);
  var sample = asList(plan, ["sample"]);
  sample.forEach(function (item) {
    var row = document.createElement("div");
    row.className = "plan-item";
    row.innerHTML = '<span class="subj"></span><span class="tag"></span>';
    row.querySelector(".subj").textContent = (item && (item.subject || item.title)) || JSON.stringify(item);
    row.querySelector(".tag").textContent = (item && item.from) || "";
    el.appendChild(row);
  });
  if (plan.truncated) {
    var more = document.createElement("div");
    more.className = "empty";
    more.textContent = "\\u2026sample truncated \\u2014 " + plan.count + " total.";
    el.appendChild(more);
  }
}

function fmtDate(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function renderRuns(runs) {
  var el = document.getElementById("runs-list");
  el.innerHTML = "";
  if (runs.length === 0) {
    el.innerHTML = '<div class="empty">No runs yet.</div>';
    return;
  }
  var shown = runs.slice(0, 20);
  shown.forEach(function (run) {
    var row = document.createElement("div");
    row.className = "runs-item";
    row.title = "Show sessions + output for " + run.appRunId;
    row.innerHTML = '<span class="st"></span><span class="rid"></span><span class="meta"></span>';
    var st = row.querySelector(".st");
    st.textContent = run.status || "?";
    st.className = "st " + (run.status || "");
    row.querySelector(".rid").textContent = run.appRunId;
    row.querySelector(".meta").textContent =
      fmtDate(run.startedAt) + (run.endedAt ? " \\u2192 " + fmtDate(run.endedAt) : "") + " \\u00b7 " + (run.sessions || 0) + " session" + (run.sessions === 1 ? "" : "s");
    row.addEventListener("click", function () { viewRun(run.appRunId); });
    el.appendChild(row);
  });
  if (runs.length > 20) {
    var more = document.createElement("div");
    more.className = "empty";
    more.textContent = "showing 20 of " + runs.length;
    el.appendChild(more);
  }
}

function loadRuns() {
  return callApp("app_list", {})
    .then(function (result) {
      var apps = Array.isArray(result) ? result : [];
      var mine = null;
      for (var i = 0; i < apps.length; i++) {
        if (apps[i] && apps[i].appId === APP_ID) { mine = apps[i]; break; }
      }
      var runs = (mine && Array.isArray(mine.runs) ? mine.runs.slice() : []).sort(function (a, b) {
        return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
      });
      renderRuns(runs);
    })
    .catch(function (err) {
      setStatus("Could not load runs: " + err.message);
    });
}

function viewRun(appRunId) {
  setStatus("Loading run " + appRunId + "\\u2026");
  callApp("app_status", { appRunId: appRunId })
    .then(function (status) {
      var sessions = (status && status.sessions) || [];
      appendLog("\\u2500\\u2500 run " + appRunId + " (" + (status && status.status) + ") \\u2500\\u2500");
      if (sessions.length === 0) {
        appendLog("(no sessions)");
        setStatus("Ready \\u2014 " + activeAlias);
        return;
      }
      sessions.forEach(function (s) {
        appendLog("session " + s.sessionId + " (" + (s.agentId || "?") + ")");
      });
      return callApp("agent_output", { sessionId: sessions[0].sessionId, lastN: 200, clean: true })
        .then(function (output) {
          if (output) appendLog(typeof output === "string" ? output : JSON.stringify(output, null, 2));
          setStatus("Ready \\u2014 " + activeAlias);
        });
    })
    .catch(function (err) {
      setStatus("Run status failed: " + err.message);
    });
}

document.getElementById("refresh-btn").addEventListener("click", function () {
  probeAliases();
  loadRuns();
});

document.getElementById("connect-retry-btn").addEventListener("click", function () {
  probeAliases();
  loadRuns();
});

document.getElementById("alias-select").addEventListener("change", function () {
  activeAlias = this.value;
  clearPlanExpiry();
  currentPlan = null;
  document.getElementById("apply-btn").disabled = true;
  loadMailboxes();
});

document.getElementById("mailbox-select").addEventListener("change", onMailboxChange);

document.getElementById("runs-refresh-btn").addEventListener("click", loadRuns);

document.getElementById("search-btn").addEventListener("click", function () {
  var btn = this;
  var query = document.getElementById("search-input").value.trim() || "is:unread";
  var mailbox = document.getElementById("mailbox-select").value;
  setBusy(btn, true);
  setStatus("Searching\\u2026");
  callApp(aliasTool("mailbox_search"), { mailbox: mailbox, query: query })
    .then(function (result) {
      renderSearchResults(asList(result, ["items", "messages", "results"]), result);
      setBusy(btn, false);
      setStatus("Ready \\u2014 " + activeAlias);
    })
    .catch(function (err) {
      setBusy(btn, false);
      setStatus("Search failed: " + err.message);
    });
});

document.getElementById("plan-action").addEventListener("change", function () {
  document.getElementById("plan-label").style.display = this.value === "label" ? "" : "none";
});

document.getElementById("triage-btn").addEventListener("click", function () {
  var btn = this;
  var mailbox = document.getElementById("mailbox-select").value;
  var query = document.getElementById("plan-query").value.trim() || "is:unread";
  var actionType = document.getElementById("plan-action").value;
  var action = { type: actionType };
  if (actionType === "label") {
    var label = document.getElementById("plan-label").value.trim();
    if (!label) {
      setStatus("Enter a label name for the label action.");
      return;
    }
    action.addLabelIds = [label];
  }
  setBusy(btn, true);
  setStatus("Building triage plan\\u2026");
  document.getElementById("apply-btn").disabled = true;
  clearPlanExpiry();
  currentPlan = null;
  callApp(aliasTool("mailbox_triage_plan"), { mailbox: mailbox, criteria: { query: query }, action: action })
    .then(function (plan) {
      setBusy(btn, false);
      currentPlan = plan && plan.plan_id ? plan : null;
      renderPlan(plan);
      if (currentPlan && plan.count > 0) {
        document.getElementById("apply-btn").disabled = false;
        armPlanExpiry(plan.expires_at);
        setStatus("Plan ready (" + plan.count + " messages) \\u2014 review, then Apply.");
      } else if (currentPlan) {
        setStatus("Plan matches no messages \\u2014 nothing to apply.");
      } else {
        setStatus("Triage plan failed \\u2014 see plan panel.");
      }
    })
    .catch(function (err) {
      setBusy(btn, false);
      var msg = err && err.message ? err.message : String(err);
      if (msg.indexOf("mailbox_scope_missing") !== -1) {
        setStatus("Triage scope missing \\u2014 grant it via agentpush (mailbox_request_elevation).");
      } else {
        setStatus("Triage plan failed: " + msg);
      }
    });
});

document.getElementById("apply-btn").addEventListener("click", function () {
  var btn = this;
  if (!currentPlan || !currentPlan.plan_id) return;
  setBusy(btn, true);
  setStatus("Applying triage plan\\u2026");
  callApp(aliasTool("mailbox_triage_apply"), { plan_id: currentPlan.plan_id, confirm: true })
    .then(function (result) {
      setBusy(btn, false);
      var count = currentPlan.count;
      var extra = [];
      if (result && typeof result === "object") {
        ["applied", "modified", "count"].forEach(function (key) {
          if (typeof result[key] === "number") extra.push(key + ": " + result[key]);
        });
      }
      setStatus(
        extra.length > 0
          ? "Plan applied \\u2014 " + extra.join(", ") + "."
          : "Plan applied (" + count + " message" + (count === 1 ? "" : "s") + ")."
      );
      document.getElementById("apply-btn").disabled = true;
      clearPlanExpiry();
      currentPlan = null;
      onMailboxChange();
    })
    .catch(function (err) {
      setBusy(btn, false);
      setStatus("Apply failed: " + err.message);
    });
});

function appendLog(text) {
  var el = document.getElementById("log-events");
  if (el.querySelector(".empty")) el.innerHTML = "";
  var line = document.createElement("div");
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// Replaces the whole tail on every poll tick (the daemon returns the last
// N lines, not a delta) — appending it instead would duplicate the log.
function renderLogTail(text) {
  var el = document.getElementById("log-tail");
  el.textContent = text || "";
  el.scrollTop = el.scrollHeight;
}

function pollAgentRun(appRunId, startedAt) {
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
  }
  if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
    setStatus("Still running \\u2014 check Past runs later.");
    return;
  }
  callApp("app_status", { appRunId: appRunId })
    .then(function (status) {
      var sessions = (status && status.sessions) || [];
      var sessionId = sessions[0] && sessions[0].sessionId;
      var tail = sessionId
        ? callApp("agent_output", { sessionId: sessionId, lastN: 200, clean: true })
        : Promise.resolve("");
      return tail.then(function (output) {
        renderLogTail(typeof output === "string" ? output : output ? JSON.stringify(output, null, 2) : "");
        var done = status && (status.status === "ended" || status.status === "done" || status.endedAt);
        if (!done) {
          pollHandle = setTimeout(function () { pollAgentRun(appRunId, startedAt); }, 2000);
        } else {
          pollHandle = null;
          setStatus("Agent run finished.");
          loadRuns();
        }
      });
    })
    .catch(function (err) {
      setStatus("Agent status failed: " + err.message);
    });
}

document.getElementById("run-agent-btn").addEventListener("click", function () {
  var btn = this;
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
  }
  document.getElementById("log-events").innerHTML = "";
  document.getElementById("log-tail").textContent = "";
  setBusy(btn, true);
  setStatus("Starting triager agent\\u2026");
  callApp("app_run", { appId: APP_ID, agents: [AGENT_ID], prompt: "Triage my inbox." })
    .then(function (run) {
      setBusy(btn, false);
      var sessions = (run && run.sessions) || [];
      var errors = (run && run.errors) || [];
      if (sessions.length === 0 && errors.length > 0) {
        appendLog(
          "Run failed to start: " +
            errors.map(function (e) { return (e.agentId || "?") + ": " + e.error; }).join("; ")
        );
        setStatus("Run failed to start.");
        return;
      }
      appendLog("Started app run " + (run && run.appRunId));
      loadRuns();
      pollAgentRun(run.appRunId, Date.now());
    })
    .catch(function (err) {
      setBusy(btn, false);
      setStatus("Run failed: " + err.message);
    });
});

window.McpApp.connect()
  .then(function (bridge) {
    callTool = bridge.callTool;
    return Promise.all([probeAliases(), loadRuns()]);
  })
  .catch(function (err) {
    setStatus("Standalone mode \\u2014 no host bridge (" + err.message + ")");
    renderSummary();
  });

renderSummary();
</script>
</body>
</html>`
