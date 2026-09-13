/**
 * The "path 2" installed-app webview panel — an HTTP iframe pointed straight
 * at the daemon's standalone app host (`GET /apps/<appId>/ui`), for ANY
 * installed app that ships a `ui` block, not just session-chat.
 *
 * Unlike appPanel.ts (path 1: a self-contained html string relayed into a
 * `srcdoc` iframe via postMessage — the only option for BUILTIN panels,
 * which have no HTTP url) this outer document is a thin, script-free iframe
 * wrapper exactly like chatPanel.ts's — see chatPanel.logic.ts's {@link
 * buildIframePanelHtml} for why the two share one builder. The embedded app
 * talks REST directly to the daemon (its injected `window.McpApp` bridge is
 * a relative `fetch`, not postMessage), enforcing the SAME `ui.tools`
 * allowlist `app_tool_call` enforces for path 1 — routing an app here
 * neither grants nor removes tool access.
 *
 * Which path an app opens through is decided in commands/apps.logic.ts
 * (`resolveAppPanelRoute`, gated by the `agentproto.appPanelMode` setting);
 * this module only knows how to render path 2 once that decision is made.
 */

import * as vscode from "vscode"

import type { InstalledAppInfo } from "../client/types.js"
import { getConfig } from "../config.js"
import { appLabel } from "../views/appsTree.logic.js"
import { appStandaloneUrl } from "./appPanel.logic.js"
import { buildIframePanelHtml, daemonOrigin } from "./chatPanel.logic.js"

export interface AppIframePanels {
  open(app: InstalledAppInfo): void
}

export function registerAppIframePanels(ctx: vscode.ExtensionContext): AppIframePanels {
  const panels = new Map<string, vscode.WebviewPanel>()

  return {
    open(app: InstalledAppInfo): void {
      const existing = panels.get(app.appId)
      if (existing) {
        existing.reveal(vscode.ViewColumn.One, false)
        return
      }

      const daemonUrl = getConfig().daemonUrl
      const title = appLabel(app)
      const panel = vscode.window.createWebviewPanel(
        "agentproto.appIframePanel",
        title,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      )
      panels.set(app.appId, panel)

      panel.onDidDispose(() => {
        panels.delete(app.appId)
      })

      panel.webview.html = buildIframePanelHtml(
        appStandaloneUrl(daemonUrl, app.appId),
        daemonOrigin(daemonUrl),
        title,
      )
    },
  }
}
