/**
 * The "chat-panel" session view — a VS Code webview panel embedding an IFRAME
 * of the session-chat standalone URL (`chatUrl(daemonUrl, sessionId)` with
 * `&embed=1` so the app strips its sidebar when it supports the param).
 *
 * Unlike appPanel.ts there is NO McpApp bridge: session-chat talks REST/SSE
 * directly to the daemon, so the outer webview document is just a
 * full-viewport iframe (see chatPanel.logic.ts buildChatPanelHtml) with a CSP
 * whose `frame-src` is the daemon origin taken from config — never
 * hardcoded. Panels are pooled per session id and disposed like appPanels.
 */

import * as vscode from "vscode"

import { chatPanelUrl, daemonOrigin, buildChatPanelHtml } from "./chatPanel.logic.js"
import { getConfig } from "../config.js"

export interface ChatPanels {
  open(sessionId: string): void
}

export function registerChatPanels(ctx: vscode.ExtensionContext): ChatPanels {
  const panels = new Map<string, vscode.WebviewPanel>()

  return {
    open(sessionId: string): void {
      const existing = panels.get(sessionId)
      if (existing) {
        existing.reveal(vscode.ViewColumn.One, false)
        return
      }

      const daemonUrl = getConfig().daemonUrl
      const panel = vscode.window.createWebviewPanel(
        "agentproto.chatPanel",
        `Chat: ${sessionId}`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      )
      panels.set(sessionId, panel)

      panel.onDidDispose(() => {
        panels.delete(sessionId)
      })

      panel.webview.html = buildChatPanelHtml(chatPanelUrl(daemonUrl, sessionId), daemonOrigin(daemonUrl))
    },
  }
}
