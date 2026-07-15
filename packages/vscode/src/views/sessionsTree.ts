/**
 * Sessions tree view (WP1). TreeDataProvider on view id `agentproto.sessions`.
 * Sessions are filtered (SessionFilterController's SessionFilterState), listed
 * FLAT at the top level split by recency across a divider row (last 24h above,
 * older below), and nested by parentSessionId into orchestrator subtrees. All
 * mapping/sorting/filtering rules live in sessionsTree.logic.ts and
 * sessionFilter.logic.ts (no vscode import there) so they're
 * unit-testable; this file only wraps that data into
 * vscode.TreeItem/ThemeIcon/MarkdownString and drives the view's
 * badge/description.
 *
 * Recency is a divider, not an accordion: the old LAST 7 DAYS / OLDER group
 * nodes made every session cost an extra expand and let a collapsed group hide
 * live sessions outright. The separator row carries the same information as a
 * single rule and can't hide anything.
 *
 * A single click opens the transcript: every session TreeItem sets
 * `command` to agentproto.openTranscript with the tree node as its arg —
 * normalizeSessionArg (sessionActions.logic.ts) already unwraps a node
 * shaped `{ session }`, so passing the node through works unchanged. The
 * separator row never gets a command (nothing to open).
 */

import * as vscode from "vscode"

import type { SessionFilterController } from "../commands/sessionFilter.js"
import { workspaceLabelFor } from "../services/workspaces.logic.js"
import type { SessionDescriptor } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import { filterSessions, filterSummary, isFilterActive } from "./sessionFilter.logic.js"
import {
  buildSessionRows,
  contextValueFor,
  descriptionFor,
  iconFor,
  labelFor,
  tooltipFieldsFor,
  type SeparatorNode,
  type SessionNode,
  type TreeNode,
} from "./sessionsTree.logic.js"

function isSeparatorNode(node: TreeNode): node is SeparatorNode {
  return "kind" in node && node.kind === "separator"
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly store: SessionStore
  private readonly filter: SessionFilterController
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private nodes: TreeNode[] = []
  private now = Date.now()
  private _hiddenCount = 0

  constructor(store: SessionStore, filter: SessionFilterController) {
    this.store = store
    this.filter = filter
    this.rebuild()
    this.store.onDidChange(() => this.rebuild())
    this.filter.onDidChange(() => this.rebuild())
  }

  /** Sessions present in the store but excluded by the current filter. */
  get hiddenCount(): number {
    return this._hiddenCount
  }

  private rebuild(): void {
    this.now = Date.now()
    const all = this.store.sessions
    // Filter first, then lay out the survivors: recency is a top-level
    // presentation split, not a filter dimension, so the divider is decided
    // from what's actually shown.
    const survivors = filterSessions(all, this.filter.state, this.filter.workspaces)
    this._hiddenCount = all.length - survivors.length
    this.nodes = buildSessionRows(survivors, this.now)
    this._onDidChange.fire()
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (isSeparatorNode(element)) {
      const item = new vscode.TreeItem("", vscode.TreeItemCollapsibleState.None)
      // The rule goes in `description`, not `label`: description renders in
      // descriptionForeground (dim), which is what makes the row read as a
      // divider instead of as another session.
      item.description = element.label
      item.id = element.id
      // Deliberately NOT prefixed "session-": every view/item/context menu
      // entry in package.json gates on `viewItem =~ /^session-/`, and the
      // divider must never pick up per-session inline actions (open
      // transcript / prompt / interrupt / kill).
      item.contextValue = "separator"
      // No `command`: clicking a divider does nothing.
      return item
    }

    const session = element.session
    const collapsibleState =
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    const item = new vscode.TreeItem(labelFor(session), collapsibleState)
    item.id = session.id
    item.description = descriptionFor(session, {
      workspaceLabel: workspaceLabelFor(this.filter.workspaces, session),
      now: this.now,
    })
    item.contextValue = contextValueFor(session)
    item.tooltip = buildTooltip(session)
    item.iconPath = toThemeIcon(iconFor(session))
    // Single click opens the transcript — the inline $(open-preview) icon
    // (view/item/context menu, wired in package.json) remains as a second
    // way to trigger the same command.
    item.command = {
      command: "agentproto.openTranscript",
      title: "Open Transcript",
      arguments: [element],
    }
    return item
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) return this.nodes
    if (isSeparatorNode(element)) return []
    return element.children
  }

  getParent(element: TreeNode): TreeNode | undefined {
    if (isSeparatorNode(element)) return undefined
    const parentId = element.session.parentSessionId
    if (parentId) {
      const parent = findNode(this.nodes, parentId)
      if (parent) return parent
    }
    // No parentSessionId (or it's dangling) — element is a top-level row.
    return undefined
  }
}

function findNode(nodes: readonly TreeNode[], id: string): SessionNode | undefined {
  for (const node of nodes) {
    if (isSeparatorNode(node)) continue
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
  filter: SessionFilterController,
): void {
  const provider = new SessionsTreeProvider(store, filter)
  const view = vscode.window.createTreeView("agentproto.sessions", {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  ctx.subscriptions.push(view)

  // The tree must never lie about hiding things: badge the count of
  // sessions the current filter excludes, and summarize the filter in the
  // view description. Both clear the moment the filter goes inactive.
  const updateViewMeta = (): void => {
    const active = isFilterActive(filter.state)
    view.badge =
      active && provider.hiddenCount > 0
        ? {
            value: provider.hiddenCount,
            tooltip: `${provider.hiddenCount} session${provider.hiddenCount === 1 ? "" : "s"} hidden by filter`,
          }
        : undefined
    view.description = active ? filterSummary(filter.state) : undefined
  }
  updateViewMeta()
  ctx.subscriptions.push(provider.onDidChangeTreeData(updateViewMeta))
}
