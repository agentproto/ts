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
#plan-list,#search-results,#log,#runs-list{max-height:260px;overflow-y:auto;font-size:12px}
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
#log{font-family:Menlo,Monaco,monospace;white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px}
.searchbar{display:flex;gap:8px;margin-bottom:8px}
.searchbar input{flex:1}
.actions{display:flex;gap:8px;margin-top:10px}
#status{padding:6px 14px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
.empty{color:var(--text2);padding:8px 0}
.mini{font-size:10px;text-transform:none;letter-spacing:0;cursor:pointer;color:var(--blue);background:none;border:none;font-family:inherit}
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
      <div id="log" style="margin-top:10px"><div class="empty">Agent has not run yet.</div></div>
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
var callTool = null;
var currentPlan = null;
var pollHandle = null;
var activeAlias = ALIASES[0];
var currentMailboxes = [];
var categoryCounts = null;
var unreadCount = null;

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
  return callTool("app_tool_call", { appId: APP_ID, tool: tool, args: args || {} }).then(unwrapText);
}

function aliasTool(name) {
  return "imported:" + activeAlias + "/" + name;
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
  var mb = selectedMailbox();
  renderCaps(mb);
  var caps = mb && typeof mb === "object" ? mb.capabilities : null;
  var noTriage = !!(caps && typeof caps === "object" && !caps.triage);
  document.getElementById("triage-btn").disabled = noTriage;
  document.getElementById("apply-btn").disabled = true;
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

function probeAliases() {
  setStatus("Detecting mail servers\\u2026");
  return Promise.all(
    ALIASES.map(function (alias) {
      return callApp("imported:" + alias + "/mailbox_list", {})
        .then(function (result) {
          return { alias: alias, mailboxes: asList(result, ["mailboxes", "items"]) };
        })
        .catch(function () {
          return { alias: alias, mailboxes: [] };
        });
    })
  ).then(function (results) {
    var live = results.filter(function (r) { return r.mailboxes.length > 0; });
    if (live.length > 0) {
      activeAlias = live[0].alias;
      renderAliasSelect(live.map(function (r) { return r.alias; }));
      renderMailboxes(live[0].mailboxes);
      setStatus("Ready \\u2014 " + activeAlias + (live.length > 1 ? " (" + live.length + " servers available)" : ""));
    } else {
      renderAliasSelect([]);
      renderMailboxes([]);
      setStatus("No mailboxes on any server (" + ALIASES.join(", ") + ").");
    }
  });
}

function renderSearchResults(items) {
  var el = document.getElementById("search-results");
  el.innerHTML = "";
  if (items.length === 0) {
    el.innerHTML = '<div class="empty">No results.</div>';
    return;
  }
  items.forEach(function (item) {
    var row = document.createElement("div");
    row.className = "plan-item";
    var subj = typeof item === "string" ? item : item.subject || item.title || JSON.stringify(item);
    var from = item && item.from ? item.from : "";
    row.innerHTML = '<span class="subj"></span><span class="tag"></span>';
    row.querySelector(".subj").textContent = subj;
    row.querySelector(".tag").textContent = from;
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
  runs.forEach(function (run) {
    var row = document.createElement("div");
    row.className = "runs-item";
    row.title = "Show sessions + output for " + run.appRunId;
    row.innerHTML = '<span class="st"></span><span class="rid"></span><span class="meta"></span>';
    var st = row.querySelector(".st");
    st.textContent = run.status || "?";
    st.className = "st " + (run.status || "");
    row.querySelector(".rid").textContent = run.appRunId;
    row.querySelector(".meta").textContent =
      fmtDate(run.startedAt) + " \\u00b7 " + (run.sessions || 0) + " session" + (run.sessions === 1 ? "" : "s");
    row.addEventListener("click", function () { viewRun(run.appRunId); });
    el.appendChild(row);
  });
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
  loadMailboxes();
  loadRuns();
});

document.getElementById("alias-select").addEventListener("change", function () {
  activeAlias = this.value;
  loadMailboxes();
});

document.getElementById("mailbox-select").addEventListener("change", onMailboxChange);

document.getElementById("runs-refresh-btn").addEventListener("click", loadRuns);

document.getElementById("search-btn").addEventListener("click", function () {
  var query = document.getElementById("search-input").value;
  var mailbox = document.getElementById("mailbox-select").value;
  setStatus("Searching\\u2026");
  callApp(aliasTool("mailbox_search"), { mailbox: mailbox, query: query })
    .then(function (result) {
      renderSearchResults(asList(result, ["items", "messages", "results"]));
      setStatus("Ready \\u2014 " + activeAlias);
    })
    .catch(function (err) {
      setStatus("Search failed: " + err.message);
    });
});

document.getElementById("plan-action").addEventListener("change", function () {
  document.getElementById("plan-label").style.display = this.value === "label" ? "" : "none";
});

document.getElementById("triage-btn").addEventListener("click", function () {
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
  setStatus("Building triage plan\\u2026");
  document.getElementById("apply-btn").disabled = true;
  currentPlan = null;
  callApp(aliasTool("mailbox_triage_plan"), { mailbox: mailbox, criteria: { query: query }, action: action })
    .then(function (plan) {
      currentPlan = plan && plan.plan_id ? plan : null;
      renderPlan(plan);
      if (currentPlan && plan.count > 0) {
        document.getElementById("apply-btn").disabled = false;
        setStatus("Plan ready (" + plan.count + " messages) \\u2014 review, then Apply.");
      } else if (currentPlan) {
        setStatus("Plan matches no messages \\u2014 nothing to apply.");
      } else {
        setStatus("Triage plan failed \\u2014 see plan panel.");
      }
    })
    .catch(function (err) {
      setStatus("Triage plan failed: " + err.message);
    });
});

document.getElementById("apply-btn").addEventListener("click", function () {
  if (!currentPlan || !currentPlan.plan_id) return;
  setStatus("Applying triage plan\\u2026");
  callApp(aliasTool("mailbox_triage_apply"), { plan_id: currentPlan.plan_id, confirm: true })
    .then(function () {
      setStatus("Plan applied (" + currentPlan.count + " messages).");
      document.getElementById("apply-btn").disabled = true;
      currentPlan = null;
      onMailboxChange();
    })
    .catch(function (err) {
      setStatus("Apply failed: " + err.message);
    });
});

function appendLog(text) {
  var el = document.getElementById("log");
  if (el.querySelector(".empty")) el.innerHTML = "";
  el.textContent += (el.textContent ? "\\n" : "") + text;
  el.scrollTop = el.scrollHeight;
}

function pollAgentRun(appRunId) {
  if (pollHandle) clearTimeout(pollHandle);
  callApp("app_status", { appRunId: appRunId })
    .then(function (status) {
      var sessions = (status && status.sessions) || [];
      var sessionId = sessions[0] && sessions[0].sessionId;
      var tail = sessionId
        ? callApp("agent_output", { sessionId: sessionId, lastN: 200, clean: true })
        : Promise.resolve("");
      return tail.then(function (output) {
        if (output) appendLog(typeof output === "string" ? output : JSON.stringify(output));
        var done = status && (status.status === "ended" || status.status === "done" || status.endedAt);
        if (!done) {
          pollHandle = setTimeout(function () { pollAgentRun(appRunId); }, 2000);
        } else {
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
  document.getElementById("log").innerHTML = "";
  setStatus("Starting triager agent\\u2026");
  callApp("app_run", { appId: APP_ID, agents: [AGENT_ID], prompt: "Triage my inbox." })
    .then(function (run) {
      appendLog("Started app run " + (run && run.appRunId));
      loadRuns();
      pollAgentRun(run.appRunId);
    })
    .catch(function (err) {
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
