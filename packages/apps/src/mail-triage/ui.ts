/**
 * Mail Triage — a self-contained MCP App dashboard for `mail-triage`.
 *
 * Talks to the daemon only through the `window.McpApp.connect()` bridge
 * (never a direct `fetch`): every action round-trips through the app's own
 * `app_tool_call` gateway tool, `{ appId, tool, args }`. Mailbox access goes
 * through the imported `agentpush` MCP server (`imported:agentpush/<tool>`
 * ids); running the triager agent itself goes through the daemon's own
 * `app_run` / `app_status` / `agent_output` — a second path alongside the
 * deterministic plan/apply tools, so the panel can either drive the mailbox
 * tools directly or hand the whole job to the agent and watch it work.
 */

export const MAIL_TRIAGE_TOOLS = [
  "imported:agentpush/mailbox_list",
  "imported:agentpush/mailbox_search",
  "imported:agentpush/mailbox_triage_plan",
  "imported:agentpush/mailbox_triage_apply",
  "app_run",
  "app_status",
  "agent_output",
] as const

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
#toolbar{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;background:var(--bg2);flex-shrink:0}
#toolbar .title{font-size:13px;font-weight:600;flex:1}
select,input[type=text]{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px;font-family:inherit}
.abtn{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}
.abtn:hover{background:var(--border)}
.abtn:disabled{opacity:.4;cursor:default}
.abtn.primary{background:var(--blue);border-color:var(--blue);color:#04101c}
.abtn.primary:hover{opacity:.9}
#content{padding:14px;display:flex;flex-direction:column;gap:16px}
section{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:12px}
section h3{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px}
#summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.tile{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px;text-align:center}
.tile .count{font-size:22px;font-weight:700}
.tile .label{font-size:11px;color:var(--text2);text-transform:capitalize}
.tile.urgent .count{color:var(--red)}
.tile.needs-reply .count{color:var(--yellow)}
.tile.newsletter .count{color:var(--blue)}
.tile.notification .count{color:var(--purple)}
#plan-list,#search-results,#log{max-height:260px;overflow-y:auto;font-size:12px}
.plan-item{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)}
.plan-item .subj{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.plan-item .tag{color:var(--text2);font-size:11px;white-space:nowrap}
#log{font-family:Menlo,Monaco,monospace;white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px}
.searchbar{display:flex;gap:8px;margin-bottom:8px}
.searchbar input{flex:1}
.actions{display:flex;gap:8px;margin-top:10px}
#status{padding:6px 14px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
.empty{color:var(--text2);padding:8px 0}
</style>
</head>
<body>
<div id="app">
  <div id="toolbar">
    <span class="title">Mail Triage</span>
    <select id="mailbox-select"></select>
    <button class="abtn" id="refresh-btn">Refresh</button>
  </div>
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
      <div class="actions">
        <button class="abtn primary" id="triage-btn">Triage</button>
        <button class="abtn" id="apply-btn" disabled>Apply</button>
      </div>
      <div id="plan-list" style="margin-top:10px"><div class="empty">No plan yet — click Triage.</div></div>
    </section>

    <section>
      <h3>Triager agent</h3>
      <div class="actions">
        <button class="abtn" id="run-agent-btn">Run Triager Agent</button>
      </div>
      <div id="log" style="margin-top:10px"><div class="empty">Agent has not run yet.</div></div>
    </section>
  </div>
  <div id="status">Connecting&#8230;</div>
</div>
<script>
var APP_ID = ${JSON.stringify(APP_ID)};
var AGENT_ID = ${JSON.stringify(AGENT_ID)};
var CATEGORIES = ${JSON.stringify(CATEGORIES)};
var callTool = null;
var currentPlan = null;
var pollHandle = null;

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

function asList(value, keys) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(value[keys[i]])) return value[keys[i]];
    }
  }
  return [];
}

function renderSummary(counts) {
  var el = document.getElementById("summary");
  el.innerHTML = "";
  CATEGORIES.forEach(function (cat) {
    var tile = document.createElement("div");
    tile.className = "tile " + cat;
    var count = counts && counts[cat] !== undefined ? counts[cat] : "–";
    tile.innerHTML = '<div class="count"></div><div class="label"></div>';
    tile.querySelector(".count").textContent = String(count);
    tile.querySelector(".label").textContent = cat.replace("-", " ");
    el.appendChild(tile);
  });
}

function loadMailboxes() {
  setStatus("Loading mailboxes\\u2026");
  return callApp("imported:agentpush/mailbox_list", {})
    .then(function (result) {
      var mailboxes = asList(result, ["mailboxes", "items"]);
      var select = document.getElementById("mailbox-select");
      select.innerHTML = "";
      if (mailboxes.length === 0) {
        var opt = document.createElement("option");
        opt.textContent = "inbox";
        opt.value = "inbox";
        select.appendChild(opt);
      } else {
        mailboxes.forEach(function (mb) {
          var name = typeof mb === "string" ? mb : mb.name || mb.id || JSON.stringify(mb);
          var opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          select.appendChild(opt);
        });
      }
      setStatus("Ready");
    })
    .catch(function (err) {
      setStatus("Error loading mailboxes: " + err.message);
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

function renderPlan(plan) {
  var items = asList(plan, ["actions", "items", "plan"]);
  var el = document.getElementById("plan-list");
  el.innerHTML = "";
  if (items.length === 0) {
    el.innerHTML = '<div class="empty">Plan is empty.</div>';
    return;
  }
  var counts = {};
  items.forEach(function (item) {
    var cat = (item && (item.category || item.tag)) || "notification";
    counts[cat] = (counts[cat] || 0) + 1;
    var row = document.createElement("div");
    row.className = "plan-item";
    var subj = (item && (item.subject || item.title)) || JSON.stringify(item);
    var action = (item && (item.action || item.category)) || "";
    row.innerHTML = '<span class="subj"></span><span class="tag"></span>';
    row.querySelector(".subj").textContent = subj;
    row.querySelector(".tag").textContent = action;
    el.appendChild(row);
  });
  renderSummary(counts);
}

document.getElementById("refresh-btn").addEventListener("click", loadMailboxes);

document.getElementById("search-btn").addEventListener("click", function () {
  var query = document.getElementById("search-input").value;
  var mailbox = document.getElementById("mailbox-select").value;
  setStatus("Searching\\u2026");
  callApp("imported:agentpush/mailbox_search", { mailbox: mailbox, query: query })
    .then(function (result) {
      renderSearchResults(asList(result, ["messages", "items", "results"]));
      setStatus("Ready");
    })
    .catch(function (err) {
      setStatus("Search failed: " + err.message);
    });
});

document.getElementById("triage-btn").addEventListener("click", function () {
  var mailbox = document.getElementById("mailbox-select").value;
  setStatus("Building triage plan\\u2026");
  document.getElementById("apply-btn").disabled = true;
  callApp("imported:agentpush/mailbox_triage_plan", { mailbox: mailbox })
    .then(function (plan) {
      currentPlan = plan;
      renderPlan(plan);
      document.getElementById("apply-btn").disabled = false;
      setStatus("Plan ready \\u2014 review, then Apply.");
    })
    .catch(function (err) {
      setStatus("Triage plan failed: " + err.message);
    });
});

document.getElementById("apply-btn").addEventListener("click", function () {
  if (!currentPlan) return;
  setStatus("Applying triage plan\\u2026");
  callApp("imported:agentpush/mailbox_triage_apply", { plan: currentPlan })
    .then(function () {
      setStatus("Plan applied.");
      document.getElementById("apply-btn").disabled = true;
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
      pollAgentRun(run.appRunId);
    })
    .catch(function (err) {
      setStatus("Run failed: " + err.message);
    });
});

window.McpApp.connect()
  .then(function (bridge) {
    callTool = bridge.callTool;
    return loadMailboxes();
  })
  .catch(function (err) {
    setStatus("Standalone mode \\u2014 no host bridge (" + err.message + ")");
    renderSummary(null);
  });

renderSummary(null);
</script>
</body>
</html>`
