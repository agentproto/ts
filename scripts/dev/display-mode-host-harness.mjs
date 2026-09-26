#!/usr/bin/env node
/**
 * display-mode-host-harness.mjs — a local MCP-Apps HOST, for eyeballing the
 * display-mode ("⤢ Agrandir") toggle in a real browser.
 *
 * The toggle's behaviour depends entirely on things a unit test has to fake:
 * what the host advertises in `hostContext.availableDisplayModes`, where its
 * chrome sits (`hostContext.safeAreaInsets`), and whether it honours
 * `ui/request-display-mode` at all. This page stands in for that host, with
 * one panel per scenario, so all of them are visible — and measurable — in a
 * single screenshot.
 *
 * What makes it a faithful stand-in rather than a mock:
 *
 *   - The app iframe is `<iframe srcdoc sandbox="allow-scripts">`, so its
 *     origin is `null` — the same opaque-origin widget context Claude
 *     Desktop uses, and the reason the host can't reach into it to measure
 *     anything itself (each app reports its own numbers back over
 *     postMessage; see APP_REPORT).
 *   - The app html is injected by the REAL `injectMcpAppBridge`
 *     (`packages/runtime`), so what runs in the frame is the production
 *     bridge + `@agentproto/app-client/display-mode` + runner-select, in
 *     production order — not a re-derivation.
 *   - The host side speaks the real wire: it answers `ui/initialize` with a
 *     `hostContext`, accepts `ui/notifications/initialized`, and answers or
 *     refuses `ui/request-display-mode` per scenario.
 *
 * Usage (needs a built tree — `pnpm build` — since it imports from dist):
 *   node scripts/dev/display-mode-host-harness.mjs [--port 18795]
 *
 * Then open the printed URL. Each panel prints the measured button geometry
 * (top/right in CSS px, relative to the app viewport), so "is the button
 * clear of the host's header?" is a number, not a squint.
 */

import { createServer } from "node:http"
import { injectMcpAppBridge } from "../../packages/runtime/dist/index.mjs"

const portArg = process.argv.indexOf("--port")
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 18795

/**
 * The app under test: a minimal installed-app UI. It connects through the
 * injected `window.McpApp`, then measures its own toggle and reports the
 * numbers up to the harness — the host can't read into an opaque-origin
 * frame, so the app is the only one who can measure it.
 *
 * `autoclick` drives the optimistic refusal path end to end: report, click,
 * report again, so a screenshot shows both sides of the refusal.
 */
function appHtml({ meta = "", autoclick = false }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${meta}
<style>
  html,body{margin:0;height:100%;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
  body{background:#101214;color:#c9d1d9;padding:10px}
  h3{margin:0 0 6px;font-size:12px;color:#8b949e;font-weight:600}
  pre{margin:0;white-space:pre-wrap;font-size:11px}
</style>
</head>
<body>
<h3>app ui</h3>
<pre id="out">connecting…</pre>
<script>
(function () {
  var out = document.getElementById("out");
  // The toggle's own diagnostics, captured so they're visible in a
  // screenshot instead of only in devtools — this is what a user debugging
  // "why is there no button in Claude Desktop?" is told.
  var diag = [];
  var realLog = console.log.bind(console);
  console.log = function () {
    var args = [].slice.call(arguments);
    if (typeof args[0] === "string" && args[0].indexOf("[mcp-app]") === 0) {
      diag.push(args.map(function (a) {
        return typeof a === "string" ? a : JSON.stringify(a);
      }).join(" "));
    }
    realLog.apply(null, args);
  };
  function report(phase) {
    var btn = document.getElementById("agentproto-display-mode");
    var bar = document.getElementById("agentproto-display-mode-bar");
    var info = { phase: phase, mounted: !!btn, visible: false };
    if (btn) {
      var cs = getComputedStyle(btn);
      info.visible = cs.display !== "none";
      info.glyph = btn.textContent;
      info.label = btn.getAttribute("aria-label");
      if (info.visible) {
        var r = btn.getBoundingClientRect();
        info.top = Math.round(r.top);
        info.right = Math.round(document.documentElement.clientWidth - r.right);
        info.size = Math.round(r.width) + "x" + Math.round(r.height);
        info.bg = cs.backgroundColor;
        info.fg = cs.color;
      }
    }
    if (bar) {
      var bs = getComputedStyle(bar);
      info.barTop = bs.top;
      info.barRight = bs.right;
    }
    var dm = window.McpApp && window.McpApp.displayMode;
    if (dm) {
      info.displayMode = dm.get();
      info.available = dm.available();
    }
    out.textContent = (out.textContent === "connecting…" ? "" : out.textContent + "\\n") +
      JSON.stringify(info, null, 1) + "\\nconsole: " + diag.join(" ; ");
    parent.postMessage({ type: "agentproto/harness-report", info: info, diag: diag.slice() }, "*");
  }

  window.McpApp.connect().then(function () {
    // One frame, so the toggle's own ready()/mount has run.
    setTimeout(function () {
      report("after-connect");
      ${autoclick
        ? `var b = document.getElementById("agentproto-display-mode");
      if (b) { b.click(); setTimeout(function () { report("after-click"); }, 60); }`
        : ""}
    }, 30);
  }, function (err) {
    out.textContent = "connect failed: " + err.message;
  });
})();
</script>
</body>
</html>`
}

/**
 * Every scenario the toggle has to get right, as a host would present it.
 * `insets` feeds hostContext.safeAreaInsets AND the panel's painted chrome,
 * so the rendered header and the number the app is told about agree.
 */
const SCENARIOS = [
  {
    id: "claude-desktop",
    title: "A · host advertises nothing (Claude Desktop)",
    note: "availableDisplayModes: [] → toggle stays hidden; the host's own frame control is the fallback.",
    available: [],
    accept: true,
  },
  {
    id: "advertised",
    title: "B · host advertises fullscreen, no insets",
    note: "availableDisplayModes: ['inline','fullscreen'] → visible at the plain 8px gap.",
    available: ["inline", "fullscreen"],
    accept: true,
  },
  {
    id: "safe-area",
    title: "C · fullscreen + safeAreaInsets {top:48,right:12} (Codex)",
    note: "Header chrome declared → expect top 56 / right 20, clear of the bar instead of under it.",
    available: ["inline", "fullscreen"],
    insets: { top: 48, right: 12, bottom: 0, left: 0 },
    accept: true,
  },
  {
    id: "optimistic-reject",
    title: "D · optimistic, host REFUSES the request",
    note: "meta content=optimistic → shown on spec, auto-clicked, then hidden permanently on the refusal.",
    available: [],
    optimistic: true,
    autoclick: true,
    accept: false,
  },
  {
    id: "optimistic-accept",
    title: "E · optimistic, host HONOURS the request",
    note: "Same opt-in against a host that does support it → stays, flips to ⤡ Réduire.",
    available: [],
    optimistic: true,
    autoclick: true,
    accept: true,
  },
  {
    id: "pip",
    title: "F · host advertises pip too",
    note: "availableDisplayModes: [...,'pip'] → the second (📌) button appears beside it.",
    available: ["inline", "fullscreen", "pip"],
    accept: true,
  },
]

function scenarioSrcdoc(scenario) {
  const meta = scenario.optimistic
    ? '<meta name="agentproto-display-toggle" content="optimistic">'
    : ""
  return injectMcpAppBridge(appHtml({ meta, autoclick: scenario.autoclick }))
}

/** The harness page: the host half of the wire, one frame per scenario. */
function harnessHtml() {
  const scenarios = SCENARIOS.map(s => ({
    ...s,
    srcdoc: scenarioSrcdoc(s),
  }))
  // Each srcdoc is a whole html document, `</script>` and all — embedded raw
  // it would close the harness's own <script> block at the first one and
  // dump the rest of the payload into the page as text. Escaping `<` is the
  // fix that survives every variant (`</script >`, `<!--`, …).
  const scenarioJson = JSON.stringify(scenarios).replace(/</g, "\\u003c")
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>agentproto · display-mode host harness</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0d0f;color:#e6edf3;
       font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
  h1{font-size:15px;margin:14px 16px 2px}
  .sub{margin:0 16px 12px;color:#8b949e;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(3,minmax(360px,1fr));gap:14px;padding:0 16px 16px}
  .panel{border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}
  .panel h2{font-size:12px;margin:0;padding:8px 10px;background:#161b22;border-bottom:1px solid #30363d}
  .panel .note{font-size:11px;color:#8b949e;padding:6px 10px;border-bottom:1px solid #21262d}
  /* The host's own chrome — painted at exactly the inset the app is told
     about, so "under the header" is visible, not just numeric. */
  .stage{position:relative;height:210px;background:#161b22}
  .chrome{position:absolute;left:0;right:0;top:0;background:#21262d;border-bottom:1px solid #30363d;
          display:flex;align-items:center;padding:0 10px;font-size:11px;color:#8b949e;z-index:5}
  .chrome .rail{position:absolute;right:0;top:0;bottom:0;background:#2d333b}
  iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#101214}
  .readout{font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
           white-space:pre-wrap;padding:8px 10px;border-top:1px solid #21262d;color:#7ee787;min-height:64px}
  .rpc{font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#6e7681;
       padding:0 10px 8px;white-space:pre-wrap}
</style>
</head>
<body>
<h1>display-mode toggle · local MCP-Apps host harness</h1>
<p class="sub">Each frame is <code>&lt;iframe srcdoc sandbox="allow-scripts"&gt;</code> (origin <code>null</code>, as in Claude Desktop),
running the real injected bridge. Grey bar = host chrome painted at the declared <code>safeAreaInsets</code>.
<code>top</code>/<code>right</code> below are measured by the app itself, in CSS px from its own viewport edges.</p>
<div class="grid" id="grid"></div>
<script>
var SCENARIOS = ${scenarioJson};

SCENARIOS.forEach(function (s) {
  var insets = s.insets || {};
  var panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML =
    '<h2>' + s.title + '</h2>' +
    '<div class="note">' + s.note + '</div>' +
    '<div class="stage">' +
      (insets.top
        ? '<div class="chrome" style="height:' + insets.top + 'px">host header (' + insets.top + 'px)' +
          (insets.right ? '<div class="rail" style="width:' + insets.right + 'px"></div>' : '') +
          '</div>'
        : '') +
      '<iframe sandbox="allow-scripts"></iframe>' +
    '</div>' +
    '<div class="readout">waiting…</div>' +
    '<div class="rpc"></div>';
  document.getElementById("grid").appendChild(panel);

  var frame = panel.querySelector("iframe");
  var readout = panel.querySelector(".readout");
  var rpc = panel.querySelector(".rpc");
  var seen = [];

  function log(line) {
    seen.push(line);
    rpc.textContent = "host wire: " + seen.join("  |  ");
  }

  // ── host side of the MCP-Apps wire ──────────────────────────────────
  var hostContext = { displayMode: "inline", availableDisplayModes: s.available, theme: "dark" };
  if (s.insets) hostContext.safeAreaInsets = s.insets;

  window.addEventListener("message", function (evt) {
    if (evt.source !== frame.contentWindow) return;
    var m = evt.data;
    if (m && m.type === "agentproto/harness-report") {
      readout.textContent = (readout.textContent === "waiting…" ? "" : readout.textContent + "\\n") +
        JSON.stringify(m.info) +
        ((m.diag && m.diag.length) ? "\\nconsole: " + m.diag.join(" ; ") : "");
      return;
    }
    if (!m || m.jsonrpc !== "2.0") return;
    function reply(result) { frame.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result: result }, "*"); }
    function fail(message) {
      frame.contentWindow.postMessage(
        { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: message } }, "*");
    }

    if (m.method === "ui/initialize") {
      log("ui/initialize → hostContext");
      reply({ hostContext: hostContext, hostCapabilities: {} });
    } else if (m.method === "ui/notifications/initialized") {
      log("initialized");
    } else if (m.method === "ui/request-display-mode") {
      var want = m.params && m.params.mode;
      if (!s.accept) {
        log("request-display-mode(" + want + ") → REFUSED");
        fail("display mode not supported by this host");
        return;
      }
      log("request-display-mode(" + want + ") → " + want);
      hostContext.displayMode = want;
      reply({ mode: want });
      // A compliant host also announces the change.
      frame.contentWindow.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { displayMode: want }
      }, "*");
    } else if (m.method === "tools/call") {
      // runner-select's discovery calls land here; answer empty so the app
      // isn't waiting on a tool host that this harness doesn't have.
      reply({ content: [{ type: "text", text: "{}" }] });
    }
  });

  frame.srcdoc = s.srcdoc;
});
</script>
</body>
</html>`
}

const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0]
  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end('{"ok":true}')
    return
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end(harnessHtml())
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`display-mode host harness → http://127.0.0.1:${PORT}/`)
  console.log(`scenarios: ${SCENARIOS.map(s => s.id).join(", ")}`)
})

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close()
    process.exit(0)
  })
}
