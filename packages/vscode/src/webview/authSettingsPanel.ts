/**
 * Auth Settings — thinned to a redirector. Its old always-on chip wall
 * (per-wallet model pills, curated-id chips, catalog counts) was the poster
 * child for the pre-wallet-model auth UI: three parallel surfaces (this
 * panel, the Auth Profiles tree/webview, the mind map) all showing slightly
 * different cuts of the same data.
 *
 * The end state is three surfaces with distinct jobs — the Auth & Model Map
 * (understand), the Wallets view (configure), the Harnesses view (reach) —
 * and this panel is no longer one of them. Every flow that was unique to it
 * (add wallet / local-login connect, per-model curation removal,
 * catalog-cross-referenced counts) moved into the Wallets view
 * (authProfilesWebviewPanel.ts), rendered as a single summary line with
 * curation editing behind an expand rather than an always-on wall.
 *
 * This file keeps `agentproto.openAuthSettings` and the `authProfilesTree`
 * toolbar gear button working — it just points at the two surfaces that
 * replaced it, rather than duplicating either.
 */

import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

type InboundMessage = { type: "openWallets" } | { type: "openMap" }

function isInboundMessage(value: unknown): value is InboundMessage {
  if (typeof value !== "object" || value === null) return false
  if (!("type" in value)) return false
  const type = (value as { type: unknown }).type
  return type === "openWallets" || type === "openMap"
}

/** Focus whichever Auth Profiles surface is actually configured — the tree
 *  or the Wallets webview — per `agentproto.authProfilesView`. Both are
 *  VS Code auto-registered `<viewId>.focus` commands; swallow the error if
 *  the view isn't currently contributed (e.g. mid-reload). */
async function openWallets(): Promise<void> {
  const mode = vscode.workspace.getConfiguration("agentproto").get<string>("authProfilesView", "tree")
  const viewId = mode === "webview" ? "agentproto.authProfilesWebview" : "agentproto.authProfiles"
  await vscode.commands.executeCommand(`${viewId}.focus`).then(undefined, () => {})
}

export function registerAuthSettingsPanel(ctx: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined

  function onMessage(msg: InboundMessage): void {
    switch (msg.type) {
      case "openWallets":
        void openWallets()
        return
      case "openMap":
        void vscode.commands.executeCommand("agentproto.openAuthModel")
        return
    }
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.openAuthSettings", () => {
      if (panel) {
        panel.reveal(vscode.ViewColumn.Active)
        return
      }
      panel = vscode.window.createWebviewPanel(
        "agentproto.authSettings",
        "agentproto: Auth Settings",
        vscode.ViewColumn.Active,
        { enableScripts: true },
      )
      panel.onDidDispose(() => {
        panel = undefined
      }, undefined, ctx.subscriptions)
      panel.webview.onDidReceiveMessage(
        (raw: unknown) => {
          if (isInboundMessage(raw)) onMessage(raw)
        },
        undefined,
        ctx.subscriptions,
      )
      panel.webview.html = buildAuthSettingsRedirectorHtml(randomBytes(16).toString("hex"))
    }),
  )
}

/** The redirector page: what moved, and the two buttons that take you there.
 *  Exported for a jsdom test to drive the exact shipped markup + script. */
export function buildAuthSettingsRedirectorHtml(nonce: string): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join("; ")
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family); color: var(--vscode-foreground);
      display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;
    }
    .card { max-width: 420px; padding: 24px 28px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; text-align: center; }
    .card h1 { font-size: 14px; margin: 0 0 10px; }
    .card p { font-size: 12.5px; color: var(--vscode-descriptionForeground); line-height: 1.6; margin: 0 0 18px; }
    .actions { display: flex; gap: 10px; justify-content: center; }
    button {
      font-family: inherit; font-size: 12px; padding: 6px 14px; border-radius: 4px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
    button.secondary:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  </style>
</head>
<body>
  <div class="card">
    <h1>Wallets moved</h1>
    <p>Connecting a provider, curating models, and enabling or disabling a wallet now live in the <b>Wallets</b> view. Use the <b>Auth &amp; Model Map</b> to see how harnesses, the router, and your wallets fit together.</p>
    <div class="actions">
      <button id="wallets" data-action="openWallets">Open Wallets</button>
      <button id="map" class="secondary" data-action="openMap">Open Auth &amp; Model Map</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      vscode.postMessage({ type: el.getAttribute('data-action') });
    });
  </script>
</body>
</html>`
}
