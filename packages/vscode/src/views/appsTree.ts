/**
 * Apps tree view — the daemon's installed-app registry (`app_list`),
 * grouped by `app_catalog` category, each app expanding to the agents and
 * workflows it bundles. Clicking an app that ships a UI opens its webview
 * panel (agentproto.openAppPanel); any other row opens the markdown
 * manifest it stands for, read-only (agentproto.openAppManifest). Pure
 * logic lives in appsTree.logic.ts; this file only wraps it into
 * vscode.TreeItem / ThemeIcon.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { AppCatalogEntry, InstalledAppInfo } from "../client/types.js"
import {
  appChildren,
  appContextValue,
  appDescription,
  appHasChildren,
  appLabel,
  appTooltip,
  categoryDescription,
  categoryLabel,
  EMPTY_APPS_LABEL,
  groupAppsByCategory,
  withCatalogCategories,
  type AppNode,
  type AppsTreeNode,
  type CategoryGroup,
} from "./appsTree.logic.js"

export type { AppNode, AppsTreeNode }

export class AppsTreeProvider implements vscode.TreeDataProvider<AppsTreeNode>, vscode.Disposable {
  private readonly client: DaemonClient
  private groups: CategoryGroup[] = []
  private readonly _onDidChange = new vscode.EventEmitter<AppsTreeNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(client: DaemonClient) {
    this.client = client
    void this.refresh()
  }

  dispose(): void {
    this._onDidChange.dispose()
  }

  async refresh(): Promise<void> {
    let apps: InstalledAppInfo[]
    try {
      apps = await this.client.listApps()
    } catch {
      apps = []
    }
    // The catalog only contributes categories. An older daemon without the
    // verb (or a transient failure) must not blank the tree — every app just
    // lands in the default group.
    let catalog: AppCatalogEntry[]
    try {
      catalog = await this.client.appCatalog()
    } catch {
      catalog = []
    }
    this.groups = groupAppsByCategory(withCatalogCategories(apps, catalog))
    this._onDidChange.fire(undefined)
  }

  getTreeItem(element: AppsTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "empty":
        return new vscode.TreeItem(EMPTY_APPS_LABEL)

      case "category": {
        const item = new vscode.TreeItem(
          categoryLabel(element.category),
          vscode.TreeItemCollapsibleState.Expanded,
        )
        item.id = `category:${element.category}`
        item.description = categoryDescription(element)
        item.iconPath = new vscode.ThemeIcon("folder")
        item.contextValue = "app-category"
        return item
      }

      case "app": {
        const app = element.app
        const item = new vscode.TreeItem(
          appLabel(app),
          appHasChildren(app)
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        )
        item.id = `app:${app.appId}`
        item.description = appDescription(app)
        item.tooltip = appTooltip(app)
        item.contextValue = appContextValue(app)
        item.iconPath = new vscode.ThemeIcon(app.ui ? "window" : "package")
        item.command = app.ui
          ? { command: "agentproto.openAppPanel", title: "Open App Panel", arguments: [element] }
          : { command: "agentproto.openAppManifest", title: "Open APP.md", arguments: [element] }
        return item
      }

      case "agent":
      case "workflow": {
        const isAgent = element.kind === "agent"
        const item = new vscode.TreeItem(element.ref.id, vscode.TreeItemCollapsibleState.None)
        item.id = `${element.kind}:${element.app.appId}:${element.ref.id}`
        item.tooltip = element.ref.path
        item.contextValue = isAgent ? "app-agent" : "app-workflow"
        item.iconPath = new vscode.ThemeIcon(isAgent ? "hubot" : "run-all")
        item.command = {
          command: "agentproto.openAppManifest",
          title: isAgent ? "Open AGENT.md" : "Open WORKFLOW.md",
          arguments: [element],
        }
        return item
      }
    }
  }

  getChildren(element?: AppsTreeNode): AppsTreeNode[] {
    if (!element) {
      if (this.groups.length === 0) return [{ kind: "empty" }]
      return this.groups.map(group => ({ kind: "category", category: group.category, apps: group.apps }))
    }
    switch (element.kind) {
      case "category":
        return element.apps.map(app => ({ kind: "app", app }))
      case "app":
        return appChildren(element.app)
      default:
        return []
    }
  }
}

export function registerAppsView(ctx: vscode.ExtensionContext, client: DaemonClient): AppsTreeProvider {
  const provider = new AppsTreeProvider(client)
  const view = vscode.window.createTreeView("agentproto.apps", {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  ctx.subscriptions.push(view, provider)
  return provider
}
