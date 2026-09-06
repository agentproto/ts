/**
 * Installed-app webview panels — each daemon-installed app that ships a `ui`
 * block opens as a VS Code editor tab (viewType `agentproto.appPanel`), a
 * sibling to the story panel.
 *
 * The panel HTML is NOT authored here: it is fetched from the daemon's MCP
 * resource `ui://app_ui_<slug>/view` (packages/runtime mcp-apps-adapter.ts),
 * which serves the app's own `ui.path` html with the `window.McpApp` bridge
 * already injected. That bridge speaks JSON-RPC 2.0 over
 * `window.parent.postMessage`; a VS Code webview reaches its extension
 * through `acquireVsCodeApi()` instead, so — exactly like storyPanel.ts —
 * the app html runs inside an inner `srcdoc` iframe and the outer webview
 * document is a thin relay: iframe → extension (`vscode.postMessage`) and
 * extension → iframe (`contentWindow.postMessage`).
 * {@link AppPanelController} is the extension half that answers the
 * handshake and maps the bridge's tool calls onto the DaemonClient.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { InstalledAppInfo } from "../client/types.js"
import { appLabel } from "../views/appsTree.logic.js"
import { appViewResourceUri } from "./appPanel.logic.js"
import { AppPanelController } from "./appPanelController.js"

export interface AppPanels {
  open(app: InstalledAppInfo): void
}

export function registerAppPanels(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
): AppPanels {
  const panels = new Map<string, vscode.WebviewPanel>()

  return {
    open(app: InstalledAppInfo): void {
      const existing = panels.get(app.appId)
      if (existing) {
        existing.reveal(vscode.ViewColumn.One, false)
        return
      }

      const panel = vscode.window.createWebviewPanel(
        "agentproto.appPanel",
        appLabel(app),
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      )
      panels.set(app.appId, panel)

      const controller = new AppPanelController({
        appId: app.appId,
        daemon: client,
        post: msg => void panel.webview.postMessage(msg),
      })

      panel.webview.onDidReceiveMessage(
        (raw: unknown) => void controller.handleMessage(raw),
        undefined,
        ctx.subscriptions,
      )

      panel.onDidDispose(() => {
        panels.delete(app.appId)
      })

      void (async () => {
        try {
          const html = await client.readResource(appViewResourceUri(app.appId))
          panel.webview.html = buildAppHostHtml(html, appLabel(app))
        } catch (err) {
          panel.dispose()
          void vscode.window.showErrorMessage(
            `Open app '${app.appId}' failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    },
  }
}

/**
 * The outer webview document: a full-bleed `srcdoc` iframe carrying the app
 * panel, plus a relay script bridging the panel's `window.parent.postMessage`
 * JSON-RPC to the extension via `acquireVsCodeApi()`.
 *
 * Exported so a jsdom test can assert the relay and the byte-identical embed
 * without a real VS Code webview host.
 */
export function buildAppHostHtml(appHtml: string, title: string): string {
  // The app html is served self-contained (inline scripts/styles, no nonce),
  // so 'unsafe-inline' is what lets its inline code run inside the srcdoc
  // iframe, which inherits this document's CSP. No remote origins are
  // allowed; everything is inline and same-origin.
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "frame-src 'self'",
    "img-src data:",
    "font-src 'self'",
  ].join("; ")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
    #app { border: 0; display: block; width: 100%; height: 100vh; }
  </style>
</head>
<body>
  <iframe id="app" title="${escapeHtml(title)}" srcdoc="${escapeSrcdoc(appHtml)}"></iframe>
  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      const frame = document.getElementById('app');
      window.addEventListener('message', function (evt) {
        if (frame && evt.source === frame.contentWindow) {
          // JSON-RPC posted by the panel bridge (window.parent) → extension.
          vscode.postMessage(evt.data);
        } else if (frame && frame.contentWindow) {
          // Anything else is a host→panel message the extension posted — relay
          // it into the panel iframe, whose bridge listens on window 'message'
          // (it ignores non-JSON-RPC frames, so a stray message is harmless).
          frame.contentWindow.postMessage(evt.data, '*');
        }
      });
    })();
  </script>
</body>
</html>`
}

/**
 * Escape the panel html for embedding in the `srcdoc` attribute. Only `&` and
 * `"` are significant inside a double-quoted attribute value; the browser
 * decodes them back, so the panel document is byte-identical to the served
 * resource. `<`/`>` are valid inside an attribute value and left as-is —
 * escaping them would fork the panel's own markup.
 */
function escapeSrcdoc(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
