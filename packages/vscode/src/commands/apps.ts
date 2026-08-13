/**
 * Commands for the Apps tree view.
 *
 * - refreshApps forces the tree to reload the daemon's installed apps.
 * - openAppPanel opens an app's UI in its webview panel; without a tree
 *   node (command palette) it offers a QuickPick of the apps that ship a UI.
 * - openAppInBrowser opens an app's UI in the standalone HTTP host (a real
 *   browser tab), where clicks and native keyboard shortcuts work — unlike
 *   the webview panel, which VS Code strips of editor shortcuts (Cmd+C/V/F…)
 *   and where the inner iframe needs a click to take focus.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import { getConfig } from "../config.js"
import type { InstalledAppInfo } from "../client/types.js"
import { appLabel, appsWithUi, type AppNode } from "../views/appsTree.logic.js"
import type { AppsTreeProvider } from "../views/appsTree.js"
import type { AppPanels } from "../webview/appPanel.js"
import { appStandaloneUrl } from "../webview/appPanel.logic.js"

export function registerAppCommands(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  appPanels: AppPanels,
  provider: AppsTreeProvider,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.refreshApps", () => {
      void provider.refresh()
    }),
    vscode.commands.registerCommand("agentproto.openAppPanel", (node?: AppNode) => {
      void openAppPanel(client, appPanels, node)
    }),
    vscode.commands.registerCommand("agentproto.openAppInBrowser", (node?: AppNode) => {
      void openAppInBrowser(client, node)
    }),
  )
}

async function openAppPanel(
  client: DaemonClient,
  appPanels: AppPanels,
  node?: AppNode,
): Promise<void> {
  if (node?.app?.ui) {
    appPanels.open(node.app)
    return
  }

  const app = await pickAppWithUi(client)
  if (app) appPanels.open(app)
}

/** Resolve an app with a UI panel, from a tree node or a QuickPick. */
async function pickAppWithUi(client: DaemonClient): Promise<InstalledAppInfo | undefined> {
  let apps: InstalledAppInfo[]
  try {
    apps = appsWithUi(await client.listApps())
  } catch (err) {
    void vscode.window.showErrorMessage(
      `List apps failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
  if (apps.length === 0) {
    void vscode.window.showInformationMessage("No installed apps with a UI.")
    return undefined
  }

  const pick = await vscode.window.showQuickPick(
    apps.map(app => ({
      label: appLabel(app),
      description: app.appId,
      app,
    })),
    { placeHolder: "Select an app to open" },
  )
  return pick?.app
}

/** Open an app's standalone HTTP UI in a real browser. Prefers VS Code's
 *  built-in Simple Browser (stays inside VS Code but is a genuine browser —
 *  clicks + native shortcuts work); falls back to the OS browser when the
 *  Simple Browser command isn't available. */
async function openAppInBrowser(client: DaemonClient, node?: AppNode): Promise<void> {
  let app = node?.app
  if (!app?.ui) app = await pickAppWithUi(client)
  if (!app) return

  const url = appStandaloneUrl(getConfig().daemonUrl, app.appId)

  // The built-in Simple Browser exposes `simpleBrowser.api.open`; it throws
  // "command not found" when the built-in extension is unavailable.
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
        `Open app '${app.appId}' in browser failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
