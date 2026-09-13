/**
 * Media Viewer — a self-contained MCP App gallery widget for `media-viewer`.
 *
 * Talks to the daemon only through the `window.McpApp.connect()` bridge
 * (never a direct `fetch`): every action round-trips through the app's own
 * `app_tool_call` gateway tool, `{ appId, tool, args }`. `app_tool_call`
 * double-wraps its dispatch result (it returns a text-result whose `text` is
 * the JSON-stringified inner tool result, itself an MCP content array) — see
 * `unwrapText` below, which peels that apart regardless of how many layers
 * the host's bridge already stripped.
 */

export const MEDIA_VIEWER_TOOLS = ["directory_list", "file_info", "file_read"] as const

const APP_ID = "@agentproto/media-viewer"

export const MEDIA_VIEWER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Media Viewer</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#e6edf3;--text2:#8b949e;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;--purple:#bc8cff;
}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;background:var(--bg);color:var(--text)}
#app{display:flex;flex-direction:column;height:100%}
#toolbar{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;background:var(--bg2);flex-shrink:0}
#toolbar .title{font-size:13px;font-weight:600;flex:1}
#breadcrumb{font-size:12px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.abtn{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px;font-family:inherit}
.abtn:hover{background:var(--border)}
#body{flex:1;display:flex;overflow:hidden}
#grid-wrap{flex:1;overflow-y:auto;padding:14px}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
.cell{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);cursor:pointer;text-align:center}
.cell:hover{background:var(--bg3);border-color:var(--blue)}
.cell.selected{border-color:var(--blue);background:var(--bg3)}
.icon{font-size:28px;line-height:1}
.name{font-size:11px;color:var(--text);word-break:break-word;max-width:100%;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
#empty{color:var(--text2);padding:24px;text-align:center}
#details{width:280px;border-left:1px solid var(--border);background:var(--bg2);padding:14px;overflow-y:auto;flex-shrink:0}
#details h3{font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
#details .row{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px}
#details .row span:first-child{color:var(--text2)}
#preview{margin-top:10px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-family:Menlo,Monaco,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow-y:auto}
#status{padding:6px 14px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);background:var(--bg2);flex-shrink:0}
</style>
</head>
<body>
<div id="app">
  <div id="toolbar">
    <button class="abtn" id="up-btn" title="Up one level">&uarr;</button>
    <span class="title">Media Viewer</span>
    <span id="breadcrumb">.</span>
    <button class="abtn" id="refresh-btn">Refresh</button>
  </div>
  <div id="body">
    <div id="grid-wrap">
      <div id="grid"></div>
      <div id="empty" style="display:none">No files in this folder.</div>
    </div>
    <div id="details" style="display:none"></div>
  </div>
  <div id="status">Connecting&#8230;</div>
</div>
<script>
var APP_ID = ${JSON.stringify(APP_ID)};
var currentPath = ".";
var entries = [];
var callTool = null;

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

// app_tool_call wraps its dispatch result at least once (its own
// text-result body is the JSON-stringified inner MCP tool result); peel
// back through nested {content:[{type:"text",text:...}]} shells until the
// payload stops looking like one, so this works whichever layer the host's
// own bridge already unwrapped.
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

function parseDirectoryListing(raw) {
  var text = typeof raw === "string" ? raw : "";
  return text
    .split("\\n")
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line.length > 0; })
    .map(function (line) {
      var isDir = line.indexOf("[DIR]") === 0;
      var name = line.replace(/^\\[(FILE|DIR)\\]\\s*/, "");
      return { name: name, isDir: isDir };
    });
}

function iconFor(entry) {
  if (entry.isDir) return "\\uD83D\\uDCC1";
  var ext = (entry.name.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif"].indexOf(ext) !== -1) return "\\uD83D\\uDDBC\\uFE0F";
  if (["mp4", "webm", "mov", "avi", "mkv"].indexOf(ext) !== -1) return "\\uD83C\\uDFA5";
  if (["mp3", "wav", "ogg", "flac", "aac", "m4a"].indexOf(ext) !== -1) return "\\uD83C\\uDFB5";
  return "\\uD83D\\uDCC4";
}

function joinPath(base, name) {
  if (base === "." || base === "") return name;
  return base.replace(/\\/+$/, "") + "/" + name;
}

function parentPath(path) {
  if (path === "." || path.indexOf("/") === -1) return ".";
  return path.slice(0, path.lastIndexOf("/")) || ".";
}

function renderGrid() {
  document.getElementById("breadcrumb").textContent = currentPath;
  var grid = document.getElementById("grid");
  var empty = document.getElementById("empty");
  grid.innerHTML = "";
  if (entries.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  entries.forEach(function (entry, idx) {
    var cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.idx = String(idx);
    cell.innerHTML = '<div class="icon">' + iconFor(entry) + '</div><div class="name"></div>';
    cell.querySelector(".name").textContent = entry.name;
    cell.addEventListener("click", function () { onSelect(entry, cell); });
    grid.appendChild(cell);
  });
}

function onSelect(entry, cell) {
  Array.prototype.forEach.call(document.querySelectorAll(".cell"), function (c) {
    c.classList.remove("selected");
  });
  cell.classList.add("selected");
  if (entry.isDir) {
    loadDirectory(joinPath(currentPath, entry.name));
    return;
  }
  showFileDetails(joinPath(currentPath, entry.name));
}

function showFileDetails(path) {
  var details = document.getElementById("details");
  details.style.display = "block";
  details.innerHTML = "<h3>Loading&#8230;</h3>";
  setStatus("Reading " + path + "\\u2026");
  callApp("file_info", { path: path })
    .then(function (info) {
      var rows = "";
      if (info && typeof info === "object") {
        ["name", "type", "size", "modified"].forEach(function (key) {
          if (info[key] !== undefined) {
            rows += '<div class="row"><span>' + key + '</span><span></span></div>';
          }
        });
      }
      details.innerHTML = "<h3>Details</h3>" + rows + '<div id="preview">Loading preview&#8230;</div>';
      var rowEls = details.querySelectorAll(".row span:last-child");
      var keys = ["name", "type", "size", "modified"].filter(function (key) {
        return info && info[key] !== undefined;
      });
      keys.forEach(function (key, i) {
        rowEls[i].textContent = String(info[key]);
      });
      return callApp("file_read", { path: path });
    })
    .then(function (content) {
      var pre = document.getElementById("preview");
      if (!pre) return;
      var text = typeof content === "string" ? content : JSON.stringify(content);
      pre.textContent = text.length > 2000 ? text.slice(0, 2000) + "\\u2026 (truncated)" : (text || "(empty file)");
      setStatus("Ready \\u00b7 " + currentPath);
    })
    .catch(function (err) {
      var pre = document.getElementById("preview");
      if (pre) pre.textContent = "Preview unavailable (" + err.message + ")";
      setStatus("Ready \\u00b7 " + currentPath);
    });
}

function loadDirectory(path) {
  document.getElementById("details").style.display = "none";
  setStatus("Loading " + path + "\\u2026");
  return callApp("directory_list", { path: path })
    .then(function (raw) {
      currentPath = path;
      entries = parseDirectoryListing(raw).sort(function (a, b) {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      renderGrid();
      setStatus("Ready \\u00b7 " + entries.length + " entries \\u00b7 " + path);
    })
    .catch(function (err) {
      entries = [];
      renderGrid();
      setStatus("Error: " + err.message);
    });
}

document.getElementById("up-btn").addEventListener("click", function () {
  loadDirectory(parentPath(currentPath));
});
document.getElementById("refresh-btn").addEventListener("click", function () {
  loadDirectory(currentPath);
});

window.McpApp.connect()
  .then(function (bridge) {
    callTool = bridge.callTool;
    return loadDirectory(".");
  })
  .catch(function (err) {
    setStatus("Standalone mode \\u2014 no host bridge (" + err.message + ")");
    entries = [];
    renderGrid();
  });
</script>
</body>
</html>`
