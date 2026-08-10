/**
 * Commands for the Apps tree view.
 *
 * - refreshApps forces the tree to reload the daemon's installed apps.
 * - openAppPanel opens an app's UI in its webview panel; without a tree
 *   node (command palette) it offers a QuickPick of the apps that ship a UI.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { InstalledAppInfo } from "../client/types.js"
import { appLabel, appsWithUi, type AppNode } from "../views/appsTree.logic.js"
import type { AppsTreeProvider } from "../views/appsTree.js"
import type { AppPanels } from "../webview/appPanel.js"

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

  let apps: InstalledAppInfo[]
  try {
    apps = appsWithUi(await client.listApps())
  } catch (err) {
    void vscode.window.showErrorMessage(
      `List apps failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }
  if (apps.length === 0) {
    void vscode.window.showInformationMessage("No installed apps with a UI.")
    return
  }

  const pick = await vscode.window.showQuickPick(
    apps.map(app => ({
      label: appLabel(app),
      description: app.appId,
      app,
    })),
    { placeHolder: "Select an app to open" },
  )
  if (pick) appPanels.open(pick.app)
}
