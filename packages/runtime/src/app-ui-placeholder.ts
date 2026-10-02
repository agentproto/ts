/**
 * Self-contained HTML pages served in place of an installed app's real UI
 * bundle while it's building, or when it can never be served (missing file
 * with no `ui.build`, a failed build, a removed app dir). Both surfaces that
 * serve an app's UI as a PAGE — the `ui://app_ui_<id>/view` MCP resource
 * (app-ui-apps.ts) and `GET /apps/:appId/ui` (http-server.ts) — render
 * through here instead of ever putting raw `{"error":...}` JSON in a page
 * body. That JSON shape is kept exactly as-is for MCP TOOL callers (e.g.
 * `app_install`'s error result) — this module is for the two PAGE routes
 * only.
 *
 * Reload strategy — deliberately two different mechanisms for the two
 * hosts, because neither works everywhere:
 *
 *   - The VS Code webview panel (packages/vscode appPanel.ts) embeds this
 *     page as an inner `srcdoc` iframe of an outer document it fully
 *     controls (buildAppHostHtml). `srcdoc` has no URL, so a navigation
 *     inside it (meta-refresh) just re-parses the SAME string — it can
 *     never pick up new content on its own. The extension host is what can:
 *     appPanel.ts detects `BUILDING_STATUS_ATTR` on the returned html and
 *     re-issues `resources/read` on a timer, replacing `panel.webview.html`
 *     wholesale until the marker is gone (see appPanel.logic.ts's
 *     `isAppUiBuilding`).
 *   - `GET /apps/:appId/ui` (http-server.ts) IS a real top-level navigation
 *     target, so this page's own `<meta http-equiv="refresh">` re-requests
 *     the same URL from the server directly — no host cooperation needed.
 *
 * Both mechanisms are outside this module's own script, which is
 * deliberate: the page also has to survive the strictest CSP either host
 * imposes — the VS Code outer document sets `default-src 'none'; script-src
 * 'unsafe-inline'; style-src 'unsafe-inline'` with NO `connect-src`, and the
 * srcdoc iframe inherits it verbatim, so nothing here may `fetch`, open a
 * `WebSocket`/`EventSource`, or load an external image/font. The one bit of
 * live JS this page does carry — the elapsed-time counter — only touches
 * `Date.now()` and the DOM off a baked-in timestamp, neither of which needs
 * network access.
 */

/** `data-agentproto-ui-status` value while a build is in flight (or about to
 *  start) — `appPanel.logic.ts`'s `isAppUiBuilding` matches on this exact
 *  attribute/value pair; keep the two in lockstep (same cross-package
 *  duplication the file's own `appUiToolId` already accepts, since a
 *  `ui://`-served page can't import back into `@agentproto/vscode`). */
export const APP_UI_BUILDING_STATUS_ATTR = 'data-agentproto-ui-status="building"'

const REFRESH_SECONDS = 3

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function pageShell(opts: {
  statusAttr?: string
  refresh?: boolean
  title: string
  body: string
  script?: string
}): string {
  return `<!DOCTYPE html>
<html lang="en"${opts.statusAttr ? ` ${opts.statusAttr}` : ""}>
<head>
<meta charset="UTF-8">
${opts.refresh ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` : ""}
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 2rem; box-sizing: border-box;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #ccc; background: #1e1e1e; text-align: center;
  }
  h1 { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0.25rem 0; color: #999; max-width: 34rem; }
  .spinner {
    width: 22px; height: 22px; margin-bottom: 1rem;
    border: 2px solid #444; border-top-color: #8ab4f8; border-radius: 50%;
    animation: agentproto-spin 0.8s linear infinite;
  }
  @keyframes agentproto-spin { to { transform: rotate(360deg); } }
  pre {
    margin-top: 1rem; padding: 0.75rem; max-width: 42rem; width: 90%;
    max-height: 12rem; overflow: auto; text-align: left; white-space: pre-wrap;
    word-break: break-word; background: #111; border: 1px solid #333;
    border-radius: 4px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #d99;
  }
  code { color: #ccc; }
</style>
</head>
<body>
${opts.body}
${opts.script ? `<script>${opts.script}</script>` : ""}
</body>
</html>`
}

export interface AppUiBuildingHtmlInput {
  readonly appName: string
  /** `Date.now()`-style epoch ms the build actually started — the elapsed
   *  counter is computed client-side off this, not baked in as static text,
   *  so it keeps ticking between reloads. */
  readonly startedAt: number
  /** Last lines of the app's ui-build log (`appUiBuildLogPath`), if cheap to read. */
  readonly logTail?: string
}

/** The "still building" placeholder — see the module doc for the reload
 *  strategy. Never blocks on the build itself; the caller decides when to
 *  show this (app-ui-build.ts's `resolveAppUiBuildState`). */
export function renderAppUiBuildingHtml(input: AppUiBuildingHtmlInput): string {
  const body = `
  <div class="spinner" role="status" aria-label="Building"></div>
  <h1>Building ${escapeHtml(input.appName)} UI&hellip;</h1>
  <p id="agentproto-elapsed">elapsed 0s</p>
  ${input.logTail ? `<pre>${escapeHtml(input.logTail)}</pre>` : ""}`
  const script = `(function () {
  var startedAt = ${JSON.stringify(input.startedAt)};
  var el = document.getElementById("agentproto-elapsed");
  function tick() {
    if (!el) return;
    var secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    el.textContent = "elapsed " + secs + "s";
  }
  tick();
  setInterval(tick, 1000);
})();`
  return pageShell({
    statusAttr: APP_UI_BUILDING_STATUS_ATTR,
    refresh: true,
    title: `Building ${input.appName}…`,
    body,
    script,
  })
}

export interface AppUiErrorHtmlInput {
  readonly appName: string
  readonly message: string
  /** A path worth showing verbatim (the missing file, the removed app dir,
   *  the build log). */
  readonly detailPath?: string
  readonly logTail?: string
  /** Defaults to the generic reinstall/APP.md pointer. */
  readonly fix?: string
}

/** A readable terminal-failure page — never auto-reloads (unlike the
 *  building placeholder): the failure already happened, and refreshing a
 *  failed `ui.build` run on a timer would just re-run it forever. A human
 *  reloading the panel/tab gets a fresh attempt instead. */
export function renderAppUiErrorHtml(input: AppUiErrorHtmlInput): string {
  const fix =
    input.fix ??
    "Reinstall the app with `app_install <dir>`, or check its APP.md `ui` block."
  const body = `
  <h1>${escapeHtml(input.appName)} UI is unavailable</h1>
  <p>${escapeHtml(input.message)}</p>
  ${input.detailPath ? `<p><code>${escapeHtml(input.detailPath)}</code></p>` : ""}
  <p>${escapeHtml(fix)}</p>
  ${input.logTail ? `<pre>${escapeHtml(input.logTail)}</pre>` : ""}`
  return pageShell({ title: `${input.appName}: UI unavailable`, body })
}
