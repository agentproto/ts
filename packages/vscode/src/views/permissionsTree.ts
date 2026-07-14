/**
 * Placeholder Permissions tree view. WP3 replaces ONLY this file with the
 * real held-permission inbox (approve/deny inline actions, toast on new
 * request). This stub returns an empty tree so VS Code doesn't error.
 */

import * as vscode from "vscode"

import type { SessionStore } from "../services/sessionStore.js"

export class PermissionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly store: SessionStore
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(store: SessionStore) {
    this.store = store
    this.store.onDidChange(() => this._onDidChange.fire())
  }

  getTreeItem(_element: vscode.TreeItem): vscode.TreeItem {
    return _element
  }

  getChildren(): vscode.TreeItem[] {
    const count = this.store.permissions.length
    if (count === 0) {
      const item = new vscode.TreeItem("No pending permissions")
      item.tooltip = "Nothing is waiting on a decision."
      return [item]
    }
    const item = new vscode.TreeItem(`${count} pending`)
    item.tooltip = "WP3 will render the permissions inbox here."
    return [item]
  }
}

export function registerPermissionsView(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
): void {
  const provider = new PermissionsTreeProvider(store)
  const view = vscode.window.createTreeView("agentproto.permissions", {
    treeDataProvider: provider,
    showCollapseAll: false,
  })
  ctx.subscriptions.push(view)
}
