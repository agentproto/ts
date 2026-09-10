/**
 * VS Code wiring for the Session Chat app routing — the impure half of
 * sessionView.logic.ts. Owns the browser-opener ladder (Simple Browser →
 * env.openExternal, same as apps.ts openAppInBrowser) used for every
 * chat-route open.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import { getConfig } from "../config.js"
import { chatUrl, installedSessionChatApp, resolveSessionOpen } from "./sessionView.logic.js"

/** Read the per-open setting — deliberately NOT part of getConfig()/
 *  RELOAD_REQUIRED_KEYS: switching it doesn't invalidate the daemon client. */
export function getSessionView(): "chat" | "builtin" {
  const v = vscode.workspace.getConfiguration("agentproto").get<string>("sessionView")
  return v === "builtin" ? "builtin" : "chat"
}

/** The Simple Browser → OS browser ladder (apps.ts openAppInBrowser's
 *  pattern): Simple Browser keeps the tab inside VS Code, env.openExternal is
 *  the fallback when the built-in extension isn't available. */
export async function openChatUrl(url: string, sessionId: string): Promise<void> {
  let opened = false
  try {
    await vscode.commands.executeCommand("simpleBrowser.api.open", url)
    opened = true
  } catch {
    opened = false
  }
  if (!opened) {
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url))
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Open session '${sessionId}' in the chat UI failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/**
 * The session-open funnel's chat decision. Resolves the route against the
 * daemon's installed apps and the `agentproto.sessionView` setting:
 * chat → open the deep-linked standalone UI, return "chat"; otherwise the
 * caller opens the builtin transcript panel (silent fallback).
 */
export async function openSessionViaChat(
  client: DaemonClient,
  session: Pick<SessionDescriptor, "id">,
): Promise<"chat" | "builtin"> {
  let apps: Awaited<ReturnType<DaemonClient["listApps"]>> = []
  try {
    apps = await client.listApps()
  } catch {
    apps = []
  }
  const route = resolveSessionOpen(apps, getSessionView(), getConfig().daemonUrl, session.id)
  if (route.kind === "chat") {
    await openChatUrl(route.url, session.id)
    return "chat"
  }
  return "builtin"
}

/**
 * `agentproto.openSessionInChat` — ALWAYS the chat UI, bypassing the
 * setting. When the app isn't installed, say so once and open the builtin
 * panel instead (an explicit command earns a message; automatic routing
 * stays silent — sessionView.logic.ts).
 */
export async function openSessionInChat(
  client: DaemonClient,
  session: SessionDescriptor,
  openBuiltin: () => void,
): Promise<void> {
  let apps: Awaited<ReturnType<DaemonClient["listApps"]>> = []
  let listed = true
  try {
    apps = await client.listApps()
  } catch {
    apps = []
    listed = false
  }
  if (!installedSessionChatApp(apps)) {
    void vscode.window.showInformationMessage(
      listed
        ? "Session Chat app is not installed on the daemon — opening the builtin transcript panel."
        : "Couldn't list installed apps — opening the builtin transcript panel.",
    )
    openBuiltin()
    return
  }
  await openChatUrl(chatUrl(getConfig().daemonUrl, session.id), session.id)
}