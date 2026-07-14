/**
 * Placeholder Sessions tree view. WP1 replaces ONLY this file with the
 * real grouped/parented tree (badges, cost, model). This stub returns an
 * empty tree so VS Code doesn't error on activation, and refreshes the
 * view title count when the store changes.
 */

import * as vscode from "vscode"

import type { SessionStore } from "../services/sessionStore.js"

export class SessionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
    // WP1 will group sessions here. For now, a single informational line
    // when there are zero sessions so the view isn't a confusing blank.
    const count = this.store.sessions.length
    if (count === 0) {
      const item = new vscode.TreeItem("No sessions")
      item.tooltip = "No sessions on the daemon. Spawn one to get started."
      return [item]
    }
    const item = new vscode.TreeItem(`${count} session${count === 1 ? "" : "s"}`)
    item.tooltip = "WP1 will render the live session tree here."
    return [item]
  }
}

export function registerSessionsView(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
): void {
  const provider = new SessionsTreeProvider(store)
  const view = vscode.window.createTreeView("agentproto.sessions", {
    treeDataProvider: provider,
    showCollapseAll: false,
  })
  ctx.subscriptions.push(view)
}
