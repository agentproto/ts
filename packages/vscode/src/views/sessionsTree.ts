/**
 * Sessions tree view (WP1). TreeDataProvider on view id `agentproto.sessions`.
 * Roots are sessions without a parentSessionId; orchestrator subtrees are
 * nested by parentSessionId. All mapping/sorting rules live in
 * sessionsTree.logic.ts (no vscode import there) so they're unit-testable;
 * this file only wraps that data into vscode.TreeItem/ThemeIcon/MarkdownString.
 */

import * as vscode from "vscode"

import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import {
  buildSessionTree,
  contextValueFor,
  descriptionFor,
  iconFor,
  labelFor,
  tooltipFieldsFor,
  type SessionNode,
} from "./sessionsTree.logic.js"

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionNode> {
  private readonly store: SessionStore
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private roots: SessionNode[] = []

  constructor(store: SessionStore) {
    this.store = store
    this.rebuild()
    this.store.onDidChange(() => this.rebuild())
  }

  private rebuild(): void {
    this.roots = buildSessionTree(this.store.sessions)
    this._onDidChange.fire()
  }

  getTreeItem(element: SessionNode): vscode.TreeItem {
    const session = element.session
    const collapsibleState =
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    const item = new vscode.TreeItem(labelFor(session), collapsibleState)
    item.id = session.id
    item.description = descriptionFor(session)
    item.contextValue = contextValueFor(session)
    item.tooltip = buildTooltip(session)
    item.iconPath = toThemeIcon(iconFor(session))
    return item
  }

  getChildren(element?: SessionNode): SessionNode[] {
    if (element) return element.children
    return this.roots
  }

  getParent(element: SessionNode): SessionNode | undefined {
    const parentId = element.session.parentSessionId
    if (!parentId) return undefined
    return findNode(this.roots, parentId)
  }
}

function findNode(nodes: SessionNode[], id: string): SessionNode | undefined {
  for (const node of nodes) {
    if (node.session.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return undefined
}

function toThemeIcon(icon: ReturnType<typeof iconFor>): vscode.ThemeIcon {
  if (!icon.color) return new vscode.ThemeIcon(icon.id)
  const themeColorId =
    icon.color === "error" ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"
  return new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(themeColorId))
}

function buildTooltip(session: SessionDescriptor): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**${labelFor(session)}**\n\n`)
  for (const field of tooltipFieldsFor(session)) {
    md.appendMarkdown(`- **${field.label}:** ${field.value}\n`)
  }
  return md
}

export function registerSessionsView(
  ctx: vscode.ExtensionContext,
  store: SessionStore,
): void {
  const provider = new SessionsTreeProvider(store)
  const view = vscode.window.createTreeView("agentproto.sessions", {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  ctx.subscriptions.push(view)
}
