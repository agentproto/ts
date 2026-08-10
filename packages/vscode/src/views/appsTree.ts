/**
 * Apps tree view — daemon-installed apps that ship a UI panel, from the
 * `app_list` MCP tool. Clicking a row opens its webview panel
 * (agentproto.openAppPanel). Pure logic lives in appsTree.logic.ts; this
 * file only wraps it into vscode.TreeItem / ThemeIcon.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { InstalledAppInfo } from "../client/types.js"
import { appDescription, appLabel, appsWithUi, type AppNode } from "./appsTree.logic.js"

export type { AppNode }

const EMPTY_APP_ID = "__no_apps__"

export class AppsTreeProvider implements vscode.TreeDataProvider<AppNode>, vscode.Disposable {
  private readonly client: DaemonClient
  private apps: InstalledAppInfo[] = []
  private readonly _onDidChange = new vscode.EventEmitter<AppNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(client: DaemonClient) {
    this.client = client
    void this.refresh()
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  async refresh(): Promise<void> {
    try {
      this.apps = appsWithUi(await this.client.listApps())
    } catch {
      this.apps = []
    }
    this._onDidChange.fire(undefined)
  }

  getTreeItem(element: AppNode): vscode.TreeItem {
    if (element.app.appId === EMPTY_APP_ID) {
      return new vscode.TreeItem("No apps with a UI installed")
    }

    const item = new vscode.TreeItem(appLabel(element.app))
    item.description = appDescription(element.app)
    item.tooltip = element.app.appId
    item.contextValue = "app"
    item.iconPath = new vscode.ThemeIcon("window")
    item.command = {
      command: "agentproto.openAppPanel",
      title: "Open App Panel",
      arguments: [element],
    }
    return item
  }

  getChildren(element?: AppNode): AppNode[] {
    if (element) return []
    if (this.apps.length === 0) {
      return [{ app: { appId: EMPTY_APP_ID } }]
    }
    return this.apps.map(app => ({ app }))
  }
}

export function registerAppsView(ctx: vscode.ExtensionContext, client: DaemonClient): AppsTreeProvider {
  const provider = new AppsTreeProvider(client)
  const view = vscode.window.createTreeView("agentproto.apps", {
    treeDataProvider: provider,
    showCollapseAll: false,
  })
  ctx.subscriptions.push(view, provider)
  return provider
}
