/**
 * Session-story webview panel — the live, readable per-session timeline as a
 * VS Code editor tab (viewType `agentproto.story`), a sibling to the transcript
 * panel.
 *
 * The panel HTML is NOT authored here: it is `SESSION_STORY_PANEL_HTML` from
 * `@agentproto/runtime`, reused byte-for-byte (the same validated surface the
 * MCP-Apps host renders). That html is fully self-contained (CSP inline-only)
 * and talks to its host over a JSON-RPC 2.0 postMessage bridge. Because a VS
 * Code webview reaches its extension through `acquireVsCodeApi()` — a raw
 * `window.parent.postMessage` (what the bridge does) never gets there — the
 * panel runs inside an inner `srcdoc` iframe, exactly as it does inside an
 * MCP-Apps host iframe today. The outer webview document is a thin relay:
 * iframe → extension (`vscode.postMessage`) and extension → iframe
 * (`contentWindow.postMessage`). {@link StoryPanelController} is the extension
 * half that answers the handshake and maps the bridge's tool calls onto the
 * DaemonClient.
 */

import * as vscode from "vscode"

import { SESSION_STORY_PANEL_HTML } from "@agentproto/runtime/session-story-panel"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import { formatTitle } from "./transcript.logic.js"
import { StoryPanelController } from "./storyPanelController.js"

export interface StoryPanels {
  open(session: SessionDescriptor): void
}

export function registerStoryPanels(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
): StoryPanels {
  const panels = new Map<string, vscode.WebviewPanel>()

  return {
    open(session: SessionDescriptor): void {
      const existing = panels.get(session.id)
      if (existing) {
        existing.reveal(vscode.ViewColumn.One, false)
        return
      }

      const panel = vscode.window.createWebviewPanel(
        "agentproto.story",
        `${formatTitle(session)} — story`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      )
      panels.set(session.id, panel)

      const controller = new StoryPanelController({
        sessionId: session.id,
        daemon: client,
        post: msg => void panel.webview.postMessage(msg),
      })

      panel.webview.onDidReceiveMessage(
        (raw: unknown) => void controller.handleMessage(raw),
        undefined,
        ctx.subscriptions,
      )

      panel.onDidDispose(() => {
        panels.delete(session.id)
      })

      panel.webview.html = buildStoryHostHtml(SESSION_STORY_PANEL_HTML)
    },
  }
}

/**
 * The outer webview document: a full-bleed `srcdoc` iframe carrying the story
 * panel, plus a relay script bridging the panel's `window.parent.postMessage`
 * JSON-RPC to the extension via `acquireVsCodeApi()`.
 *
 * Exported so a jsdom test can assert the relay and the byte-identical embed
 * without a real VS Code webview host.
 */
export function buildStoryHostHtml(storyHtml: string): string {
  // The panel is a trusted, self-contained constant that runs its own inline
  // <script>/<style> with no nonce (CSP inline-only, by its own design). The
  // srcdoc iframe inherits this document's CSP, so 'unsafe-inline' is what lets
  // that inline code run — a nonce would silently block the panel. No remote
  // origins are allowed; everything is inline and same-origin.
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
  <title>agentproto session story</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
    #story { border: 0; display: block; width: 100%; height: 100vh; }
  </style>
</head>
<body>
  <iframe id="story" title="session story" srcdoc="${escapeSrcdoc(storyHtml)}"></iframe>
  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      const frame = document.getElementById('story');
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
 * decodes them back, so the panel document is byte-identical to the imported
 * constant. `<`/`>` are valid inside an attribute value and left as-is —
 * escaping them would fork the panel's own markup.
 */
function escapeSrcdoc(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}
