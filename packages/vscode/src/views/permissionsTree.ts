/**
 * Permissions inbox tree view — the cross-session ACP permission/question
 * queue (recon §HTTP routes GET /permissions, §SSE permission-request /
 * permission-resolved). Shows `store.permissions` (pending only, as the
 * store already drops resolved ones — see sessionStore.logic.ts's
 * applyPermissionsSnapshot / permission-resolved handling), badges the view
 * with the pending count, and toasts a warning notification the moment a
 * NEW permission appears (diffed against the previous refresh's id set —
 * see permissionsTree.logic.ts's diffNewPermissionIds) with Approve / Deny /
 * Show actions.
 *
 * Approve/Deny both here and in the toast go through the
 * agentproto.approvePermission / agentproto.denyPermission commands
 * (commands/permissions.ts) rather than calling the client directly, so
 * there's exactly one place that resolves a permission.
 */

import * as vscode from "vscode"

import {
  buildPermissionTooltip,
  diffNewPermissionIds,
  permissionDescription,
  permissionLabel,
  type EnrichedPermission,
} from "./permissionsTree.logic.js"
import type { SessionStore } from "../services/sessionStore.js"

class PermissionTreeItem extends vscode.TreeItem {
  readonly permissionId: string

  constructor(perm: EnrichedPermission, nowMs: number) {
    super(permissionLabel(perm), vscode.TreeItemCollapsibleState.None)
    this.permissionId = perm.id
    this.id = perm.id
    this.description = permissionDescription(perm, nowMs)
    this.tooltip = new vscode.MarkdownString(buildPermissionTooltip(perm, nowMs))
    this.contextValue = "permission-pending"
    this.iconPath = new vscode.ThemeIcon("shield")
  }
}

export class PermissionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly store: SessionStore
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(store: SessionStore) {
    this.store = store
    this.store.onDidChange(() => this._onDidChange.fire())
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): vscode.TreeItem[] {
    const perms = this.store.permissions as EnrichedPermission[]
    if (perms.length === 0) {
      const item = new vscode.TreeItem("No pending permissions")
      item.tooltip = "Nothing is waiting on a decision."
      return [item]
    }
    const now = Date.now()
    return perms.map(p => new PermissionTreeItem(p, now))
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

  const updateBadge = (): void => {
    const count = store.permissions.length
    view.badge =
      count > 0
        ? { value: count, tooltip: `${count} pending permission${count === 1 ? "" : "s"}` }
        : undefined
  }
  updateBadge()

  // Seed the known-id set from whatever's already pending at activation so
  // the first refresh doesn't toast for every pre-existing permission —
  // only ones that appear AFTER this point are "new".
  let knownIds = new Set(store.permissions.map(p => p.id))
  ctx.subscriptions.push(
    store.onDidChange(() => {
      updateBadge()
      const current = store.permissions as EnrichedPermission[]
      const newIds = diffNewPermissionIds(knownIds, current)
      knownIds = new Set(current.map(p => p.id))
      for (const id of newIds) {
        const perm = current.find(p => p.id === id)
        if (perm) void notifyNewPermission(perm)
      }
    }),
  )
}

async function notifyNewPermission(perm: EnrichedPermission): Promise<void> {
  const who = perm.sessionLabel?.trim() || perm.sessionTitle?.trim() || perm.sessionId
  const choice = await vscode.window.showWarningMessage(
    `Session ${who} requests: ${permissionLabel(perm)}`,
    "Approve",
    "Deny",
    "Show",
  )
  if (choice === "Approve") {
    await vscode.commands.executeCommand("agentproto.approvePermission", perm.id)
  } else if (choice === "Deny") {
    await vscode.commands.executeCommand("agentproto.denyPermission", perm.id)
  } else if (choice === "Show") {
    // VS Code auto-registers a `<viewId>.focus` command for every
    // contributed view; swallow the rejection if that ever changes.
    await vscode.commands.executeCommand("agentproto.permissions.focus").then(undefined, () => {})
  }
}
